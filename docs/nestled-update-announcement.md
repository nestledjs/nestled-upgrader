---
title: "nestled-update: Your app stays current with the template — on your schedule"
description: "A git-native update channel that pulls template improvements — security fixes, dependency bumps, new capabilities — into every Nestled project, with one command and zero lock-in."
tag: "New"
---

# Keep every Nestled app current — automatically

When you build on a starter template, you get a head start. Then the template
moves on — security patches land, dependencies bump, new capabilities ship — and
your project quietly falls behind. The usual choices are bad ones: manually diff
the template forever, or fork it and never look back.

**`nestled-update` is a third option.** It's a git-native update channel that
brings template improvements into your project — one command, on your schedule,
with nothing to install and no lock-in.

```bash
npx @nestledjs/upgrades apply
```

That's it. Your project catches up with the template, on a branch, with your
tests run for you.

---

## The 30-second version

Every project created from the Nestled template can pull updates the moment
they're published.

```bash
# once, to record where your project started from
npx @nestledjs/upgrades init

# any time you want to catch up
npx @nestledjs/upgrades check    # what's new for me?
npx @nestledjs/upgrades apply    # bring it in — on a branch, verified, committed
```

No dependency is added to your project. `npx` runs the latest updater on demand.

---

## How it works

### An update channel, in git

Template maintainers publish each release into the template repository itself —
an ordered list of changes plus the patches that deliver them. Your project
reads that feed directly over git. There's no separate service to trust, no
account to create, and nothing new in your dependency tree. If your project can
reach the template repo, it can update.

### Your project remembers where it is

The first `init` records a **baseline** — the exact template version your project
was created from — in `.nestled/upgrade-log.yaml`. From then on, `check` and
`apply` only ever surface what's genuinely new to *you*. Two projects created
months apart each get exactly the updates they're missing, no more.

### Stable and canary channels

Updates flow through channels. New projects follow **stable** by default —
changes that have already been proven across the live Nestled fleet before they
ever reach you. Teams who want to help validate releases early can follow
**canary**. You're never the crash-test dummy unless you opt in.

### Every apply is safe by construction

`apply` never touches your working branch. It:

1. creates a dedicated `nestled-update/*` branch,
2. applies each pending change (with a 3-way merge so unrelated local edits are
   respected),
3. runs your project's own lint and tests,
4. commits — or, with `--pr`, opens a pull request for review.

If anything fails, it **rolls back cleanly**. You never end up with a
half-applied update or a broken tree.

---

## What's automatic — and what asks for you

Be clear-eyed about this, because it's where the design earns its trust.

**Automatic.** When a change touches code you haven't customized, it just
applies — patch, dependency bump, tests, commit. You can run `apply` on a
schedule (or in CI) and simply review the pull requests it opens. No babysitting.

**Deliberately not automatic.** When a change collides with code you've forked —
or when your tests fail after applying — `nestled-update` stops, rolls the change
back, and reports it as **blocked**, along with a plain-language description of
the *intent* of the change. That's your signal to make the equivalent edit
yourself, or hand the intent to a coding agent. The tool will never silently
overwrite a decision you made in your own codebase.

That boundary is the point: **apply everything that's safe, and be honest about
everything that isn't.**

---

## Running a fleet of apps?

If you maintain many Nestled apps, the same machinery drives all of them from one
place. Maintainers cut a release to `canary`, roll it across the fleet to catch
problems early, and only then promote it to `stable` for everyone else:

```bash
feed-publish --channel canary     # cut a release for the fleet
fleet-update                      # roll it across every managed app
feed-promote --to stable          # once validated, release it to the world
```

Your fleet dogfoods every change before your customers ever see it.

---

## Why it's built this way

- **No lock-in.** Nothing is installed in your project. Stop using it and there's
  nothing to remove.
- **No new trust surface.** The feed lives in the template repo you already use.
  Patches are exact git blobs tied to the commit that produced them.
- **No surprises.** Your branches are untouched, your tests gate every change, and
  conflicts stop for review instead of guessing.
- **Always current tooling.** Because you run it via `npx`, you always get the
  latest updater — while the updates themselves come from the channel you chose.

---

## Get started

In any project created from the Nestled template:

```bash
npx @nestledjs/upgrades init
npx @nestledjs/upgrades check
npx @nestledjs/upgrades apply
```

Run `npx @nestledjs/upgrades help` for the full command list. Your first update
is one command away.
