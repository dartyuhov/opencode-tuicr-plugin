# OpenCode tuicr plugin

`opencode-tuicr-plugin` adds TUI commands for launching [tuicr][tuicr] code
reviews from [OpenCode][opencode] sessions running inside [Herdr][herdr].
Review results are sent back to the active OpenCode session as a prompt with
the new review comments.

This project is community-maintained and isn't affiliated with or endorsed by
OpenCode, tuicr, or Herdr.

## Requirements

You must have the following tools installed and available on your `PATH`:

- OpenCode with TUI plugin support.
- Herdr `0.9.0` or newer.
- The `tuicr` command-line tool.
- Node.js `20` or newer.

The OpenCode session must run inside Herdr because the plugin uses Herdr's local
socket API to open the review pane.

## Install

Install the OpenCode TUI plugin by adding it to `tui.json` in your project or
global OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-tuicr-plugin"]
}
```

OpenCode installs npm plugins automatically at startup. Pin the plugin to an
exact version when you want repeatable updates, for example
`opencode-tuicr-plugin@0.1.1`.

Install the companion Herdr pane plugin from GitHub:

```sh
herdr plugin install dartyuhov/opencode-tuicr-plugin/herdr
```

Restart OpenCode after changing `tui.json`. Enable the Herdr plugin if you
installed it with `--disabled` or disabled it previously.

## Usage

Open an OpenCode session inside Herdr and run one of these commands:

- `/tuicr` opens the review in a popup.
- `/tuicr-pane` opens the review in a Herdr split pane.

Choose one of the available review scopes:

- Committed changes from the detected base branch.
- Committed changes from another local or remote branch.
- Working-tree changes, including staged, unstaged, and untracked files.
- The latest commit.
- A local staged or unstaged changes selector inside tuicr.

When the review finishes, new comments are submitted to the same OpenCode
session. If the session changes or prompt submission fails, the plugin writes a
JSON backup in the system temporary directory and shows its path in a toast.

## Local development

Install dependencies and run the complete verification suite from the
repository root:

```sh
npm ci
npm run verify
```

To link the Herdr integration from a local checkout:

```sh
herdr plugin link "$PWD/herdr" --enabled
```

The package publishes compiled files. Its tarball intentionally excludes the
TypeScript source, tests, lockfiles, and CI configuration.

## Release

The `main` branch workflow runs verification and publishes a new npm version
after CI succeeds. Increment the `version` in `package.json` and the Herdr
manifest together before each release. Every npm version can be published only
once.

Add a non-empty matching section to the local `CHANGELOG.md` before running
`npm run verify`. The publish workflow and the post-publish GitHub Release both
use this committed local changelog; generated GitHub notes are not a substitute.

Releases use npm Trusted Publishing through GitHub Actions OIDC and include npm
provenance. Configure the npm trusted publisher for this repository and
`publish.yml` before publishing from a fork. The `GitHub Release` workflow then
creates tag `vVERSION` and a release titled `PACKAGE@VERSION` after publication.

Do not run `npm publish` locally.

## License

MIT

[herdr]: https://herdr.dev/
[opencode]: https://opencode.ai/
[tuicr]: https://github.com/agavra/tuicr
