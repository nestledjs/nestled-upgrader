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

test('quoted sequence items with prose colons stay scalars', () => {
  // Regression: the keyValue branch claimed any item containing `: ` as a mapping, so a quoted
  // hint became { "Update the spec together with the source": "tests/routes/..." } — silently, on
  // a single line. Upgrade notes quote precisely to keep prose colons out of the grammar.
  const parsed = parseYaml(`
agentHints:
  - "Update the spec together with the source: tests/routes/admin/_index.spec.tsx"
  - 'Bump forms to 0.8.2, not 0.8.1: 0.8.1 ships broken .d.ts files.'
`);

  assert.deepEqual(parsed.agentHints, [
    'Update the spec together with the source: tests/routes/admin/_index.spec.tsx',
    'Bump forms to 0.8.2, not 0.8.1: 0.8.1 ships broken .d.ts files.'
  ]);
});

test('quoted sequence items fold across continuation lines', () => {
  // Regression: the same mis-parse turned fatal when a continuation line held no colon at all —
  // "Invalid YAML mapping at line N" — which blocked promote-template entirely.
  const parsed = parseYaml(`
agentHints:
  - "The billing routes live under the \`admin\` parent in routes.tsx: route('billing/plans', ...)
    giving the real path /admin/billing/plans.
    There is no /settings/admin tree."
  - 'A quoted item with a doubled '' quote: still one scalar.'
`);

  assert.deepEqual(parsed.agentHints, [
    "The billing routes live under the `admin` parent in routes.tsx: route('billing/plans', ...) giving the real path /admin/billing/plans. There is no /settings/admin tree.",
    "A quoted item with a doubled ' quote: still one scalar."
  ]);
});

test('quoted mapping values fold across continuation lines', () => {
  // Same bug on the mapping side: the opening line parsed as a scalar keeping its dangling quote
  // and the continuation then threw "Unexpected YAML indentation".
  const parsed = parseYaml(`
title: "Forms 0.8.2 read-only fix: broken declarations
  and the data-browser peer widening"
priority: normal
`);

  assert.equal(parsed.title, 'Forms 0.8.2 read-only fix: broken declarations and the data-browser peer widening');
  assert.equal(parsed.priority, 'normal');
});

test('sequence mappings with quoted values still parse as mappings', () => {
  // The quoted-scalar short-circuit must not swallow `packageReleases` entries.
  const parsed = parseYaml(`
packageReleases:
  - name: '@nestledjs/data-browser'
    sourcePath: libs/data-browser
    targetVersion: 1.0.19
    versionRange: '>=1.0.19'
`);

  assert.deepEqual(parsed.packageReleases, [
    {
      name: '@nestledjs/data-browser',
      sourcePath: 'libs/data-browser',
      targetVersion: '1.0.19',
      versionRange: '>=1.0.19'
    }
  ]);
});

test('quoted values fold on the first key of a sequence-of-mappings item', () => {
  // The first key of a `- key: value` item is read in parseSequence(), not parseMappingEntry(), so
  // it needs its own fold. Without one, `- reason: "wrapped` kept its dangling quote and the
  // continuation line reached parseSequence() as a non-`- ` entry: "Invalid YAML sequence".
  const parsed = parseYaml(`
packageReleases:
  - reason: "forms 0.8.2 depends on forms-core exactly 0.8.0,
      so the range stays pinned"
    name: '@nestledjs/data-browser'
    targetVersion: 1.0.19
`);

  assert.deepEqual(parsed.packageReleases, [
    {
      reason: 'forms 0.8.2 depends on forms-core exactly 0.8.0, so the range stays pinned',
      name: '@nestledjs/data-browser',
      targetVersion: '1.0.19'
    }
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
