# Nestled Upgrader Specification

## Purpose

`nestled-upgrader` is a sibling control-plane project for propagating useful changes from `nestled-template` into downstream Nestled projects that began as clones of the template. It must support both direct patch application and intent-based adaptation when downstream projects have diverged.

The upgrader should not treat downstream repositories as disposable copies. It should inspect each project, decide whether an upgrade still applies, apply the least invasive change, run verification, and record the outcome.

## Non-Goals

- Do not overwrite local product decisions.
- Do not require every downstream project to stay merge-compatible with `nestled-template`.
- Do not automatically abstract code into shared packages without review.
- Do not directly land changes on protected branches.

## Repository Layout

Recommended layout:

```text
IdeaProjects/
  nestled-template/
  nestled-upgrader/
  project-a/
  project-b/
```

Inside `nestled-upgrader`:

```text
nestled-upgrader/
  upgrader.config.yaml
  upgrades/
    2026-05-13-auth-session-hardening.yaml
  patches/
    2026-05-13-auth-session-hardening.diff
  reports/
  agents/
    upgrade-agent/
      agent.config
      CLAUDE.md
  spec/
    NESTLED_UPGRADER_SPEC.md
```

Inside each downstream repo:

```text
.nestled/
  upgrade-log.yaml
```

## Upgrader Config

`upgrader.config.yaml` tracks the template and downstream projects.

```yaml
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: develop

projects:
  - name: project-a
    path: ../project-a
    defaultBranch: develop
    forkedAreas: []
    verification:
      - pnpm lint
      - pnpm test

  - name: project-b
    path: ../project-b
    defaultBranch: develop
    forkedAreas:
      - auth
    verification:
      - pnpm lint
```

`forkedAreas` marks areas where the project intentionally diverged. An upgrade may still be relevant, but the agent must avoid direct patch assumptions.

## Upgrade Record Schema

Each upgrade is a semantic record, not just a diff.

```yaml
id: 2026-05-13-auth-session-hardening
title: Auth session hardening
priority: high
area: auth
type: security
sourceRepo: nestled-template
sourceCommitRange: abc123..def456

intent: >
  Ensure expired sessions are rejected consistently before protected
  data is returned.

why: >
  Some routes checked auth at the web layer, but API resolvers could
  still accept stale sessions.

affectedPaths:
  - apps/api/src/auth/**
  - apps/web/app/routes/**

patch:
  path: patches/2026-05-13-auth-session-hardening.diff

skipIf:
  - Project has custom auth with documented expiry enforcement.

verification:
  - pnpm lint
  - pnpm test
  - pnpm test:e2e:auth
```

Priority values:

- `critical`: security, data loss, or production breakage.
- `high`: correctness or important platform behavior.
- `normal`: useful feature or maintainability improvement.
- `low`: optional polish, cleanup, or consistency.
- `ignore`: recorded but not intended for downstream propagation.

Type values should include `security`, `correctness`, `feature`, `infra`, `deps`, `design`, `docs`, and `cleanup`.

Area values should be practical routing labels such as `auth`, `billing`, `admin`, `ui`, `data-browser`, `api`, `web`, `database`, `codegen`, `infra`, or `docs`.

## Downstream Upgrade Log

Each downstream repo records decisions in `.nestled/upgrade-log.yaml`.

```yaml
template:
  repo: nestled-template
  originCommit: 73a880b
  lastReviewedCommit: 8d12e3f

upgrades:
  2026-05-13-auth-session-hardening:
    status: adapted
    reviewedAt: 2026-05-13T14:30:00Z
    branch: nestled-upgrade/auth-session-hardening
    commit: abc123
    notes: Adapted to local session middleware.

  2026-05-13-theme-refresh:
    status: skipped
    reviewedAt: 2026-05-13T14:40:00Z
    reason: Product has custom branding.
```

Status values:

