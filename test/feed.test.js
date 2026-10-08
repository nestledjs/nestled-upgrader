import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFeedManifest, writeFeedManifest } from '../lib/feed.js';

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
