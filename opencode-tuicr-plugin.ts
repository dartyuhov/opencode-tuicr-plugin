import { randomUUID } from "node:crypto"
import { readFile, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import { execFile } from "node:child_process"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const HERDR_PLUGIN_ID = "opencode-tuicr"
const HERDR_ENTRYPOINT = "review"
const RESULT_PREFIX = "opencode-tuicr-"

type ReviewResult = {
  ok: boolean
  scope: string
  session?: string
  comments: Array<Record<string, unknown>>
  error?: string
}

type ReviewScope = "committed" | "working-tree" | "latest" | "selector"
type LaunchMode = "popup" | "split"

type HerdrResponse = {
  result?: unknown
  error?: { message?: string }
}

function currentSessionID(api: Parameters<TuiPlugin>[0]) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
}

function currentWorktree(api: Parameters<TuiPlugin>[0]) {
  return api.state.path.worktree || api.state.path.directory
}

function sendHerdrRequest(method: string, params: Record<string, unknown>) {
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (!socketPath) throw new Error("OpenCode is not running inside Herdr")

  return new Promise<HerdrResponse>((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ""
    let settled = false
    const finish = (error?: Error, response?: HerdrResponse) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(response ?? {})
    }

    socket.setTimeout(2_000, () => finish(new Error("Herdr socket request timed out")))
    socket.on("error", (error) => finish(error))
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split("\n")[0]
      if (!line) return
      try {
        finish(undefined, JSON.parse(line) as HerdrResponse)
      } catch {
        finish(new Error("Herdr returned invalid JSON"))
      }
    })
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: `opencode-tuicr:${Date.now()}:${randomUUID()}`,
          method,
          params,
        })}\n`,
      )
    })
  })
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Review cancelled"))
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error("Review cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function waitForResult(path: string, heartbeatPath: string, signal: AbortSignal) {
  const startedAt = Date.now()
  while (true) {
    try {
      const content = await readFile(path, "utf8")
      return JSON.parse(content) as ReviewResult
    } catch {
      try {
        const heartbeat = await stat(heartbeatPath)
        if (Date.now() - heartbeat.mtimeMs > 15_000) {
          throw new Error("tuicr runner stopped before writing review result")
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("runner stopped")) throw error
        if (Date.now() - startedAt > 15_000) throw new Error("tuicr runner did not start")
      }
      await wait(200, signal)
    }
  }
}

async function openReview(
  api: Parameters<TuiPlugin>[0],
  sessionID: string,
  baseRef: string,
  scope: ReviewScope,
  launchMode: LaunchMode,
) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    api.ui.toast({
      variant: "error",
      title: "tuicr unavailable",
      message: "OpenCode session must run inside Herdr.",
    })
    return
  }

  const worktree = currentWorktree(api)
  if (!(await hasScopeChanges(worktree, scope, baseRef))) {
    api.ui.toast({
      variant: "info",
      title: "Review skipped",
      message: "No changes in selected review scope.",
    })
    return
  }
  const resultPath = join(tmpdir(), `${RESULT_PREFIX}${randomUUID()}.json`)
  const heartbeatPath = `${resultPath}.heartbeat`
  let response: HerdrResponse
  try {
    response = await sendHerdrRequest("plugin.pane.open", {
      plugin_id: HERDR_PLUGIN_ID,
      entrypoint: HERDR_ENTRYPOINT,
      placement: launchMode,
      target_pane_id: launchMode === "split" ? process.env.HERDR_PANE_ID : undefined,
      workspace_id: launchMode === "split" ? process.env.HERDR_WORKSPACE_ID : undefined,
      direction: launchMode === "split" ? "right" : undefined,
      cwd: worktree,
      focus: true,
      env: {
        TUICR_WORKTREE: worktree,
        TUICR_SCOPE: scope,
        TUICR_BASE_REF: baseRef,
        TUICR_SESSION_ID: sessionID,
        TUICR_RESULT_FILE: resultPath,
        TUICR_HEARTBEAT_FILE: heartbeatPath,
      },
    })
  } catch (error) {
    api.ui.toast({ variant: "error", title: "tuicr failed", message: String(error) })
    return
  }

  if (response.error) {
    api.ui.toast({ variant: "error", title: "tuicr failed", message: response.error.message ?? "Herdr could not open review" })
    return
  }

  let result: ReviewResult
  try {
    result = await waitForResult(resultPath, heartbeatPath, api.lifecycle.signal)
  } catch (error) {
    api.ui.toast({ variant: "error", title: "tuicr failed", message: String(error) })
    return
  }

  try {
    await unlink(resultPath)
  } catch {
    // Runner may retain result for manual recovery.
  }

  const activeSessionID = currentSessionID(api)
  if (activeSessionID !== sessionID) {
    const backupPath = join(tmpdir(), `${RESULT_PREFIX}backup-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(result, null, 2), "utf8")
    api.ui.toast({
      variant: "warning",
      title: "tuicr feedback not sent",
      message: `Session changed. Backup: ${backupPath}. Read with tuicr review comments --repo ${worktree} --session ${result.session ?? "<session>"}`,
      duration: 10_000,
    })
    return
  }

  if (!result.ok || result.comments.length === 0) {
    api.ui.toast({
      variant: result.ok ? "info" : "error",
      title: result.ok ? "Review complete" : "tuicr failed",
      message: result.ok ? "No new review comments." : result.error ?? "Review failed",
    })
    return
  }

  const payload = {
    source: "tuicr",
    scope: result.scope,
    worktree,
    comments: result.comments,
  }
  const prompt = [
    "Review feedback from tuicr. Address these comments in current session. Do not commit or merge unless explicitly requested.",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")

  try {
    await api.client.tui.appendPrompt({ text: prompt }, { throwOnError: true })
    await api.client.tui.submitPrompt({}, { throwOnError: true })
  } catch {
    const backupPath = join(tmpdir(), `${RESULT_PREFIX}handoff-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(payload, null, 2), "utf8")
    api.ui.toast({
      variant: "error",
      title: "tuicr feedback not sent",
      message: `OpenCode prompt handoff failed. Backup: ${backupPath}`,
      duration: 10_000,
    })
  }
}

function runGit(worktree: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile("git", args, { cwd: worktree }, (error, stdout) => {
      resolve({ code: error?.code && typeof error.code === "number" ? error.code : error ? 1 : 0, stdout })
    })
  })
}

async function hasScopeChanges(worktree: string, scope: ReviewScope, baseRef: string) {
  if (scope === "selector") return true
  if (scope === "committed") {
    const result = await runGit(worktree, ["diff", "--quiet", `${baseRef}...HEAD`, "--"])
    if (result.code !== 0 && result.code !== 1) throw new Error(`Cannot inspect committed scope against ${baseRef}`)
    return result.code === 1
  }
  if (scope === "latest") {
    const parent = await runGit(worktree, ["rev-parse", "--verify", "HEAD^"])
    const base = parent.code === 0 ? parent.stdout.trim() : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    const result = await runGit(worktree, ["diff", "--quiet", base, "HEAD", "--"])
    if (result.code !== 0 && result.code !== 1) throw new Error("Cannot inspect latest commit")
    return result.code === 1
  }
  const result = await runGit(worktree, ["status", "--porcelain", "--untracked-files=normal"])
  if (result.code !== 0) throw new Error("Cannot inspect working tree")
  return result.stdout.trim().length > 0
}

async function detectDefaultBase(worktree: string) {
  const run = (args: string[]) =>
    new Promise<string>((resolve) => {
      execFile("git", args, { cwd: worktree }, (error, stdout) => resolve(error ? "" : stdout.trim()))
    })

  const remoteHead = await run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  if (remoteHead) return remoteHead
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await run(["rev-parse", "--verify", candidate])) return candidate
  }
  return ""
}

async function detectBranches(worktree: string) {
  const result = await runGit(worktree, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
  return result.stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch && !branch.endsWith("/HEAD"))
}

function showBasePicker(
  api: Parameters<TuiPlugin>[0],
  sessionID: string,
  launchMode: LaunchMode,
  branches: string[],
) {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Choose base branch",
      options: branches.map((branch) => ({
        title: branch,
        value: branch,
        description: "Review current branch changes since this branch forked",
      })),
      onSelect: async (option) => {
        api.ui.dialog.clear()
        await openReview(api, sessionID, String(option.value), "committed", launchMode)
      },
    }),
  )
}

function showReviewChooser(api: Parameters<TuiPlugin>[0], sessionID: string, launchMode: LaunchMode, baseRef: string) {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Open tuicr review${launchMode === "split" ? " in pane" : ""}`,
      current: "committed",
      options: [
        {
          title: `Committed branch changes (${baseRef})`,
          value: "committed",
          description: "Review current branch changes since base branch fork",
        },
        {
          title: "Choose another base branch",
          value: "base-picker",
          description: "Select local or remote branch",
        },
        {
          title: "Working tree changes",
          value: "working-tree",
          description: "Review staged, unstaged, and untracked changes",
        },
        {
          title: "Latest commit",
          value: "latest",
          description: "Review current HEAD commit",
        },
        {
          title: "Local changes selector",
          value: "selector",
          description: "Choose staged or unstaged changes in tuicr",
        },
      ],
      onSelect: async (option) => {
        api.ui.dialog.clear()
        if (option.value === "base-picker") {
          showBasePicker(api, sessionID, launchMode, await detectBranches(currentWorktree(api)))
          return
        }
        await openReview(api, sessionID, baseRef, option.value as ReviewScope, launchMode)
      },
    }),
  )
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Open tuicr review",
      value: "tuicr.open",
      description: "Review current branch changes with tuicr",
      category: "Review",
      slash: { name: "tuicr" },
      onSelect: async () => {
        const sessionID = currentSessionID(api)
        if (!sessionID) {
          api.ui.toast({ variant: "error", title: "tuicr unavailable", message: "Open a session first." })
          return
        }

        const worktree = currentWorktree(api)
        const baseRef = await detectDefaultBase(worktree)
        if (!baseRef) {
          api.ui.toast({ variant: "warning", title: "No base branch", message: "Choose Latest commit or Local changes selector." })
          return
        }
        showReviewChooser(api, sessionID, "popup", baseRef)
      },
    },
    {
        title: "Open tuicr review in pane",
        value: "tuicr.open-pane",
        description: "Review current changes in a Herdr split pane",
        category: "Review",
        slash: { name: "tuicr-pane" },
      onSelect: async () => {
        const sessionID = currentSessionID(api)
        if (!sessionID) {
          api.ui.toast({ variant: "error", title: "tuicr unavailable", message: "Open a session first." })
          return
        }
        const baseRef = await detectDefaultBase(currentWorktree(api))
        if (!baseRef) {
          api.ui.toast({ variant: "warning", title: "No base branch", message: "Choose Latest commit or Local changes selector." })
          return
        }
        showReviewChooser(api, sessionID, "split", baseRef)
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-tuicr",
  tui,
}

export default plugin
