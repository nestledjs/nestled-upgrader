import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, printSyncResult } from '../lib/cli.js';
import { COMMANDS, UsageError } from '../lib/cli-args.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nestled-upgrader.js');

// `--pr --dry-run` once parsed as `pr: "--dry-run"` (truthy) with `dryRun` never set at all,
// because `--pr` was missing from the boolean-flag whitelist: an unrecognized `--x` flag consumes
// the NEXT token as its value instead of erroring. That silently turned a requested dry run of
// `fleet-update` into a real run across the fleet.
test('a boolean flag followed by another flag does not swallow it as a value', () => {
  const parsed = parseArgs(['fleet-update', '--pr', '--dry-run']);
  assert.equal(parsed.pr, true);
  assert.equal(parsed.dryRun, true);
});

test('every boolean flag parses independently of order and neighbors', () => {
  const parsed = parseArgs(['upgrade', '--all', '--dry-run', '--allow-dirty']);
  assert.equal(parsed.all, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.allowDirty, true);
});

test('a value flag still consumes the following token', () => {
  const parsed = parseArgs(['apply', '--project', 'project-a', '--upgrade', 'some-id']);
  assert.equal(parsed.project, 'project-a');
  assert.equal(parsed.upgrade, 'some-id');
});

// An unrecognized flag used to be treated as a value flag and otherwise ignored, so
// `feed-publish --help` ran a real publish with default options and committed a feed release.
test('an unknown flag is rejected, naming the flag and the command usage', () => {
  assert.throws(
    () => parseArgs(['fleet-update', '--not-a-real-flag', '--dry-run']),
    (error) =>
      error instanceof UsageError &&
      /Unknown option for fleet-update: --not-a-real-flag/.test(error.message) &&
      /Usage: nestled-upgrader fleet-update /.test(error.message)
  );
});

test('a flag valid for one command is rejected by a command that does not take it', () => {
  assert.throws(() => parseArgs(['feed-promote', '--channel', 'canary']), /Unknown option for feed-promote: --channel/);
  assert.throws(() => parseArgs(['status', '--dry-run']), /Unknown option for status: --dry-run/);
});

test('a value flag with no value does not swallow the next flag', () => {
  assert.throws(() => parseArgs(['feed-publish', '--note', '--push']), /Option --note requires a value/);
  assert.throws(() => parseArgs(['feed-promote', '--to']), /Option --to requires a value/);
});

test('a value flag given twice is rejected rather than keeping only the last value', () => {
  assert.throws(
    () => parseArgs(['feed-publish', '--note', 'note-a', '--note', 'note-b']),
    /Option --note was given more than once; pass one comma-separated list: --note <id>\[,<id>\]/,
  );
  assert.throws(() => parseArgs(['feed-publish', '--note=note-a', '--note', 'note-b']), /--note was given more than once/);
  assert.throws(() => parseArgs(['feed-promote', '--to', 'stable', '--to', 'canary']), /Option --to was given more than once\n/);
  assert.deepEqual(parseArgs(['feed-publish', '--note', 'note-a,note-b']).note, 'note-a,note-b');
});

test('unexpected positional arguments are rejected; declared ones are kept', () => {
  assert.throws(() => parseArgs(['feed-publish', 'canary']), /Unexpected argument for feed-publish: canary/);
  assert.deepEqual(parseArgs(['convergence-status', 'project-a'])._, ['convergence-status', 'project-a']);
  assert.throws(() => parseArgs(['convergence-status', 'project-a', 'project-b']), /Unexpected argument/);
});

test('an unknown command is rejected, including names inherited from Object.prototype', async () => {
  assert.throws(() => parseArgs(['feed-publsh']), /Unknown command: feed-publsh/);
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => parseArgs([name]), new RegExp(`Unknown command: ${name}`));
    const { calls, deps } = recordingDeps();
    await assert.rejects(main([name], deps), /Unknown command/);
    await assert.rejects(main(['help', name], deps), /Unknown command/);
    assert.deepEqual(calls, []);
  }
});

test('--help and -h are accepted by every command, even alongside invalid input', () => {
  for (const command of Object.keys(COMMANDS)) {
    assert.equal(parseArgs([command, '--help']).help, true, command);
    assert.equal(parseArgs([command, '-h']).help, true, command);
  }
  assert.equal(parseArgs(['feed-publish', '--bogus', '--help']).help, true);
});

test('every documented flag of feed-publish and feed-promote still parses', () => {
  assert.deepEqual(
    parseArgs([
      'feed-publish', '--channel', 'beta', '--title', 'A release', '--note', 'a,b',
      '--push', '--dry-run', '--allow-identifying'
    ]),
    { _: ['feed-publish'], channel: 'beta', title: 'A release', note: 'a,b', push: true, dryRun: true, allowIdentifying: true }
  );
  assert.deepEqual(
    parseArgs(['feed-promote', '--to', 'stable', '--release', '2026.01.1', '--push']),
    { _: ['feed-promote'], to: 'stable', release: '2026.01.1', push: true }
  );
  assert.equal(parseArgs(['feed-promote', '--release=2026.01.1']).release, '2026.01.1');
  assert.throws(() => parseArgs(['feed-promote', '--push=yes']), /--push does not take a value/);
});

