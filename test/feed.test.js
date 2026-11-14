import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishFeed, readFeedManifest, writeFeedManifest } from '../lib/feed.js';

test('rewriting a feed preserves numeric schema versions and string commit identifiers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-feed-yaml-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { template: { path: 'template' } };
  const directory = path.join(root, 'template', '.nestled-upgrades');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'manifest.yaml');
  fs.writeFileSync(file, 'schemaVersion: 1\nreleases:\n  - id: 2026.01.1\n    templateCommit: "1234567"\n');

  for (let cycle = 0; cycle < 3; cycle++) {
    const manifest = readFeedManifest(config, root);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.releases[0].templateCommit, '1234567');
    writeFeedManifest(config, manifest, root);
    const output = fs.readFileSync(file, 'utf8');
    assert.match(output, /^schemaVersion: 1$/m);
    assert.match(output, /^    templateCommit: "1234567"$/m);
  }
});

function feedFixture(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-feed-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(root, 'template', '.nestled-upgrades'), { recursive: true });
  for (const [id, body] of Object.entries(records)) {
    fs.writeFileSync(path.join(root, 'upgrades', `${id}.yaml`), `id: ${id}\ntitle: ${id}\nintent: Do it.\n${body}`);
  }
  return { root, config: { template: { path: 'template' } } };
}

test('feed-publish holds back a patch-delivery record that has no patch', t => {
  const { root, config } = feedFixture(t, {
    '2026-07-01-docs': 'delivery: code-patch\npatch:\n  path: patches/2026-07-01-docs.diff\n',
    '2026-07-01-stale': 'delivery: code-patch\npatchOmitted: No change matches this note.\n',
    '2026-07-01-hybrid': 'delivery: hybrid\npackageReleases:\n  - name: "@nestledjs/forms"\n    targetVersion: 1.0.0\n',
  });
  fs.writeFileSync(path.join(root, 'patches', '2026-07-01-docs.diff'), 'diff --git a/AGENTS.md b/AGENTS.md\n');

  const all = publishFeed(config, { dryRun: true }, root);
  assert.equal(all.dryRun, true);
  assert.deepEqual(all.notes, ['2026-07-01-docs']);
  assert.deepEqual(all.heldBack, [
    { id: '2026-07-01-hybrid', reason: 'delivery is hybrid but the record has no patch' },
    { id: '2026-07-01-stale', reason: 'No change matches this note.' },
  ]);

  const named = publishFeed(config, { dryRun: true, notes: ['2026-07-01-stale'] }, root);
  assert.equal(named.published, false);
  assert.equal(named.dryRun, undefined);
  assert.match(named.reason, /without a patch: 2026-07-01-stale/);
});

test('feed-publish refuses a patch that failed to generate, even in a dry run', t => {
  const { root, config } = feedFixture(t, {
    '2026-07-01-lockfile': 'delivery: code-patch\npatch:\n  path: patches/2026-07-01-lockfile.diff\n',
  });
  fs.writeFileSync(
    path.join(root, 'patches', '2026-07-01-lockfile.diff'),
    '# Unable to generate patch automatically: spawnSync git ENOBUFS\n',
  );

  for (const dryRun of [true, false]) {
    const result = publishFeed(config, { dryRun }, root);
    assert.equal(result.published, false);
    assert.match(result.reason, /Patch for 2026-07-01-lockfile failed to generate/);
  }
  assert.equal(fs.existsSync(path.join(root, 'template', '.nestled-upgrades', 'patches')), false);
});

function patched(root, id) {
  fs.writeFileSync(path.join(root, 'patches', `${id}.diff`), `diff --git a/${id} b/${id}\n`);
  return `delivery: code-patch\npatch:\n  path: patches/${id}.diff\n`;
}

