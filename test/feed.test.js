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
