import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("compiled package exposes the TUI plugin", async () => {
  const packageModule = await import("../dist/opencode-tuicr-plugin.js")

  assert.equal(packageModule.default.id, "opencode-tuicr")
  assert.equal(typeof packageModule.default.tui, "function")
})

test("Herdr manifest uses a portable runner command", async () => {
  const manifest = await readFile(new URL("../herdr/herdr-plugin.toml", import.meta.url), "utf8")

  assert.match(manifest, /command = \["node", "runner\.mjs"\]/)
  assert.doesNotMatch(manifest, /\/Users\/|\/home\//)
})
