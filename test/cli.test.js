import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.js';

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
  const parsed = parseArgs(['apply', '--project', 'muzebook', '--upgrade', 'some-id']);
  assert.equal(parsed.project, 'muzebook');
  assert.equal(parsed.upgrade, 'some-id');
});

test('an unrecognized flag still consumes the next token (documents the failure mode)', () => {
  // This is the trap BOOLEAN_FLAGS exists to avoid for flags that are actually booleans: any
  // flag NOT in the whitelist is assumed to take a value, silently eating whatever follows it.
  const parsed = parseArgs(['fleet-update', '--not-a-real-flag', '--dry-run']);
  assert.equal(parsed.notARealFlag, '--dry-run');
  assert.equal(parsed.dryRun, undefined);
});
