import { execFile, spawn } from "node:child_process"
import { rename, unlink, writeFile } from "node:fs/promises"

const worktree = process.env.TUICR_WORKTREE
const resultFile = process.env.TUICR_RESULT_FILE
const heartbeatFile = process.env.TUICR_HEARTBEAT_FILE
const baseRef = process.env.TUICR_BASE_REF || "HEAD~1"
const scope = process.env.TUICR_SCOPE || "committed"

if (!worktree || !resultFile) {
  process.stderr.write("tuicr runner missing required environment\n")
  process.exit(1)
}

const heartbeatTimer = heartbeatFile
  ? setInterval(() => void writeFile(heartbeatFile, String(Date.now()), "utf8"), 2_000)
  : undefined
heartbeatTimer?.unref()

const writeResult = async (result) => {
  const tempFile = `${resultFile}.tmp`
  await writeFile(tempFile, JSON.stringify(result), "utf8")
  await rename(tempFile, resultFile)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (heartbeatFile) await unlink(heartbeatFile).catch(() => {})
}
if (heartbeatFile) await writeFile(heartbeatFile, String(Date.now()), "utf8")

const exec = (command, args) =>
  new Promise((resolve) => {
    execFile(process.env.TUICR_BIN || command, args, { cwd: worktree, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout)
    })
  })

const listSessions = async () => {
  const raw = await exec("tuicr", ["review", "list", "--repo", worktree])
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

const readComments = async (session) => {
  const raw = await exec("tuicr", ["review", "comments", "--repo", worktree, "--session", session])
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

const sessionsBefore = await listSessions()
const beforeIDs = new Set()
for (const item of sessionsBefore) {
  if (typeof item?.slug !== "string") continue
  for (const comment of await readComments(item.slug)) {
    if (typeof comment?.id === "string") beforeIDs.add(comment.id)
  }
}

const args =
  scope === "committed"
    ? ["-r", `${baseRef}...HEAD`]
    : scope === "latest"
      ? ["-r", "HEAD"]
      : scope === "selector"
        ? []
        : ["-w"]
let sessionSlug
let stderrBuffer = ""
const child = spawn(process.env.TUICR_BIN || "tuicr", args, { cwd: worktree, stdio: ["inherit", "inherit", "pipe"] })
let spawnError = false
child.once("error", (error) => {
  spawnError = true
  process.stderr.write(`${error.message}\n`)
})
child.stderr.on("data", (chunk) => {
  const text = chunk.toString()
  process.stderr.write(text)
  stderrBuffer += text
  const match = stderrBuffer.match(/tuicr-session:\s+(\S+)/)
  if (match) sessionSlug = match[1]
  if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096)
})

const exitCode = await new Promise((resolve) => child.once("close", resolve))
if (!sessionSlug) {
  const sessionsAfter = await listSessions()
  const beforeSlugs = new Set(sessionsBefore.map((item) => item?.slug).filter((slug) => typeof slug === "string"))
  const newActive = sessionsAfter.filter((item) => item?.active && !beforeSlugs.has(item.slug))
  if (newActive.length === 1) sessionSlug = newActive[0].slug
}

const comments = sessionSlug ? await readComments(sessionSlug) : []
const fresh = comments.filter((comment) => typeof comment?.id === "string" && !beforeIDs.has(comment.id))
const result = {
  ok: !spawnError && exitCode === 0,
  scope:
    scope === "committed"
      ? `${baseRef}...HEAD`
      : scope === "latest"
        ? "HEAD"
        : scope === "selector"
          ? "local-selector"
          : "working-tree",
  session: sessionSlug,
  comments: fresh,
  error: !spawnError && exitCode === 0 ? undefined : `tuicr exited with code ${exitCode}`,
}
await writeResult(result)
