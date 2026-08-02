# Nestled Upgrader HOWTO

This project promotes changes from `nestled-dev-template` into `nestled-template`, then upgrades product projects from `nestled-template`.

## Repositories

- `../nestled-dev-template`: development template and upgrade-note authoring source.
- `../nestled-template`: cloneable template used for new projects.
- configured product projects: upgrade targets listed in `upgrader.config.yaml`.

Do not treat `nestled-template` as a normal product project. It is promoted first with stricter filtering, then product projects are upgraded from it. `nestled-template` is not expected to carry product-style `applied`/`adapted`/`superseded`/`blocked` upgrade decisions; check its currency with `promote-template --dry-run`.

## Normal Agent Command

From this repository root, run:

```bash
node bin/nestled-upgrader.js run
```

This performs the full workflow:

1. Discover configured sibling projects, excluding repos listed under `discover.exclude`.
2. Promote pending `nestled-dev-template` upgrade notes into `nestled-template`.
3. Sync downstream upgrade records from the current `nestled-template` HEAD.
4. Plan and apply pending upgrades for product projects only.
5. Write reports under `reports/`.

To inspect without applying project patches:

```bash
node bin/nestled-upgrader.js run --dry-run-only
```

## Promotion Only

Use this when you want to validate the dev-template to clone-template step before touching product projects:

```bash
node bin/nestled-upgrader.js promote-template --dry-run
node bin/nestled-upgrader.js promote-template
```

Promotion reads from `promotion.source` in `upgrader.config.yaml`, currently `../nestled-dev-template`, and writes to the project with `role: template-promotion`, currently `../nestled-template`.

Promotion is an **import-aware file mirror**, not a patch apply, so it never blocks on conflicts. It copies every tracked source file from `nestled-dev-template` into `nestled-template` except:

- imported-vs-embedded wiring: `package.json`, lockfiles, `nx.json`, `tsconfig.base.json`, `libs/data-browser/**`, `libs/shared-components/**`
- template-owned docs/identity: `README.md`, `CLAUDE.md`, `WARP.md`, `AGENTS.md`, `sonar-project.properties`, `docs/template/**`, `docs/dev/**`
- dev-authoring tooling the cloneable template never carries: `.cursor/**`, `.agents/**`, `.opencode/**`, `ai-docs/**`, `plans/**`, `tools/ai-migrations/**`, …

On the way in it rewrites the two per-clone seams: `@nestled-template/data-browser` → the `@nestledjs/data-browser` package, and the Compose project `name:` → `nestled-template`. Extend the exclude/substitution sets under `promotion.mirror` in `upgrader.config.yaml`.

The mirror is **additive** — it never deletes. Files that exist only in `nestled-template` are preserved and listed under "Template-only files" in the report. Package versions still flow through `packageReleases` dependency bumps, handled separately, not copied source.

Because promotion mirrors dev-template's committed state, any fix must originate in `nestled-dev-template` and flow down — do not patch `nestled-template` directly, or the next promotion will revert it.

### Committing a promotion

**Promotion never commits.** It writes to the `nestled-template` working tree, writes `reports/promotion-mirror.md`, and stops. Committing is a review step, not a tool step:

```bash
cd ../nestled-template
git switch -c chore/promote-<topic>       # never commit straight onto develop
git add -A && git commit                  # write the message yourself
gh pr create --base develop
```

Write the message from the report, not from the package bumps. A single promotion routinely carries product files, new upgrade notes, and dependency bumps at once, and the interesting part is usually in the notes — e.g. "go straight to forms 0.8.2, skip 0.8.1" is a fact you can only get by reading them.

This used to be automatic and it went wrong in a way worth remembering: the package-version step ran `git add -A` and committed the entire tree — mirror, notes, and any unrelated work in progress — under a generated message naming only the bumped packages, straight onto whichever branch was checked out. The commit claimed to be a version bump while carrying 26 files. Nothing verified it, because it happened before anyone read the report.

Promotion also refuses to run against a dirty template. `--allow-dirty` is safe when your only local edits are ones the mirror excludes anyway (`package.json`, lockfiles); otherwise commit or stash first.

After a promotion is merged, re-running promotion should report no changes. If it doesn't, something was patched directly in `nestled-template`.

## Downstream Only

Use this after `nestled-template` has been promoted and committed:

```bash
node bin/nestled-upgrader.js sync-template
node bin/nestled-upgrader.js upgrade --all --dry-run
node bin/nestled-upgrader.js upgrade --all
```

Downstream sync reads from `template.path` in `upgrader.config.yaml`, currently `../nestled-template`.

Product projects do not receive promotion-only records from `nestled-dev-template`.

## Reading Results

Start with:

```bash
node bin/nestled-upgrader.js status
```

`status` reports downstream product projects. It labels the `template-promotion` target separately so a stale or historical template ledger cannot look like product upgrade backlog.

Then read:

- `reports/upgrade-rollup.md`
- `reports/<project>/<upgrade-id>.md`
- `upgrades/<upgrade-id>.yaml`
- `<project>/.nestled/upgrade-log.yaml`

## Upgrade Log Formatting

Downstream `.nestled/upgrade-log.yaml` files are machine-owned ledgers. The upgrader
canonicalizes them with its own YAML writer: plain scalars when safe, double quotes
when YAML requires quoting. To avoid quote-only churn appearing inside unrelated
product upgrade PRs, check formatting before starting a round:

```bash
node bin/nestled-upgrader.js format-logs --check
```

To normalize configured downstream product ledgers:

```bash
node bin/nestled-upgrader.js format-logs
```

The command skips the `template-promotion` project because `nestled-template` is not
a downstream upgrade ledger.

Common outcomes:

- `applied`: patch/package update applied and verification passed.
- `superseded`: project already satisfied the intent.
- `not-applicable`: project does not contain the relevant surface.
- `blocked`: direct automation stopped; an agent or human must inspect and adapt.
- `pending-release`: package release metadata is incomplete or unavailable.

## Handling Blocked Items

For each blocked report:

1. Open `reports/<project>/<upgrade-id>.md`.
2. Open `upgrades/<upgrade-id>.yaml`.
3. Move into the project folder from `upgrader.config.yaml`.
4. Use or create branch `nestled-upgrade/<upgrade-id>`.
5. Implement the upgrade intent conservatively.
6. Run verification from the project config and upgrade record.
7. Update the downstream project's `.nestled/upgrade-log.yaml`.
8. Commit the result in the downstream repo.

Always key log entries by the exact `id` in `upgrades/<upgrade-id>.yaml`. The
catalog may declare `legacyIds` to reconcile historical aliases from older
manual runs, but new entries should never invent a date/slug. `status` warns
only for ids that match neither a canonical catalog id nor a declared legacy id.

Patch failure is not final failure. Treat it as an instruction to adapt the upgrade intent to the local code.

## Upgrade Note Delivery Rules

- `code-patch`: apply or adapt behavior described by `intent`.
- `package-release`: bump package versions and lockfiles; do not copy package source.
- `hybrid`: apply package-release first, then code-patch behavior.

For `package-release`, every package release must include `targetVersion` or `versionRange`. If neither is present, the upgrader blocks as `pending-release`.

## First Run Expectations

If there is no previous state, the upgrader records the current source commit as baseline and may report no upgrades. That is expected.

State is split:

- `upgrader.state.yaml.template`: downstream source state for `nestled-template`.
- `upgrader.state.yaml.promotion`: promotion source state for `nestled-dev-template`.

Do not manually merge these state sections.
