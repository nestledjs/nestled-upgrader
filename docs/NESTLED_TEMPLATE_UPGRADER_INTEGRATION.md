# Nestled Template Upgrader Integration Spec

This spec describes what `nestled-dev-template` should produce so `nestled-upgrader` can reliably propagate template changes into `nestled-template` and downstream projects.

## Goal

When a meaningful change lands in `nestled-dev-template`, the dev template project should make it easy for the upgrader to create a semantic upgrade record and patch. The upgrader can then:

- Detect that the template moved.
- Generate or consume an upgrade record.
- Apply the patch directly when downstream code still matches.
- Hand blocked or diverged cases to an agent with enough context to adapt, reject, or recommend a library version bump.

## Required Template Repository Layout

Add this directory to `nestled-dev-template`:

```text
nestled-dev-template/
  .nestled-updates/
    upgrade-notes/
      README.md
      <upgrade-id>.yaml
```

The dev template repo owns `.nestled-updates/upgrade-notes/*.yaml`.

The upgrader repo owns:

```text
nestled-upgrader/
  upgrades/*.yaml
  patches/*.diff
  upgrader.state.yaml
  reports/
```

## Upgrade Note Schema

Each template PR that should propagate downstream should add one upgrade note.

```yaml
id: 2026-05-13-auth-session-hardening
title: Auth session hardening
priority: high
area: auth
type: security

intent: >
  Ensure expired sessions are rejected consistently before protected
  data is returned.

why: >
  Some routes checked auth at the web layer, but API resolvers could
  still accept stale sessions.

affectedPaths:
  - apps/api/src/auth/**
  - apps/web/app/routes/**

skipIf:
  - Project has custom auth with documented expiry enforcement.

verification:
  - pnpm lint
  - pnpm test
  - pnpm test:e2e:auth

agentHints:
  - Look for session expiry checks near API resolver auth middleware.
  - If the project uses a custom auth provider, preserve that provider and enforce the same expiry behavior there.
```

The template should not include `patch.path`; the upgrader creates patches from git commit ranges.

## Required Fields

- `id`: Stable, date-prefixed slug. Format: `YYYY-MM-DD-short-description`.
- `title`: Human-readable change name.
- `priority`: One of `critical`, `high`, `normal`, `low`, `ignore`.
- `area`: Routing label such as `auth`, `billing`, `admin`, `ui`, `api`, `web`, `database`, `infra`, or `docs`.
- `type`: One of `security`, `correctness`, `feature`, `infra`, `deps`, `design`, `docs`, `cleanup`.
- `intent`: What downstream projects should achieve.
- `why`: Why the change matters.
- `delivery`: One of `code-patch`, `package-release`, or `hybrid`, unless `priority: ignore`.

Recommended fields:

- `skipIf`: Conditions where downstream projects should skip or mark superseded.
- `verification`: Commands downstream projects should run when applicable.
- `agentHints`: Practical adaptation guidance for coding agents.

## Delivery Modes

Use `delivery: code-patch` for changes that should be applied or adapted as downstream source behavior.

```yaml
delivery: code-patch
```

Rules:

- Require `affectedPaths`.
- Treat `affectedPaths` as hints, not exact files to overwrite.
- Apply the behavior described by `intent`.
- Do not assume downstream code matches the template exactly.

Use `delivery: package-release` when downstream projects should consume a published package version instead of copying source from `libs/*`.

```yaml
delivery: package-release
packageReleases:
  - name: '@nestledjs/data-browser'
    sourcePath: libs/data-browser
    targetVersion: 1.1.0
    versionRange: ^1.1.0
```

Rules:

- Require `packageReleases`.
- For each package release, update downstream `package.json` and lockfile.
- Do not copy files from the package source path.
- Verify the target package version exists before applying.
- If neither `targetVersion` nor `versionRange` is present, block as pending-release.

Use `delivery: hybrid` when downstream projects need both a package update and local source adaptation.

Rules:

- Require both `packageReleases` and `affectedPaths`.
- Apply package-release behavior first.
- Then apply code-patch behavior.

Example:

