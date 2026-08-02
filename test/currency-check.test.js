import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('currency check reports downstream catalog without promotion-source false positives', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-currency-'));
  const root = path.join(parent, 'nestled-upgrader');
  const projectA = path.join(parent, 'project-a');
  const projectB = path.join(parent, 'project-b');

  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });

  write(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: project-a
    path: ../project-a
  - name: project-b
    path: ../project-b
`);

  write(path.join(root, 'upgrades', '2026-01-downstream.yaml'), `
id: 2026-01-downstream
title: Downstream record
priority: normal
sourceRepo: nestled-template
`);
  write(path.join(root, 'upgrades', '2026-01-promotion-only.nestled-dev-template.yaml'), `
id: 2026-01-promotion-only
title: Promotion-only record
priority: normal
sourceRepo: nestled-dev-template
`);

  write(path.join(projectA, '.nestled', 'upgrade-log.yaml'), `
template:
  repo: nestled-template
upgrades:
  2026-01-downstream:
    status: applied
`);
  write(path.join(projectB, '.nestled', 'upgrade-log.yaml'), `
template:
  repo: nestled-template
upgrades:
  2026-01-downstream:
    status: applied
  2026-01-promotion-only:
    status: applied
`);

  const output = execFileSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'currency-check.mjs'), '--worktree'], {
    cwd: REPO_ROOT,
    env: { ...process.env, NESTLED_UPGRADER_ROOT: root },
    encoding: 'utf8'
  });

  assert.match(output, /Catalog: 1 upgrades/);
  assert.match(output, /project-a[\s\S]*missing: 0 \(na:0 present:0 \*\*review:0\*\*\)/);
  assert.match(output, /project-b[\s\S]*missing: 0 \(na:0 present:0 \*\*review:0\*\*\)/);
  assert.doesNotMatch(output, /REVIEW/);
  assert.doesNotMatch(output, /applied-but-not-in-catalog/);
  assert.match(output, /Summary:\*\* 0 entries across 0 repos need human review\./);
});
