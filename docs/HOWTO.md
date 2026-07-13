# Nestled Upgrader HOWTO

This project promotes changes from `nestled-dev-template` into `nestled-template`, then upgrades product projects from `nestled-template`.

## Repositories

- `../nestled-dev-template`: development template and upgrade-note authoring source.
- `../nestled-template`: cloneable template used for new projects.
- configured product projects: upgrade targets listed in `upgrader.config.yaml`.

Do not treat `nestled-template` as a normal product project. It is promoted first with stricter filtering, then product projects are upgraded from it.

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

The mirror is **additive** — it never deletes. Files that exist only in `nestled-template` (its own upgrade log, template-only notes) are preserved and listed under "Template-only files" in the report. Package versions still flow through `packageReleases` dependency bumps, handled separately, not copied source.

Because promotion mirrors dev-template's committed state, any fix must originate in `nestled-dev-template` and flow down — do not patch `nestled-template` directly, or the next promotion will revert it. Review `reports/promotion-mirror.md`, then commit the mirrored working-tree changes in `nestled-template` (product code is not auto-committed).

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

Then read:

- `reports/upgrade-rollup.md`
- `reports/<project>/<upgrade-id>.md`
- `upgrades/<upgrade-id>.yaml`
- `<project>/.nestled/upgrade-log.yaml`

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
7. Update `.nestled/upgrade-log.yaml`.
8. Commit the result in the downstream repo.

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