- `pending`: not yet reviewed.
- `applied`: direct patch or equivalent change applied cleanly.
- `adapted`: intent achieved using project-specific implementation.
- `skipped`: intentionally not applied.
- `superseded`: project already satisfies the intent.
- `blocked`: needs human decision or missing dependency.
- `not-applicable`: does not apply to this project.

## Agent Workflow

For each pending upgrade and project:

1. Read `upgrader.config.yaml`.
2. Read the upgrade record.
3. Read `.nestled/upgrade-log.yaml` from the downstream repo.
4. Inspect affected paths and related local implementation.
5. Decide whether the goal is relevant.
6. Prefer direct patch application only when the downstream code is still compatible.
7. If direct patching fails or the project diverged, switch to intent-based adaptation.
8. If the project already satisfies the intent, mark `superseded`.
9. If the change conflicts with a documented forked area, mark `skipped`, `adapted`, or `blocked` with clear reasoning.
10. Create a branch named `nestled-upgrade/<upgrade-id>`.
11. Apply changes conservatively.
12. Run configured verification commands when possible.
13. Update `.nestled/upgrade-log.yaml`.
14. Write a report under `reports/<project>/<upgrade-id>.md`.

The agent should never equate “patch failed” with “upgrade failed.” Patch failure means it must evaluate the intent.

## Safety Rules

- Never run destructive git commands such as `reset --hard` or `clean -fd` unless explicitly approved.
- Never overwrite local project-specific auth, billing, design, or database decisions without review.
- Never modify secrets or commit `.env`.
- Always work on a branch.
- Always record skipped, superseded, adapted, and blocked decisions.
- Prefer small commits and clear reports.
- Treat `forkedAreas` as a warning, not an automatic skip.

## CLI Requirements

Initial CLI commands:

```bash
nestled-upgrader status
nestled-upgrader discover
nestled-upgrader create-upgrade --from <commit> --to <commit>
nestled-upgrader plan --project <name> --upgrade <id>
nestled-upgrader apply --project <name> --upgrade <id> --dry-run
nestled-upgrader apply --project <name> --upgrade <id>
nestled-upgrader report --project <name>
```

Command behavior:

- `status`: list projects and pending/applied/skipped upgrade counts.
- `discover`: find upgrades not yet reviewed by each project.
- `create-upgrade`: generate a draft upgrade record and patch from a template commit range.
- `plan`: inspect one project and produce a recommended action without editing.
- `apply --dry-run`: simulate application and write a report.
- `apply`: create a branch, make changes, run checks, update the log, and report.
- `report`: summarize upgrade history and blocked decisions.

## Qalatra Agent

Create an agent under `agents/upgrade-agent`.

Responsibilities:

- Understand all registered Nestled projects.
- Interpret upgrade intent and downstream divergence.
- Apply or adapt changes carefully.
- Update `.nestled/upgrade-log.yaml`.
- Recommend shared library extraction when repeated adaptations reveal common logic.

The agent should classify outcomes as `applied`, `adapted`, `skipped`, `superseded`, `blocked`, or `not-applicable`.

## Library Extraction Recommendations

When the same upgrade is applied or adapted across multiple projects with similar logic, the upgrader should create a recommendation report:

```yaml
type: extract-library
area: billing
candidatePackage: '@nestledjs/billing'
reason: Same Stripe webhook validation logic applied to three projects.
projects:
  - project-a
  - project-c
  - project-d
```

Recommendations are advisory. They should not automatically create packages or refactor downstream projects.

## First Implementation Milestone

Build a minimal working version that can:

1. Parse `upgrader.config.yaml`.
2. Parse upgrade records from `upgrades/*.yaml`.
3. Read and write `.nestled/upgrade-log.yaml`.
4. Show status across projects.
5. Create draft upgrade records and patch files from template git ranges.
6. Generate a plan report for one project and one upgrade.
7. Support dry-run application.

Actual intent-based code editing can be handled by the Qalatra/Codex agent first; the CLI should provide structure, logs, and reports.
