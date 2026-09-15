# Release instructions

This repository is an npm package with a companion Herdr plugin.

## npm releases

- Use the `npm-github-release` skill for every version bump, npm publication,
  release automation change, GitHub Release, or release-status check.
- Read this file before changing release files.
- Keep `package.json`, `package-lock.json`, `CHANGELOG.md`, and
  `herdr/herdr-plugin.toml` consistent for every release.
- Add a non-empty local `CHANGELOG.md` section for the new package version
  before verification, commit, or push.
- Run `npm run verify` before committing release changes.
- Publish through the checked-in GitHub Actions workflow and npm Trusted
  Publishing. Do not publish from a local machine.
- Do not commit or push a release unless the user explicitly requests it.
