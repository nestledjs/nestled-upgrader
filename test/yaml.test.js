import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml } from '../lib/yaml.js';

test('parses spec-style config yaml', () => {
  const parsed = parseYaml(`
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main

projects:
  - name: project-a
    path: ../project-a
    defaultBranch: main
    forkedAreas: []
    verification:
      - pnpm lint
      - pnpm test
`);

  assert.equal(parsed.template.name, 'nestled-template');
  assert.equal(parsed.projects[0].name, 'project-a');
  assert.deepEqual(parsed.projects[0].forkedAreas, []);
  assert.deepEqual(parsed.projects[0].verification, ['pnpm lint', 'pnpm test']);
});

test('round-trips nested upgrade log data', () => {
  const source = {
    template: { repo: 'nestled-template', originCommit: '73a880b' },
    upgrades: {
      '2026-05-13-auth-session-hardening': {
        status: 'adapted',
        reviewedAt: '2026-05-13T14:30:00Z',
        notes: 'Adapted to local session middleware.'
      }
    }
  };

  assert.deepEqual(parseYaml(stringifyYaml(source)), source);
});

test('parses sequence item with colon-in-value as plain string not a mapping', () => {
  const result = parseYaml(`
verification:
  - pnpm template:validate-upgrade-notes
  - pnpm nx test web --skipNxCache
`);
  assert.equal(typeof result.verification[0], 'string');
  assert.equal(result.verification[0], 'pnpm template:validate-upgrade-notes');
  assert.equal(result.verification[1], 'pnpm nx test web --skipNxCache');
});

test('parses continued YAML sequence items', () => {
  const parsed = parseYaml(`
agentHints:
  - Change the "lint" script in package.json from "nx workspace-lint && nx lint"
    (or any variation) to "nx run-many -t lint".
  - Keep the second item unchanged.
`);

  assert.deepEqual(parsed.agentHints, [
    'Change the "lint" script in package.json from "nx workspace-lint && nx lint" (or any variation) to "nx run-many -t lint".',
    'Keep the second item unchanged.'
  ]);
});

test('double-quoted scalars round-trip without compounding backslashes', () => {
  // Regression: parseScalar() sliced quotes without unescaping while formatScalar() escapes via
  // JSON.stringify, so every read-modify-write doubled every backslash (`\n` -> `\\n` -> `\\\\n`),
  // progressively corrupting `notes:` in .nestled/upgrade-log.yaml on each upgrader run.
  const source = 'notes: "error: patch failed\\nerror: does not apply"\n';
  const parsed = parseYaml(source);
  assert.equal(parsed.notes, 'error: patch failed\nerror: does not apply');

  let current = source;
  for (let i = 0; i < 3; i += 1) current = stringifyYaml(parseYaml(current));
  assert.equal(current, source, 'round-trip must be idempotent');
});

test('parses block scalars with chomping indicators', () => {
  // Regression: only bare `>` and `|` were matched, so the common `>-` / `|-` forms threw
  // "Unexpected YAML indentation" and crashed the tool on hand-written upgrade-log entries.
  for (const indicator of ['>', '>-', '>+']) {
    assert.equal(parseYaml(`notes: ${indicator}\n  hello\n  world\n`).notes, 'hello world');
  }
  for (const indicator of ['|', '|-', '|+']) {
    assert.equal(parseYaml(`notes: ${indicator}\n  hello\n  world\n`).notes, 'hello\nworld');
  }
});

test('single-quoted scalars unescape doubled quotes', () => {
  assert.equal(parseYaml("notes: 'it''s fine'\n").notes, "it's fine");
});
