import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = process.cwd()
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
)[0]
const files = new Set(pack.files.map((file) => file.path))

const required = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/opencode-tuicr-plugin.js",
  "dist/opencode-tuicr-plugin.d.ts",
  "herdr/herdr-plugin.toml",
  "herdr/runner.mjs",
]
const excluded = [
  "opencode-tuicr-plugin.ts",
  "tsconfig.json",
  "bun.lock",
  "test/",
  "scripts/",
  ".github/",
]

for (const file of required) {
  if (!files.has(file)) throw new Error(`tarball is missing ${file}`)
}
for (const file of excluded) {
  if ([...files].some((packed) => packed === file || packed.startsWith(file))) {
    throw new Error(`tarball unexpectedly contains ${file}`)
  }
}

const herdrManifest = readFileSync(resolve(root, "herdr/herdr-plugin.toml"), "utf8")
const herdrVersion = herdrManifest.match(/^version = "([^"]+)"$/m)?.[1]
if (herdrVersion !== manifest.version) {
  throw new Error(`Herdr version ${herdrVersion ?? "<missing>"} does not match npm version ${manifest.version}`)
}
if (herdrManifest.includes("/Users/") || herdrManifest.includes("/home/")) {
  throw new Error("Herdr manifest contains a machine-specific absolute path")
}

console.log(`pack check passed: ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked`)
