# Nestled Upgrader Agent Entry Point

When launched in this folder, your job is to promote `nestled-dev-template` into `nestled-template`, then upgrade configured Nestled downstream projects from `nestled-template`.

Read [docs/HOWTO.md](docs/HOWTO.md) first for the operational sequence, expected outcomes, and blocked-item handling.

`nestled-template` is the canonical clone source for new projects and is configured as a template-promotion target. Promote `nestled-dev-template` into it first, then upgrade product projects from the promoted template state.

To inspect or run template promotion by itself:

```bash
node bin/nestled-upgrader.js promote-template
```

Template promotion is an **import-aware file mirror**, not a patch apply: it copies `nestled-dev-template`'s product surface into `nestled-template` and never blocks on conflicts. It excludes the imported-vs-embedded wiring (`package.json`, lockfiles, `nx.json`, `tsconfig.base.json`, `libs/data-browser/**`, `libs/shared-components/**`), template-owned docs/identity (`README.md`, `CLAUDE.md`, `WARP.md`, `AGENTS.md`, sonar, `docs/template/**`, `docs/dev/**`), and dev-authoring tooling (`.cursor/**`, `.agents/**`, `ai-docs/**`, `plans/**`, `tools/ai-migrations/**`, …). It substitutes the two seams that differ per clone: the `@nestled-template/data-browser` import becomes the `@nestledjs/data-browser` package, and the Compose project `name:` becomes `nestled-template`. Package versions still flow through `packageReleases` dependency bumps (handled separately), not copied source. The mirror is additive — it never deletes; template-only files are reported, not removed. Promotion never commits — it writes to the `nestled-template` working tree and reports. Review `reports/promotion-mirror.md`, then commit on a branch and open a PR. Write the message yourself: describe the mirrored change, not just the package bumps, since one promotion routinely carries product files, upgrade notes, and dependency bumps together. Promotion also refuses to run against a dirty template; `--allow-dirty` is for when your only local edits are ones the mirror excludes anyway (`package.json`, lockfiles). Because it mirrors dev-template's committed state, fixes must originate in `nestled-dev-template` and flow down — never patch `nestled-template` directly.

Run this workflow from the repository root:

```bash
node bin/nestled-upgrader.js run
```

`run` performs promotion first, then downstream sync and upgrades. On the very first downstream run, this establishes today as the `nestled-template` baseline if no previous sync state exists. Future runs create upgrade records for `nestled-template` commits after that baseline. Then inspect `reports/upgrade-rollup.md`.

Also inspect `reports/recommendations/` if present. These are advisory shared-library extraction signals only; do not create packages unless explicitly asked.

If you want to inspect without applying direct patches:

```bash
node bin/nestled-upgrader.js run --dry-run-only
```

For each blocked item:

1. Open `reports/<project>/<upgrade-id>.md`.
2. Open `upgrades/<upgrade-id>.yaml`.
3. Move into the downstream project folder from `upgrader.config.yaml`.
4. Stay on or create `nestled-upgrade/<upgrade-id>`.
5. Implement the upgrade intent conservatively.
6. Run the project verification commands listed in config and the upgrade record.
7. Update `.nestled/upgrade-log.yaml` with `adapted`, `superseded`, `skipped`, `not-applicable`, or `blocked`.
8. Update the report with what happened and why.

Delivery rules:

- `code-patch`: adapt the behavior described by `intent`; treat `affectedPaths` as hints.
- `package-release`: bump package versions and lockfiles only; do not copy files from package `sourcePath`.
- `hybrid`: do package-release work first, then code-patch adaptation.
- Missing package `targetVersion` and `versionRange` means pending release; do not apply.

Rules:

- Do not use destructive git commands.
- Do not overwrite local product decisions in auth, billing, design, or database code.
- Do not edit secrets or `.env` files.
- Treat patch failure as a request for intent-based adaptation, not as final failure.
- If the template has no new commits and there are no pending upgrade records, stop after reporting that no upgrade was created.