test('the flags the docs use for other commands still parse', () => {
  assert.equal(parseArgs(['promote-template', '--dry-run', '--allow-dirty']).allowDirty, true);
  assert.equal(parseArgs(['run', '--dry-run-only', '--allow-dirty']).dryRunOnly, true);
  assert.equal(parseArgs(['status', '--project', 'project-a']).project, 'project-a');
  assert.equal(parseArgs(['format-logs', '--check', '--project', 'project-a']).check, true);
  assert.equal(parseArgs(['retire-upgrade-records', '--all', '--dry-run']).all, true);
  assert.equal(parseArgs(['create-upgrade', '--from', 'abc', '--to', 'def']).to, 'def');
  assert.equal(parseArgs(['report-upstream', '--title', 't', '--description', 'd', '--security']).security, true);
  assert.equal(parseArgs(['baseline-fleet', '--at', '2026.01.1', '--channel', 'canary', '--ref', 'develop']).at, '2026.01.1');
  assert.equal(parseArgs(['fleet-update', '--bin', 'npx x', '--verify', 'npm test', '--pr']).verify, 'npm test');
});

// Stubs for every collaborator that reads config or touches git. A rejected or help-only
// invocation must reach none of them.
function recordingDeps() {
  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return value;
  };
  return {
    calls,
    deps: {
      loadConfig: record('loadConfig', { projects: [], template: { path: 'template' } }),
      loadUpgrades: record('loadUpgrades', []),
      publishFeed: record('publishFeed', { published: false, reason: 'stubbed' }),
      promoteFeed: record('promoteFeed', { promoted: false, reason: 'stubbed' })
    }
  };
}

for (const command of ['feed-publish', 'feed-promote']) {
  test(`${command} with an unknown flag exits with an error and does nothing`, async (t) => {
    t.mock.method(console, 'log', () => {});
    const { calls, deps } = recordingDeps();
    await assert.rejects(main([command, '--bogus'], deps), /Unknown option for .*: --bogus/);
    assert.deepEqual(calls, []);
  });

  test(`${command} --help prints usage and does nothing`, async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const { calls, deps } = recordingDeps();
    for (const flag of ['--help', '-h']) await main([command, flag], deps);
    assert.deepEqual(calls, []);
    assert.equal(log.mock.callCount(), 2);
    const output = log.mock.calls[0].arguments[0];
    assert.match(output, new RegExp(`^Usage: nestled-upgrader ${command} `));
    assert.match(output, /--push +Push the template commit/);
  if (command === 'feed-publish') assert.match(output, /--title "\.\.\." +Release title \(default: "Release <release id>"\)/);
  });
}

test('feed-publish passes valid flags through to the publisher unchanged', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { calls, deps } = recordingDeps();
  await main(['feed-publish', '--title', 'T', '--note', 'a, b', '--push', '--dry-run', '--allow-identifying'], deps);
  const publish = calls.find((call) => call.name === 'publishFeed');
  assert.deepEqual(publish.args[1], {
    channel: 'canary',
    title: 'T',
    push: true,
    dryRun: true,
    notes: ['a', 'b'],
    allowIdentifying: true
  });
});

test('feed-promote passes valid flags through to the promoter unchanged', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { calls, deps } = recordingDeps();
  await main(['feed-promote', '--release', '2026.01.1'], deps);
  const promote = calls.find((call) => call.name === 'promoteFeed');
  assert.deepEqual(promote.args[1], { toChannel: 'stable', release: '2026.01.1', push: undefined });
});

test('help <command> prints that command\'s usage; bare help lists every command', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { calls, deps } = recordingDeps();
  await main(['help', 'run'], deps);
  await main([], deps);
  assert.deepEqual(calls, []);
  assert.match(log.mock.calls[0].arguments[0], /^Usage: nestled-upgrader run \[--dry-run-only\] \[--allow-dirty\]/);
  for (const command of Object.keys(COMMANDS)) assert.match(log.mock.calls[1].arguments[0], new RegExp(`\\n  ${command}\\b`));
});

// End to end through the real binary: exit codes and streams. Neither invocation reaches config
// loading, so this is safe to run anywhere.
test('the binary exits 0 for --help and non-zero for an unknown flag', () => {
  const help = spawnSync(process.execPath, [BIN, 'feed-publish', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: nestled-upgrader feed-publish /);

  const bad = spawnSync(process.execPath, [BIN, 'feed-promote', '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option for feed-promote: --bogus/);
  assert.match(bad.stderr, /Usage: nestled-upgrader feed-promote /);
  assert.doesNotMatch(bad.stderr, /upgrader\.config\.yaml/);
});

test('sync output names edited notes and unclaimed paths even when nothing was created', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  printSyncResult({
    created: false,
    reason: 'No new upgrade notes in a..b; existing record(s) kept unchanged for edited note(s): n1, n2.',
    changedNotes: ['n1', 'n2'],
    unclaimedPaths: ['apps/api/main.ts']
  });
  const output = log.mock.calls.map((call) => call.arguments[0]).join('\n');
  assert.match(output, /kept unchanged: n1, n2/);
  assert.match(output, /claims \(in no patch\):\n  - apps\/api\/main\.ts/);
});