```yaml
id: 2026-05-13-data-browser-package
title: Consume shared data browser package
priority: high
area: data-browser
type: deps

delivery: package-release
packageReleases:
  - name: '@nestledjs/data-browser'
    sourcePath: libs/data-browser
    targetVersion: 1.1.0
    versionRange: ^1.1.0

intent: >
  Projects should consume the shared data browser package instead of
  copying implementation files from the dev template.

why: >
  The implementation now ships as @nestledjs/data-browser, so downstream
  projects should receive the change through dependency updates.

affectedPaths:
  - package.json
  - pnpm-lock.yaml
  - libs/data-browser/**

skipIf:
  - Project does not use @nestledjs/data-browser.

agentHints:
  - Check package.json files for @nestledjs/data-browser.
  - If present, bump it to ^1.1.0 and update the lockfile.
  - Do not copy files from libs/data-browser.
```

## PR Requirements In `nestled-dev-template`

Every template PR should answer: “Should this propagate downstream?”

If yes:

1. Add `.nestled-updates/upgrade-notes/<upgrade-id>.yaml`.
2. Make `intent` behavior-oriented, not patch-oriented.
3. Include affected paths.
4. Include verification commands.
5. Mention the upgrade note path in the PR description.

If no:

1. Either omit an upgrade note, or add a note with `priority: ignore`.
2. Explain why the change should not propagate.

## PR Description Block

Template PRs should include this block:

```markdown
## Downstream Upgrade

- Propagate downstream: yes
- Upgrade note: `.nestled-updates/upgrade-notes/2026-05-13-auth-session-hardening.yaml`
- Area: auth
- Priority: high
- Verification: `pnpm lint`, `pnpm test`, `pnpm test:e2e:auth`
```

For non-propagating changes:

```markdown
## Downstream Upgrade

- Propagate downstream: no
- Reason: Template-only documentation cleanup.
```

## CI Validation

`nestled-dev-template` should validate upgrade notes in CI.

Minimum validation:

- YAML parses.
- Required fields exist.
- `id` matches filename.
- `priority`, `type`, and `area` are valid.
- `affectedPaths` is present unless `priority: ignore`.
- `intent` and `why` are non-empty unless `priority: ignore`.

Recommended validation:

- At least one `affectedPaths` entry matches a file changed in the PR.
- Security/correctness changes cannot omit an upgrade note unless the PR description says propagation is not needed.

## How The Upgrader Uses This

When `nestled-upgrader` runs:

1. It compares `upgrader.state.yaml` with `nestled-dev-template` HEAD.
2. It creates a patch for the template commit range.
3. It should prefer matching `.nestled-updates/upgrade-notes/*.yaml` files from that range.
4. It copies the note into `upgrades/<upgrade-id>.yaml`.
5. It adds:

```yaml
sourceRepo: nestled-dev-template
sourceCommitRange: <from>..<to>
patch:
  path: patches/<upgrade-id>.diff
```

6. It runs upgrades across downstream projects.
7. If `delivery` includes `package-release`, it must verify a published target version, update package manifests and lockfiles, and avoid copying files from package `sourcePath`.
8. If `delivery` is `hybrid`, it must apply package-release behavior before code-patch behavior.

## Agent-Friendly Guidance

Write upgrade notes for agents, not just humans. Good notes describe the invariant the downstream project should satisfy.

Good:

```yaml
intent: >
  Reject expired sessions inside API resolver auth checks before any protected data is loaded.
```

Weak:

```yaml
intent: >
  Copy the new auth middleware file.
```

The downstream project may not have the same files. The agent needs to know the concept, expected behavior, and verification path.

## First Setup Checklist For `nestled-dev-template`

1. Create `.nestled-updates/upgrade-notes/README.md`.
2. Add an upgrade-note schema validator.
3. Add a PR template section for downstream upgrade impact.
4. Add CI that validates upgrade notes on pull requests.
5. Update contributor docs: every meaningful template change must declare whether it propagates downstream.
6. Optionally add a helper command:

```bash
pnpm template:create-upgrade-note --id 2026-05-13-auth-session-hardening
```

## Example Upgrade Note README

```markdown
# Template Upgrade Notes

Add one YAML file here for each template change that should be reviewed by downstream Nestled projects.

Upgrade notes describe intent, not just diffs. Downstream projects may have diverged, so the upgrader and coding agents use these notes to decide whether to apply, adapt, skip, supersede, or block each change.
```
