import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = process.cwd()
const packagePath = resolve(root, "package.json")
const changelogPath = resolve(root, "CHANGELOG.md")

if (!existsSync(packagePath)) throw new Error("package.json is missing")
if (!existsSync(changelogPath)) throw new Error("CHANGELOG.md is required for every release")

const version = JSON.parse(readFileSync(packagePath, "utf8")).version
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json must contain a stable x.y.z version; found ${String(version)}`)
}

const changelog = readFileSync(changelogPath, "utf8")
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s|$).*$`, "m")
const match = heading.exec(changelog)

if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`)

const bodyStart = match.index + match[0].length
const next = /^##\s+/m.exec(changelog.slice(bodyStart))
const end = next ? bodyStart + next.index : changelog.length
const sectionBody = changelog.slice(bodyStart, end).trim()

if (!sectionBody) throw new Error(`CHANGELOG.md section for ${version} is empty`)

console.log(`CHANGELOG.md contains release notes for ${version}`)