test('feed-publish orders notes by applyAfter, then id', t => {
  const { root, config } = feedFixture(t, {});
  const write = (id, extra = '') =>
    fs.writeFileSync(path.join(root, 'upgrades', `${id}.yaml`), `id: ${id}\ntitle: ${id}\nintent: Do it.\n${patched(root, id)}${extra}`);
  // The follow-up sorts first by id but patches a file the spec note introduces.
  write('2026-07-01-a-follow-up', 'applyAfter:\n  - 2026-07-01-b-adds-spec\n');
  write('2026-07-01-b-adds-spec');
  write('2026-07-01-c-other');
  write('2026-07-02-d-single', 'applyAfter: 2026-07-01-c-other\n');

  const result = publishFeed(config, { dryRun: true }, root);
  assert.deepEqual(result.notes, ['2026-07-01-b-adds-spec', '2026-07-01-a-follow-up', '2026-07-01-c-other', '2026-07-02-d-single']);

  publishFeed(config, {}, root);
  const notes = readFeedManifest(config, root).releases[0].notes;
  assert.deepEqual(notes.map((note) => note.id), result.notes);
  assert.deepEqual(notes[1].applyAfter, ['2026-07-01-b-adds-spec']);
  assert.deepEqual(notes[3].applyAfter, ['2026-07-01-c-other']);
});

test('feed-publish refuses an applyAfter cycle or a prerequisite left out of the release', t => {
  const { root, config } = feedFixture(t, {});
  const write = (id, after) =>
    fs.writeFileSync(
      path.join(root, 'upgrades', `${id}.yaml`),
      `id: ${id}\ntitle: ${id}\nintent: Do it.\n${patched(root, id)}${after ? `applyAfter: ${after}\n` : ''}`,
    );
  write('2026-07-01-a', '2026-07-01-b');
  write('2026-07-01-b', '2026-07-01-a');
  write('2026-07-01-c');
  write('2026-07-01-d', '2026-07-01-c');
  write('2026-07-01-e', '2026-06-01-nonexistent');

  const cycle = publishFeed(config, { dryRun: true, notes: ['2026-07-01-a', '2026-07-01-b'] }, root);
  assert.equal(cycle.published, false);
  assert.deepEqual(cycle.cycle, ['2026-07-01-a', '2026-07-01-b']);
  assert.match(cycle.reason, /cycle among 2026-07-01-a, 2026-07-01-b/);

  const leftOut = publishFeed(config, { dryRun: true, notes: ['2026-07-01-d'] }, root);
  assert.equal(leftOut.published, false);
  assert.match(leftOut.reason, /2026-07-01-d applies after 2026-07-01-c, which is not published and not in this release/);

  const unknown = publishFeed(config, { dryRun: true, notes: ['2026-07-01-e'] }, root);
  assert.match(unknown.reason, /2026-07-01-e applies after 2026-06-01-nonexistent, which is not a known note/);

  // A prerequisite already published is satisfied.
  const ok = publishFeed(config, { notes: ['2026-07-01-c'] }, root);
  assert.equal(ok.published, true);
  assert.deepEqual(publishFeed(config, { dryRun: true, notes: ['2026-07-01-d'] }, root).notes, ['2026-07-01-d']);
});

test('feed-publish carries agentHints and skipIf into the manifest entry', t => {
  const { root, config } = feedFixture(t, {});
  const id = '2026-07-01-hints';
  fs.writeFileSync(
    path.join(root, 'upgrades', `${id}.yaml`),
    `id: ${id}\ntitle: ${id}\nintent: Do it.\n${patched(root, id)}` +
      'skipIf:\n  - Project has its own client-side conversion.\n' +
      'agentHints:\n  - Also skip list-valued fields.\n  - Register each sharded coverage report.\n',
  );
  fs.writeFileSync(path.join(root, 'upgrades', '2026-07-01-empty.yaml'), `id: 2026-07-01-empty\ntitle: t\nintent: i\n${patched(root, '2026-07-01-empty')}skipIf: []\n`);
  assert.equal(publishFeed(config, {}, root).published, true);
  const notes = readFeedManifest(config, root).releases[0].notes;
  const hinted = notes.find((note) => note.id === id);
  assert.deepEqual(hinted.skipIf, ['Project has its own client-side conversion.']);
  assert.deepEqual(hinted.agentHints, ['Also skip list-valued fields.', 'Register each sharded coverage report.']);
  const empty = notes.find((note) => note.id === '2026-07-01-empty');
  assert.equal('skipIf' in empty, false);
  assert.equal('agentHints' in empty, false);
});
