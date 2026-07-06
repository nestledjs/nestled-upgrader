# Nestled Update — Distribution & Channel Spec

Status: **draft for review**. This describes how the current private fleet upgrader evolves
into a public, versioned update channel that any `nestled-template` clone can consume, while
keeping note-authoring private and adding a staged (fleet-first) rollout.

It specifies the three genuinely new pieces:

1. The **release manifest** (the published feed) with **channels** for staged rollout.
2. The per-clone **baseline stamp** (reusing today's `.nestled/upgrade-log.yaml`).
3. The **command surface** for `nestled-update` (public consumer) and the private producer.

Everything inside "apply a note" — 3-way patch, intent fallback, per-project log, blocked-item
handling — already exists in `lib/upgrader.js` and is reused unchanged.

---

## 0. Roles & repos

| Piece | Visibility | Responsibility |
|---|---|---|
| `nestled-dev-template` | private | Where you author changes. |
| `nestled-upgrade-producer` (today's repo) | private | Promote dev→template, generate notes, cut releases, move channel pointers. Owns your `fleet.yaml`. |
| `nestled-template` | private-to-you, cloned by all sites | Canonical template **and** carries a committed version stamp. |
| Update feed (`manifest.yaml` + patches) | public-readable | The ordered list of releases + channel pointers. Transport TBD (see §5). |
| `nestled-update` | **public** package | The consumer. Installed in every site. Reads feed, applies pending, records state. |
| Fleet manager | optional, can ship with `nestled-update` | Thin orchestrator: loops your sites, runs `nestled-update` on the `canary` channel. |

Authoring is **always private** (only you author). Every clone only ever *consumes*. Your ~11
fleet sites are just consumers #1–N that happen to run on the `canary` channel first.

---

## 1. Channels — fleet-first staged rollout

Two channels:

- **`canary`** — your fleet consumes this. Every release lands here first.
- **`stable`** — the public consumes this. A release reaches it only after canary validation.

The manifest carries the full ordered `releases[]` **plus a pointer per channel**:

```yaml
channels:
  canary: "2026.07.1"   # newest release the fleet should have
  stable: "2026.06.3"   # newest release the public should have
```

A consumer on channel `C` applies every release with `baseline < release.id <= channels[C]`.
Because `canary` points further ahead than `stable`, your fleet sees newer releases than the
world does. Promotion is just advancing the `stable` pointer to catch up.

### Rollout lifecycle

```
author (dev-template, private)
      │
      ▼ promote
nestled-template  ──►  publish --channel canary   (release enters manifest, canary pointer advances)
      │
      ▼
fleet manager runs `nestled-update` (canary) across your sites  ──►  surfaces bugs
      │  fix → back to dev-template → new canary release, repeat
      ▼  happy
promote-release <id> --to stable   (stable pointer advances)
      │
      ▼
the world runs `nestled-update` (stable) and gets it
```

This satisfies the "roll out to my fleet **before** publishing the official version" requirement:
a release is live on `canary` (fleet-only) for as long as you want before `stable` moves.

---

## 2. The release manifest (the feed)

One document, published to the channel transport (§5). Schema:

```yaml
schemaVersion: 1
generatedAt: "2026-07-06"

channels:
  canary: "2026.07.1"
  stable: "2026.06.3"

releases:
  - id: "2026.07.1"           # ordered, comparable (date-based recommended)
    date: "2026-07-06"
    title: "Auth hardening + data-browser bump"
    templateCommit: "a1b2c3d"  # nestled-template commit this release corresponds to
    notes:
      - id: "2026-07-06-auth-token-rotation"
        title: "Rotate auth tokens on refresh"
        delivery: code-patch          # code-patch | package-release | hybrid
        intent: "Refresh handler must rotate the token; treat affectedPaths as hints."
        affectedPaths: ["src/auth/refresh.ts"]
        patch: "patches/2026-07-06-auth-token-rotation.diff"
      - id: "2026-07-06-data-browser-1.4.0"
        title: "Bump @nestled/data-browser to 1.4.0"
        delivery: package-release
        package:
          name: "@nestled/data-browser"
          targetVersion: "1.4.0"
          versionRange: "^1.4.0"
```

Notes map 1:1 to today's `upgrades/*.yaml` records — the producer emits them into the manifest
instead of (only) a local folder. `delivery`, `intent`, `affectedPaths`, and the package fields
are unchanged from the current model, so the consumer's apply logic is reused verbatim.

`releases[].id` should be **sortable** so "newer than baseline" is a simple comparison. Date-based
(`YYYY.MM.N`) is recommended over semver because these are cumulative template states, not an API.

---

## 3. The per-clone baseline (reuses `.nestled/upgrade-log.yaml`)

Today's log already has exactly the fields we need:

```yaml
template:
  repo: nestled-template
  originCommit: <short-sha>       # ← the baseline
  lastReviewedCommit: <short-sha> # ← advanced as notes apply
upgrades:
  <note-id>: applied | blocked | superseded | not-applicable | pending-release
```

We add three fields and one companion file:

```yaml
template:
  repo: nestled-template
  channel: canary                 # NEW: which channel this clone follows (default: stable)
  baselineRelease: "2026.06.3"    # NEW: newest release considered already-present
  originCommit: <short-sha>       # kept (commit the clone started from)
  lastReviewedCommit: <short-sha> # kept
```

Companion stamp committed **into `nestled-template`** (travels with every clone):

```
.nestled/template-version   →   { release: "2026.06.3", commit: "a1b2c3d" }
```

Because the stamp is committed in the template, a fresh clone *carries proof of the version it
came from*. `nestled-update init` reads it and sets `baselineRelease` with no guessing. Every
`nestled-update apply` advances `baselineRelease` (and `lastReviewedCommit`) as it goes.

**Pending computation:** `pending = releases where baselineRelease < id <= channels[channel]`.

---

## 4. Command surface

### Public consumer — `nestled-update`

| Command | What it does |
|---|---|
| `nestled-update init` (a.k.a. `workspace-setup`) | Establish baseline from `.nestled/template-version` (or `--at <release>`), set `channel`, write `.nestled/upgrade-log.yaml`. Idempotent. Marks all releases ≤ baseline as present, none to apply. |
| `nestled-update check` | Show pending releases/notes for this channel. No changes. |
| `nestled-update` / `... apply` | Apply pending up to the channel pointer: branch `nestled-upgrade/<release>`, 3-way patch with intent fallback, run verification, record outcomes, advance baseline, optional PR. Flags: `--dry-run`, `--channel <c>`, `--to <release>`, `--allow-dirty`. |
| `nestled-update status` | Print current channel, baseline, and applied history. |

### Private producer — `nestled-upgrader` (implemented in `lib/feed.js`)

| Command | What it does |
|---|---|
| existing `promote-template`, `sync-template`, `create-upgrade` | Author notes (unchanged). |
| `feed-publish --channel canary [--title …] [--push] [--dry-run]` | Bundle unpublished downstream records into a new date-based release, copy their patches into the template's `.nestled-upgrades/`, advance the `canary` pointer, commit (and optionally push) the template. |
| `feed-promote --to stable [--release <id>] [--push]` | Advance the `stable` (or named) pointer to a release; commit the template. Defaults to the current `canary` release. |
| `feed-status` | Print the feed's channel pointers and releases. |
| `baseline-fleet --at <release> [--channel canary] [--remote <url>] [--ref <branch>] [--dry-run]` | One-time migration (see §6): stamp every fleet site's `.nestled/upgrade-log.yaml` with baseline, channel, and feed remote/ref. |

### Fleet manager (optional, thin)

Reads a **gitignored** `fleet.yaml` (your list of sites — never committed to the public repo),
loops sites, and runs `nestled-update apply --channel canary` in each. This is today's
`run` / `upgrade --all`, re-pointed to call the public consumer. Pull-model alternative: each
site runs `nestled-update` itself on CI/cron and you just monitor.

---

## 5. Feed transport — DECIDED: committed in the public `nestled-template`

`nestled-template` is public, so the feed lives **inside it** — no npm publish, no separate
artifact. The maintainer commits, alongside the template's own changes:

- `.nestled-upgrades/manifest.yaml` — the manifest (§2), including the channel pointers.
- `.nestled-upgrades/patches/*.diff` — the patch files the notes reference.

Cutting a release is therefore just a commit to `nestled-template` that appends the release and
advances the `canary` pointer; promotion is a later commit that advances `stable`. The patches
ride in the same commit that produced the change, so a note can never point at a patch that
doesn't match its template commit.

**Consumer read path: `git fetch`.** `nestled-update` keeps `nestled-template` as an upstream
remote, does a shallow fetch, and reads `.nestled-upgrades/manifest.yaml` + the referenced
patches at that ref. Rationale over npm/CDN:

- The public-repo case removes npm's only real advantage (no-auth access for strangers).
- Reuses git, which every site already has; patches are exact blobs tied to the manifest commit.
- Works unchanged if the template is ever made private (git creds), so no lock-in to "public".
- Matches the existing `currency-check` precedent, which already reads a ledger from a git ref
  (default `origin/develop`).

Why not npm: it adds a mandatory `npm publish` step per release and a version-mapping surface,
buying nothing here. Why not raw HTTPS (`raw.githubusercontent.com`): lighter, but GitHub-public
-only and host-tied — kept as a possible fast path, not the primary.

The manifest schema (§2) is transport-agnostic, so only the "load manifest" step depends on this.

---

## 6. Migration: baseline the existing world now

Your fleet is currently *every* nestled project that exists, and you control them all — so there
are no unknown legacy clones to detect. Do a clean cutover **before** shipping the updater:

1. Choose `BASELINE_COMMIT` = current `nestled-template` HEAD.
2. Commit `.nestled/template-version = { release: "<baseline-release-id>", commit: BASELINE_COMMIT }`
   into `nestled-template` at that commit.
3. Run `baseline-fleet --at BASELINE_COMMIT` across all known sites → writes each site's
   `.nestled/upgrade-log.yaml` with `baselineRelease` set and **no notes to apply**.
4. From now on, only commits *after* `BASELINE_COMMIT` become releases.

This sidesteps the "legacy adoption / declare-your-baseline" problem entirely for now. That
fallback (prompt or detect a baseline for a clone that predates the stamp) only becomes necessary
if third parties ever clone the template *without* going through `nestled-update init` — worth
designing later, not needed for launch.

---

## 7. What's reused vs. new

**Reused unchanged** from `lib/upgrader.js`: patch application (3-way + rawPatch excludes),
intent-based fallback, package-release version bumps, per-project `.nestled/upgrade-log.yaml`,
branch/commit/PR helpers, verification runner, blocked-item outcomes, report writers.

**New**: the manifest/release/channel format (§2), the `.nestled/template-version` stamp +
`baselineRelease`/`channel` fields (§3), fetch-from-channel + pending computation (§3–5), the
`init`/`check`/`status` consumer commands and `publish`/`promote-release`/`baseline-fleet`
producer commands (§4).
