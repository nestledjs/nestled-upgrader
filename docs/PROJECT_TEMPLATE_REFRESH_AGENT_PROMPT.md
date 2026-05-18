# Project Template Refresh Agent Prompt

Paste this into an agent running from the root of a product project, for example:

- `~/IdeaProjects/moceanic-ai`
- `~/IdeaProjects/qalatra.com`
- `~/IdeaProjects/flightdesk`
- `~/IdeaProjects/muzebook`
- `~/IdeaProjects/biztobiz`

This prompt assumes `../nestled-template` exists and is the new clean clone-template baseline.

---

You are migrating this project onto the fresh `../nestled-template` baseline.

The goal is not to patch the old project toward the template. The goal is to replace the template/framework baseline with the clean template, then port back only product-specific code and configuration from the old project.

## Non-Negotiable Rules

- Do not delete or replace `.git`.
- Do not run destructive git commands such as `git reset --hard` or `git clean -fd` unless explicitly asked.
- Work on a new branch.
- Keep a complete local snapshot of the old working tree outside this repo until the migration is done.
- Use `../nestled-template` as the preferred source for framework/template files.
- Preserve product-specific code, data model, routes, branding, env examples, integrations, tests, and business logic.
- Prefer published `@nestledjs/*` packages over copying package source libraries.
- Do not copy dev-template-only package source directories into this project unless they already belong to this product.
- Produce a migration report before finishing.

## Step 1: Identify Project

Run:

```bash
pwd
git branch --show-current
git status --short
node -e "const p=require('./package.json'); console.log(p.name)"
```

If the project has uncommitted changes, inspect them first:

```bash
git status --short
git diff --stat
```

If the changes appear to be local user work unrelated to this migration, stop and report them. If they are generated/agent work already intended for this migration, continue and include them in the old-tree snapshot.

## Step 2: Create Migration Branch

Use the project name from `package.json` or folder name.

```bash
git switch -c template-refresh/2026-05-clean-template
```

If the branch already exists:

```bash
git switch template-refresh/2026-05-clean-template
```

## Step 3: Create Old-Tree Snapshot

Create a complete copy of the current project next to the repo, excluding heavy/generated folders.

Use a folder named:

```text
../<project-folder>-pre-template-refresh
```

Example:

```bash
rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude tmp \
  --exclude coverage \
  --exclude .nx \
  ./ ../$(basename "$PWD")-pre-template-refresh/
```

Verify the snapshot exists:

```bash
test -f ../$(basename "$PWD")-pre-template-refresh/package.json
```

This snapshot is the source for product-specific code that must be ported back.

## Step 4: Replace Working Tree With Fresh Template

Copy the fresh template into the current repo while preserving `.git`.

Important: do not remove `.git`.

Use `rsync` with delete, excluding `.git`:

```bash
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude tmp \
  --exclude coverage \
  --exclude .nx \
  ../nestled-template/ ./
```

After this step, the repo should look like the fresh template, but git history is still this product project.

Run:

```bash
git status --short
```

Expect a large diff. That is normal.

## Step 5: Restore Product Identity

From the old-tree snapshot, restore product identity and product-specific configuration. Inspect before copying.

Likely files to compare/port:

- `package.json`
- `README.md`
- `.env.example`
- `.env.*.example`
- Docker/deploy files if product-specific
- app branding/assets
- project-specific scripts
- CI config if product-specific

Do not blindly restore old `package.json`. Instead:

- Start from the fresh template `package.json`.
- Set the correct package name.
- Preserve product-specific scripts.
- Preserve product-specific dependencies.
- Keep new template scripts for `lint`, `test`, `typecheck`, build, and generated framework commands where appropriate.
- Prefer current template versions unless the product has a clear reason to keep a different version.

## Step 6: Port Product Code

Use the old snapshot as reference:

```text
../<project-folder>-pre-template-refresh
```

Port only product-specific files and behavior.

### Preserve

- product routes/pages/components
- product API custom logic
- Prisma schema, migrations, seed data
- domain models and product-specific shared types
- product integrations
- auth customizations that are truly product-specific
- branding, images, copy, site content
- product tests
- env examples and deployment settings

### Prefer Template

- framework boilerplate
- generated Nestled library structure
- lint/test/build config
- root Nx config unless product-specific
- React Router/Vite/framework entrypoints unless product-specific
- shared component/library package consumption
- generated API/client plumbing where the new template owns it

### Be Careful With These Paths

Compare these paths explicitly:

```text
apps/web/app
apps/web/tests
apps/api/src
libs/api/custom/src
libs/api/core
libs/api/prisma/src/lib/schemas
libs/shared
libs/web
package.json
pnpm-lock.yaml
nx.json
eslint.config.mjs
apps/web/eslint.config.mjs
```

Do not copy an entire old directory over the template unless it is clearly product-owned. Prefer selective porting.

## Step 7: Package And Lockfile

After package decisions are made:

```bash
pnpm install
```

If `pnpm install` fails, inspect dependency conflicts. Prefer the fresh template dependency model and only add old dependencies that product code still imports.

Search for imports that require old dependencies:

```bash
rg "from ['\\\"]|require\\(" apps libs scripts
```

## Step 8: Verification

Run the available checks:

```bash
pnpm lint
pnpm test
```

If available:

```bash
pnpm typecheck
pnpm build:web
pnpm build:api
```

If a check fails:

- fix product code where reasonable
- do not weaken lint/test config just to pass
- if the failure is unrelated or requires a product decision, record it in the migration report

## Step 9: Migration Report

Create:

```text
docs/template-refresh-report.md
```

Include:

```md
# Template Refresh Report

Date: 2026-05-15

## Summary

- Source template: ../nestled-template
- Old project snapshot: ../<project-folder>-pre-template-refresh
- Branch: template-refresh/2026-05-clean-template
- Outcome: completed / blocked

## Preserved Product Areas

- ...

## Template Areas Adopted

- ...

## Adapted Files

- ...

## Dropped Old Files

- ...

## Dependency Changes

- ...

## Verification

- pnpm install: passed/failed
- pnpm lint: passed/failed
- pnpm test: passed/failed
- pnpm typecheck: passed/failed/not available
- pnpm build:web: passed/failed/not available
- pnpm build:api: passed/failed/not available

## Open Questions

- ...
```

## Step 10: Review Diff

Run:

```bash
git status --short
git diff --stat
```

Then inspect high-risk changes:

```bash
git diff -- package.json
git diff -- nx.json
git diff -- eslint.config.mjs
git diff -- apps/web/eslint.config.mjs
git diff -- libs/api/prisma/src/lib/schemas
```

The final diff should tell a coherent story:

- template/framework files replaced by the new template
- product code intentionally reintroduced
- dependencies aligned with actual imports
- report added

## Step 11: Clean Up Snapshot

Only after verification and report are complete, remove the old-tree snapshot:

```bash
rm -rf ../$(basename "$PWD")-pre-template-refresh
```

Do not remove it earlier.

## Step 12: Commit

If verification is acceptable:

```bash
git add -A
git commit --no-gpg-sign -m "Refresh project from clean Nestled template"
```

If verification is not acceptable, do not commit unless asked. Leave the report and working tree for review.

## Final Response

Report:

- branch name
- whether verification passed
- path to `docs/template-refresh-report.md`
- major product areas preserved
- major unresolved questions
- whether the old snapshot was removed

Do not claim success if lint/tests failed.

