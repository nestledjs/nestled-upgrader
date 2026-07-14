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

test('quotes scalars starting with YAML reserved indicators', () => {
  // Regression: needsQuoting() ignored leading indicator characters, so a value like
  // "@nestledjs/generators ..." was emitted unquoted. Our lenient parser read it back fine, but
  // strict YAML parsers reject it (BAD_SCALAR_START), breaking third-party tooling that reads
  // .nestled/upgrade-log.yaml.
  const values = {
    at: '@nestledjs/generators 1.1.3 satisfies >=1.1.2.',
    star: '*star',
    bang: '!bang',
    anchor: '&anchor',
    percent: '%pct',
    tick: '`tick',
    plain: 'normal value',
    midString: 'has >= mid-string ok'
  };
  const emitted = stringifyYaml(values);
  assert.match(emitted, /^at: "@nestledjs/m, 'leading @ must be quoted');
  assert.match(emitted, /^star: "\*star"$/m);
  assert.match(emitted, /^plain: normal value$/m, 'safe plain scalars stay unquoted');
  assert.match(emitted, /^midString: has >= mid-string ok$/m, 'indicators mid-string are fine');
  assert.deepEqual(parseYaml(emitted), values, 'round-trip must be lossless');
});

test('does not strip # inside block scalars', () => {
  // Regression: stripComment() ran on every line, including block-scalar bodies, so literal text
  // was silently truncated at the first `#`. A real upgrade-log note reading
  // "stripped the ## Downstream Upgrade Notes block" lost everything from the `#` onward.
  // Silent truncation is worse than the parse error that block-scalar support replaced.
  const parsed = parseYaml(
    'notes: >-\n' +
      '  removed the section via the doctor regex\n' +
      '  (also stripped the ## Downstream Upgrade Notes block, which lacked a boundary)\n' +
      '  and preserved the final newline.\n' +
      'status: adapted\n'
  );
  assert.match(parsed.notes, /## Downstream Upgrade Notes/);
  assert.equal(parsed.status, 'adapted', 'a dedent must end the block scalar');

  // Literal blocks too — verification commands routinely contain `#`.
  assert.equal(parseYaml('cmd: |\n  grep -n "## Header" file\n  echo done\n').cmd, 'grep -n "## Header" file\necho done');
});

test('still strips real comments outside block scalars', () => {
  const parsed = parseYaml('name: value # trailing comment\n# whole-line comment\nother: x\n');
  assert.equal(parsed.name, 'value');
  assert.equal(parsed.other, 'x');
});
