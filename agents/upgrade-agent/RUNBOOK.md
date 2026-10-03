# Upgrade Agent Runbook

Default task:

```bash
node bin/nestled-upgrader.js run
```

Use `node bin/nestled-upgrader.js run --dry-run-only` when asked to inspect without changing downstream projects.

If `upgrade --all` records blocked items, adapt them manually:

- Read the upgrade `intent`, `why`, `affectedPaths`, `skipIf`, and `verification`.
- Inspect the downstream implementation before editing.
- Preserve local forks and product decisions.
- Implement the smallest change that satisfies the intent.
- Run verification.
- Record the outcome in `.nestled/upgrade-log.yaml`.
- Update `reports/<project>/<upgrade-id>.md`.
