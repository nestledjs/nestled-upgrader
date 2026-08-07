# nestled-upgrader

Control-plane CLI for promoting `nestled-dev-template` into `nestled-template`, then upgrading downstream Nestled projects from `nestled-template`.

`nestled-template` is configured as a template-promotion target because it is the clean clone source for new projects. Promotions from `nestled-dev-template` should be validated there first, then normal upgrades can run across product projects.

The primary workflow is:

1. Discover sibling product projects and create their local upgrade history.
2. Run `promote-template` to mirror allowed product-surface changes from `nestled-dev-template` into `nestled-template`.
3. Generate downstream upgrade records and patches from `nestled-template` commit ranges.
4. Run `upgrade --all` to check every product project, apply clean patches, and produce agent handoff reports for adaptations.

## Usage

For the operational runbook, start with [docs/HOWTO.md](docs/HOWTO.md).

### Operational data boundary

This repository contains the reusable CLI, not an operator's project inventory or run history.
`upgrader.config.yaml`, `upgrader.state.yaml`, `upgrades`, `patches`, and `reports` are intentionally
gitignored. Keep them locally or in a private operational repository; the ignored paths may be
directories or symlinks to that private store. Start configuration from the fictional
`upgrader.config.example.yaml` checked in here.

#### Upgrading past the commit that untracked these paths

`upgrader.config.yaml` used to be tracked. The commit that removed it deletes your working copy on
`git pull`, and the CLI then stops with `Missing upgrader.config.yaml` — your configuration is not
corrupted, just gone from the working tree. Recover it before pulling, or afterwards from history:

```bash
git show THAT_COMMIT_SHA^:upgrader.config.yaml > upgrader.config.yaml
```

Then move it into your private store and symlink it back, so the next such change cannot take it
with it. The same applies to `upgrader.state.yaml`, `upgrades`, `patches`, and `reports` if you were
carrying them in the repo.

Never commit real client/project inventories, local paths, site or network assignments, or
client-specific reports to a public upgrader checkout. A private Git repository can back up those
artifacts, but credentials and secrets still belong in a secret manager rather than either repo.

Run commands from this repository:

```bash
node bin/nestled-upgrader.js status
node bin/nestled-upgrader.js discover
node bin/nestled-upgrader.js init
node bin/nestled-upgrader.js sync-template
node bin/nestled-upgrader.js promote-template --dry-run
node bin/nestled-upgrader.js promote-template
node bin/nestled-upgrader.js run
node bin/nestled-upgrader.js run --dry-run-only
node bin/nestled-upgrader.js create-upgrade --from <commit> --to <commit>
node bin/nestled-upgrader.js upgrade --all --dry-run
node bin/nestled-upgrader.js upgrade --all
node bin/nestled-upgrader.js plan --project <name> --upgrade <id>
node bin/nestled-upgrader.js apply --project <name> --upgrade <id> --dry-run
node bin/nestled-upgrader.js apply --project <name> --upgrade <id>
node bin/nestled-upgrader.js report --project <name>
```

`discover` scans sibling directories next to `nestled-upgrader`, adds likely Nestled product projects to `upgrader.config.yaml`, and initializes `.nestled/upgrade-log.yaml` in each downstream project. A sibling is discovered when it already has `.nestled/` or its `package.json` name/workspaces/dependencies reference Nestled. `init` only initializes or refreshes local history for downstream projects already in config; the template-promotion target is not a downstream upgrade ledger.

`sync-template` compares `upgrader.state.yaml` with the current `nestled-template` HEAD and creates a draft downstream upgrade record plus patch when the clone template has moved. If no state exists yet, it records the current clone template commit as the ground-zero baseline.

`promote-template` compares separate promotion state with `nestled-dev-template`, then mirrors allowed tracked files into `nestled-template` using template-promotion policy. Raw promotion excludes root package manifests, lockfiles, and package source directories such as `libs/data-browser/**` and `libs/shared-components/**`; package/library changes must be represented as `package-release` or `hybrid` notes so `nestled-template` consumes published packages instead of copying source.

`run` is the top-to-bottom agent entry point. It discovers projects, runs template promotion first, syncs `nestled-template`, writes dry-run reports for product projects, applies clean direct patches, and leaves agent handoff reports for blocked adaptations. On the first run, it establishes the current clone template commit as ground zero when no prior sync state exists.

Upgrade notes from `.nestled-updates/upgrade-notes/*.yaml` use the contract in `nestled-dev-template/.nestled-updates/UPGRADER-CONTRACT.md`. `delivery: code-patch` drives source adaptation, `delivery: package-release` drives dependency bumps without copying package source files, and `delivery: hybrid` does package-release first followed by source adaptation.

`upgrade --all --dry-run` writes reports without touching downstream logs or code. `upgrade --all` creates `nestled-upgrade/<upgrade-id>` branches, applies patches that fit cleanly, runs configured verification, records outcomes, commits successful direct patches with `--no-gpg-sign`, and marks patch failures as agent adaptation work instead of treating them as final failure.

Reports are written under `reports/`, with a cross-project rollup at `reports/upgrade-rollup.md`.

When the same non-library upgrade is applied or adapted across at least three projects with no pending, blocked, skipped, or not-applicable outcomes, the upgrader writes an advisory extraction signal under `reports/recommendations/`. These reports do not create packages or refactor code.

Agents launched in this directory should start with [AGENTS.md](AGENTS.md).

Template-side setup is specified in [docs/NESTLED_TEMPLATE_UPGRADER_INTEGRATION.md](docs/NESTLED_TEMPLATE_UPGRADER_INTEGRATION.md).

## Test

```bash
npm test
```
