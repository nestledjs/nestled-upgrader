import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  addDiscoveredProjects,
  applyUpgrade,
  downstreamProjects,
  findUpgrade,
  initializeAllLogs,
  loadConfig,
  loadUpgrades,
  mirrorTemplateFromSource,
  normalizeUpgradeLogs,
  planAll,
  promoteTemplate,
  readUpgradeLog,
  reportForProject,
  runWorkflow,
  summarizeProject,
  syncPackagesFromPromotion,
  syncTemplate,
  inspectPlan,
  upgradeAll,
  writeExtractionRecommendations,
  writeUpgradeLog
} from '../lib/upgrader.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'downstream', 'project-a', '.nestled'), { recursive: true });
  fs.mkdirSync(path.join(root, 'downstream', 'project-a', 'apps/api/src/auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: project-a
    path: downstream/project-a
    defaultBranch: main
    forkedAreas:
      - auth
    verification:
      - pnpm lint
`);
  fs.writeFileSync(path.join(root, 'legacy-upgrade-aliases.yaml'), `
aliases:
  2026-05-13-auth-session-hardening:
    - 2026-05-13-auth-hardening-old
`);
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-13-auth-session-hardening.yaml'), `
id: 2026-05-13-auth-session-hardening
title: Auth session hardening
priority: high
area: auth
type: security
delivery: code-patch
intent: >
  Ensure expired sessions are rejected consistently.
affectedPaths:
  - apps/api/src/auth/**
patch:
  path: patches/2026-05-13-auth-session-hardening.diff
verification:
  - pnpm lint
`);
  return root;
}

test('loads config and upgrade records', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrades = loadUpgrades(root);
  assert.equal(config.projects[0].name, 'project-a');
  assert.equal(upgrades[0].id, '2026-05-13-auth-session-hardening');
});

test('does not rewrite config when project discovery finds no new projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), [
    'template:',
    '  name: nestled-template',
    '  path: ../nestled-template',
    '# Keep this operator note intact.',
    'projects: []',
    ''
  ].join('\n'));
  const before = fs.readFileSync(path.join(root, 'upgrader.config.yaml'), 'utf8');

  const config = loadConfig(root);
  const discovered = addDiscoveredProjects(config, root);

  assert.deepEqual(discovered, []);
  assert.equal(fs.readFileSync(path.join(root, 'upgrader.config.yaml'), 'utf8'), before);
});

test('summarizes project statuses from downstream log', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrades = loadUpgrades(root);
  writeUpgradeLog(config.projects[0], {
    template: { repo: 'nestled-template' },
    upgrades: {
      '2026-05-13-auth-session-hardening': { status: 'skipped', reason: 'Custom auth.' }
    }
  }, root);

  const log = readUpgradeLog(config.projects[0], root);
  assert.equal(log.upgrades['2026-05-13-auth-session-hardening'].status, 'skipped');
  assert.equal(summarizeProject(config.projects[0], upgrades, root).counts.skipped, 1);
});

test('recognizes declared legacy ids as completed upgrade log entries', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrades = loadUpgrades(root);
  writeUpgradeLog(config.projects[0], {
    template: { repo: 'nestled-template' },
    upgrades: {
      '2026-05-13-auth-hardening-old': { status: 'adapted', notes: 'Historical hand-written id.' }
    }
  }, root);

  const summary = summarizeProject(config.projects[0], upgrades, root);
  assert.equal(summary.counts.adapted, 1);
  assert.deepEqual(summary.orphans, []);
  assert.equal(inspectPlan(config.projects[0], upgrades[0], root).recommendation, 'no-op');
  assert.equal(upgradeAll(config, upgrades, root)[0].recommendation, 'no-op');
  assert.match(reportForProject(config.projects[0], upgrades, root), /2026-05-13-auth-session-hardening: adapted/);
});

test('findUpgrade prefers the downstream record when a legacy id matches both pipelines', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-13-auth-session-hardening.nestled-dev-template.yaml'), `
id: 2026-05-13-auth-session-hardening
title: Auth session hardening promotion
priority: high
area: auth
type: security
delivery: code-patch
sourceRepo: nestled-dev-template
intent: Promotion source record.
affectedPaths: []
verification: []
`);

  const upgrade = findUpgrade(loadUpgrades(root), '2026-05-13-auth-hardening-old');
  assert.equal(upgrade.id, '2026-05-13-auth-session-hardening');
  assert.equal(upgrade.sourceRepo || 'nestled-template', 'nestled-template');
  assert.equal(path.basename(upgrade.recordPath), '2026-05-13-auth-session-hardening.yaml');
});

test('does not report source-scoped catalog records as orphaned log entries', () => {
  const root = fixture();
  const config = loadConfig(root);
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-17-promotion-only.nestled-dev-template.yaml'), `
id: 2026-05-17-promotion-only
title: Promotion only
priority: normal
area: auth
type: security
delivery: code-patch
sourceRepo: nestled-dev-template
intent: Promotion source record.
affectedPaths: []
verification: []
`);
  const catalog = loadUpgrades(root);
  const downstream = catalog.filter((upgrade) => !upgrade.sourceRepo || upgrade.sourceRepo === 'nestled-template');
  writeUpgradeLog(config.projects[0], {
    template: { repo: 'nestled-template' },
    upgrades: {
      '2026-05-17-promotion-only': { status: 'applied' }
    }
  }, root);

  const summary = summarizeProject(config.projects[0], downstream, root, catalog);
  assert.equal(summary.counts.pending, 1);
  assert.deepEqual(summary.orphans, []);
});

test('plans forked areas as adapt or review', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrade = loadUpgrades(root)[0];
  const plan = inspectPlan(config.projects[0], upgrade, root);
  assert.equal(plan.recommendation, 'adapt-or-review');
  assert.equal(plan.affectedPaths[0].exists, true);
});

test('plans package delivery as a dependency bump instead of direct patching', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrade = {
    id: '2026-05-13-shared-auth',
    area: 'auth',
    delivery: 'package-release',
    packageReleases: [{
      name: '@nestledjs/auth',
      sourcePath: 'libs/auth',
      targetVersion: '1.1.0',
      versionRange: '^1.1.0'
    }],
    affectedPaths: ['apps/api/src/auth/**']
  };
  const plan = inspectPlan(config.projects[0], upgrade, root);
  assert.equal(plan.recommendation, 'package-release');
  assert.match(plan.reason, /@nestledjs\/auth/);
});

test('blocks package delivery while release version is unresolved', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrade = {
    id: '2026-05-13-shared-components',
    area: 'ui',
    delivery: 'package-release',
    packageReleases: [{
      name: '@nestledjs/shared-components',
      sourcePath: 'libs/shared-components'
    }]
  };
  const plan = inspectPlan(config.projects[0], upgrade, root);
  assert.equal(plan.recommendation, 'pending-release');
});

test('discovers sibling projects and initializes local logs', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const project = path.join(parent, 'project-b');
  const unrelated = path.join(parent, 'unrelated-tool');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"project-b-nestled","scripts":{"test":"node --version"}}');
  fs.writeFileSync(path.join(unrelated, 'package.json'), '{"name":"unrelated-tool"}');
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects: []
`);

  const config = loadConfig(root);
  const discovered = addDiscoveredProjects(config, root);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'project-b');
  assert.ok(fs.existsSync(path.join(project, '.nestled', 'upgrade-log.yaml')));
});

test('bulk log initialization skips template promotion targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  const template = path.join(root, 'nestled-template');
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(template, '.nestled'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: nestled-template
    defaultBranch: main
    role: template-promotion
  - name: project-a
    path: project-a
    defaultBranch: main
`);
  const templateLogPath = path.join(template, '.nestled', 'upgrade-log.yaml');
  const originalTemplateLog = [
    'template:',
    '  repo: nestled-template',
    'upgrades:',
    '  old-template-decision:',
    '    status: blocked',
    "    reviewedAt: '2026-07-31T00:00:00.000Z'",
    ''
  ].join('\n');
  fs.writeFileSync(templateLogPath, originalTemplateLog);

  const config = loadConfig(root);
  const initialized = initializeAllLogs(config, root);

  assert.deepEqual(downstreamProjects(config).map((item) => item.name), ['project-a']);
  assert.deepEqual(initialized.map((item) => item.project), ['project-a']);
  assert.equal(fs.readFileSync(templateLogPath, 'utf8'), originalTemplateLog);
  assert.ok(fs.existsSync(path.join(project, '.nestled', 'upgrade-log.yaml')));
});

test('normalizes downstream upgrade logs without touching template promotion ledgers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  const template = path.join(root, 'nestled-template');
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(template, '.nestled'), { recursive: true });
  fs.mkdirSync(path.join(project, '.nestled'), { recursive: true });
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: nestled-template
    defaultBranch: main
    role: template-promotion
  - name: project-a
    path: project-a
    defaultBranch: main
`);
  const templateLogPath = path.join(template, '.nestled', 'upgrade-log.yaml');
  const projectLogPath = path.join(project, '.nestled', 'upgrade-log.yaml');
  const templateLog = [
    'template:',
    '  repo: nestled-template',
    'upgrades:',
    '  old-template-decision:',
    '    status: blocked',
    "    reviewedAt: '2026-07-31T00:00:00.000Z'",
    ''
  ].join('\n');
  const nonCanonicalProjectLog = [
    'template:',
    '  repo: nestled-template',
    'upgrades:',
    '  2026-07-31-backlog:',
    '    status: adapted',
    "    reviewedAt: '2026-07-31T00:00:00.000Z'",
    '    notes: "Already implemented here; no change made."',
    ''
  ].join('\n');
  fs.writeFileSync(templateLogPath, templateLog);
  fs.writeFileSync(projectLogPath, nonCanonicalProjectLog);

  const config = loadConfig(root);
  const check = normalizeUpgradeLogs(config, root, { check: true });
  assert.deepEqual(check.map((item) => [item.project, item.changed, item.skipped || false]), [
    ['project-a', true, false]
  ]);
  assert.equal(fs.readFileSync(projectLogPath, 'utf8'), nonCanonicalProjectLog);

  const result = normalizeUpgradeLogs(config, root);
  assert.deepEqual(result.map((item) => [item.project, item.changed, item.skipped || false]), [
    ['project-a', true, false]
  ]);
  assert.equal(fs.readFileSync(templateLogPath, 'utf8'), templateLog);
  assert.equal(fs.readFileSync(projectLogPath, 'utf8'), [
    'template:',
    '  repo: nestled-template',
    'upgrades:',
    '  2026-07-31-backlog:',
    '    status: adapted',
    '    reviewedAt: "2026-07-31T00:00:00.000Z"',
    '    notes: Already implemented here; no change made.',
    ''
  ].join('\n'));

  const secondCheck = normalizeUpgradeLogs(config, root, { check: true });
  assert.equal(secondCheck[0].changed, false);
});

test('plans every project and upgrade in one dry-run', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrades = loadUpgrades(root);
  initializeAllLogs(config, root);
  const plans = planAll(config, upgrades, root);
  assert.equal(plans.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'reports', 'upgrade-rollup.md')));
});

test('dry-run planning preserves existing reports for already recorded upgrades', () => {
  const root = fixture();
  const config = loadConfig(root);
  const upgrades = loadUpgrades(root);
  writeUpgradeLog(config.projects[0], {
    template: { repo: 'nestled-template' },
    upgrades: {
      '2026-05-13-auth-session-hardening': { status: 'adapted', notes: 'Completed with local changes.' }
    }
  }, root);
  const reportPath = path.join(root, 'reports', 'project-a', '2026-05-13-auth-session-hardening.md');
  const report = [
    '# Auth session hardening',
    '',
    'Mode: apply',
    'Outcome: adapted',
    'Detailed adaptation notes that should not be replaced by a no-op dry-run report.',
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);

  const plans = planAll(config, upgrades, root);

  assert.equal(plans[0].recommendation, 'no-op');
  assert.equal(fs.readFileSync(reportPath, 'utf8'), report);
});

test('applies a clean patch on an upgrade branch and records history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  const project = path.join(root, 'project-a');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hello\n');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'user.name', 'Test User']);
  git(project, ['config', 'commit.gpgsign', 'false']);
  git(project, ['add', 'hello.txt']);
  git(project, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: project-a
    path: project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
`);
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-13-hello.yaml'), `
id: 2026-05-13-hello
title: Hello
priority: normal
area: docs
type: cleanup
delivery: code-patch
intent: Change hello text.
affectedPaths:
  - hello.txt
patch:
  path: patches/2026-05-13-hello.diff
verification: []
`);
  fs.writeFileSync(path.join(root, 'patches', '2026-05-13-hello.diff'), `diff --git a/hello.txt b/hello.txt
index ce01362..94954ab 100644
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-hello
+hello upgraded
`);

  const config = loadConfig(root);
  const upgrade = loadUpgrades(root)[0];
  const result = applyUpgrade(config.projects[0], upgrade, config, root);
  const log = readUpgradeLog(config.projects[0], root);
  assert.equal(result.patch.applied, true);
  assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hello upgraded\n');
  assert.equal(log.upgrades['2026-05-13-hello'].status, 'applied');
  assert.equal(gitOutput(project, ['branch', '--show-current']), 'nestled-upgrade/2026-05-13-hello');
  assert.equal(gitOutput(project, ['status', '--porcelain']), '');
});

test('template promotion excludes package manifests and package source from raw patches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  const project = path.join(root, 'nestled-template');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(project, 'libs', 'data-browser', 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'app.txt'), 'app one\n');
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"nestled-template","scripts":{"test":"old"}}\n');
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(project, 'libs', 'data-browser', 'src', 'index.ts'), 'export const value = 1;\n');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'user.name', 'Test User']);
  git(project, ['config', 'commit.gpgsign', 'false']);
  git(project, ['add', 'app.txt', 'package.json', 'pnpm-lock.yaml', 'libs/data-browser/src/index.ts']);
  git(project, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-dev-template
  path: ../nestled-dev-template
  mainBranch: main
projects:
  - name: nestled-template
    path: nestled-template
    defaultBranch: main
    role: template-promotion
    promotion:
      rawPatchExcludes:
        - package.json
        - pnpm-lock.yaml
        - libs/data-browser/**
    forkedAreas: []
    verification: []
`);
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-15-promote.yaml'), `
id: 2026-05-15-promote
title: Promote template
priority: normal
area: web
type: cleanup
delivery: code-patch
intent: Bring allowed template app code forward.
affectedPaths:
  - app.txt
  - package.json
  - pnpm-lock.yaml
  - libs/data-browser/**
patch:
  path: patches/2026-05-15-promote.diff
verification: []
`);
  fs.writeFileSync(path.join(root, 'patches', '2026-05-15-promote.diff'), `diff --git a/app.txt b/app.txt
index 8128ed5..e376fb9 100644
--- a/app.txt
+++ b/app.txt
@@ -1 +1 @@
-app one
+app two
diff --git a/package.json b/package.json
index ce02f7c..a1f7f08 100644
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name":"nestled-template","scripts":{"test":"old"}}
+{"name":"nestled-template","scripts":{"test":"new"}}
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 85f38f9..b2b3d13 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: 9.0
+lockfileVersion: 10.0
diff --git a/libs/data-browser/src/index.ts b/libs/data-browser/src/index.ts
index de213b3..328931a 100644
--- a/libs/data-browser/src/index.ts
+++ b/libs/data-browser/src/index.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`);

  const config = loadConfig(root);
  const upgrade = loadUpgrades(root)[0];
  const result = applyUpgrade(config.projects[0], upgrade, config, root);
  assert.equal(result.patch.applied, true);
  assert.equal(fs.readFileSync(path.join(project, 'app.txt'), 'utf8'), 'app two\n');
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), '{"name":"nestled-template","scripts":{"test":"old"}}\n');
  assert.equal(fs.readFileSync(path.join(project, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n');
  assert.equal(fs.readFileSync(path.join(project, 'libs', 'data-browser', 'src', 'index.ts'), 'utf8'), 'export const value = 1;\n');
  assert.ok(result.patch.excludedPaths.includes('package.json'));
  assert.ok(result.patch.excludedPaths.includes('libs/data-browser/**'));
});

test('template promotion blocks code patches that only touch excluded paths', () => {
  const root = fixture();
  const project = {
    name: 'nestled-template',
    path: 'downstream/project-a',
    role: 'template-promotion',
    rawPatchExcludes: ['package.json'],
    forkedAreas: [],
    verification: []
  };
  const upgrade = {
    id: '2026-05-15-package-json-only',
    area: 'infra',
    delivery: 'code-patch',
    affectedPaths: ['package.json']
  };

  const plan = inspectPlan(project, upgrade, root);
  assert.equal(plan.recommendation, 'blocked');
  assert.match(plan.reason, /excluded from raw promotion/);
});

test('sync-template baselines first run and creates an upgrade after template moves', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const template = path.join(parent, 'nestled-template');
  const project = path.join(parent, 'project-a');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(path.join(template, 'README.md'), 'one\n');
  git(template, ['init']);
  git(template, ['config', 'user.email', 'test@example.com']);
  git(template, ['config', 'user.name', 'Test User']);
  git(template, ['config', 'commit.gpgsign', 'false']);
  git(template, ['add', 'README.md']);
  git(template, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: project-a
    path: ../project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
`);

  const config = loadConfig(root);
  const baseline = syncTemplate(config, root);
  assert.equal(baseline.created, false);
  fs.writeFileSync(path.join(template, 'README.md'), 'two\n');
  git(template, ['add', 'README.md']);
  git(template, ['commit', '-m', 'update readme']);
  const created = syncTemplate(config, root);
  assert.equal(created.created, true);
  assert.equal(loadUpgrades(root).length, 1);
});

test('sync-template skips metadata-only .nestled changes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(template, '.nestled'), { recursive: true });
  fs.writeFileSync(path.join(template, 'README.md'), 'template\n');
  git(template, ['init']);
  git(template, ['config', 'user.email', 'test@example.com']);
  git(template, ['config', 'user.name', 'Test User']);
  git(template, ['config', 'commit.gpgsign', 'false']);
  git(template, ['add', '.']);
  git(template, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects: []
`);

  const config = loadConfig(root);
  syncTemplate(config, root);
  fs.writeFileSync(path.join(template, '.nestled', 'upgrade-log.yaml'), 'upgrades: {}\n');
  git(template, ['add', '.nestled/upgrade-log.yaml']);
  git(template, ['commit', '-m', 'add template ledger']);

  const result = syncTemplate(config, root);

  assert.equal(result.created, false);
  assert.match(result.reason, /\.nestled metadata/);
  assert.equal(loadUpgrades(root).length, 0);
});

test('sync-template copies upgrade notes from dev template contract', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const template = path.join(parent, 'nestled-dev-template');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(template, '.nestled-updates', 'upgrade-notes'), { recursive: true });
  fs.writeFileSync(path.join(template, 'README.md'), 'one\n');
  git(template, ['init']);
  git(template, ['config', 'user.email', 'test@example.com']);
  git(template, ['config', 'user.name', 'Test User']);
  git(template, ['config', 'commit.gpgsign', 'false']);
  git(template, ['add', 'README.md']);
  git(template, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-dev-template
  path: ../nestled-dev-template
  mainBranch: main
projects: []
`);
  const config = loadConfig(root);
  syncTemplate(config, root);
  fs.writeFileSync(path.join(template, '.nestled-updates', 'upgrade-notes', '2026-05-13-data-browser.yaml'), `
id: 2026-05-13-data-browser
title: Data browser release
priority: normal
area: data-browser
type: deps
delivery: package-release
packageReleases:
  - name: '@nestledjs/data-browser'
    sourcePath: libs/data-browser
    targetVersion: 1.1.0
    versionRange: ^1.1.0
intent: Use the package.
why: Package contains the implementation.
`);
  git(template, ['add', '.nestled-updates/upgrade-notes/2026-05-13-data-browser.yaml']);
  git(template, ['commit', '-m', 'add data browser upgrade note']);

  const result = syncTemplate(config, root);
  const upgrade = loadUpgrades(root)[0];
  assert.equal(result.created, true);
  assert.equal(upgrade.id, '2026-05-13-data-browser');
  assert.equal(upgrade.delivery, 'package-release');
  assert.equal(upgrade.packageReleases[0].name, '@nestledjs/data-browser');
  assert.equal(upgrade.sourceRepo, 'nestled-dev-template');
});

test('promotion uses dev-template while downstream sync uses nestled-template', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  const project = path.join(parent, 'project-a');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'README.md'), 'dev one\n');
  fs.writeFileSync(path.join(template, 'README.md'), 'template one\n');
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  for (const repo of [devTemplate, template]) {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
  - name: project-a
    path: ../project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  promoteTemplate(config, root, { dryRun: true });
  syncTemplate(config, root);
  fs.writeFileSync(path.join(devTemplate, 'README.md'), 'dev two\n');
  git(devTemplate, ['add', 'README.md']);
  git(devTemplate, ['commit', '-m', 'update dev']);
  fs.writeFileSync(path.join(template, 'README.md'), 'template two\n');
  git(template, ['add', 'README.md']);
  git(template, ['commit', '-m', 'update template']);

  const promotion = promoteTemplate(config, root, { dryRun: true });
  const downstream = syncTemplate(config, root);
  const upgrades = loadUpgrades(root);
  const downstreamPlans = planAll(config, upgrades, root);

  assert.equal(promotion.sync.created, true);
  assert.equal(downstream.created, true);
  assert.ok(upgrades.some((upgrade) => upgrade.sourceRepo === 'nestled-dev-template'));
  assert.ok(upgrades.some((upgrade) => upgrade.sourceRepo === 'nestled-template'));
  assert.equal(downstreamPlans.length, 1);
  assert.equal(downstreamPlans[0].project, 'project-a');
  assert.equal(upgrades.find((upgrade) => upgrade.id === downstreamPlans[0].upgrade).sourceRepo, 'nestled-template');
});

test('a note id promoted to the template still yields a downstream-eligible record', () => {
  // Regression: promotion used to grab the unscoped upgrades/<id>.yaml slot, so
  // downstream sync skipped creating its own nestled-template-sourced record and
  // the fix never reached product projects. Promotion records are now source-scoped.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-collision-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  const project = path.join(parent, 'project-a');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  for (const repo of [devTemplate, template]) {
    fs.mkdirSync(path.join(repo, '.nestled-updates', 'upgrade-notes'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
  - name: project-a
    path: ../project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  // Baseline both pipelines at the initial commit.
  promoteTemplate(config, root, { dryRun: true });
  syncTemplate(config, root);

  // The identical upgrade note lands in BOTH the dev template and the template.
  const note = [
    'id: 2026-06-21-shared-fix',
    'title: Shared fix',
    'priority: normal',
    'area: web',
    'type: correctness',
    'delivery: code-patch',
    'intent: Apply the shared fix.',
    'affectedPaths:',
    '  - README.md',
    'verification: []',
    ''
  ].join('\n');
  for (const repo of [devTemplate, template]) {
    fs.writeFileSync(path.join(repo, '.nestled-updates', 'upgrade-notes', '2026-06-21-shared-fix.yaml'), note);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add shared-fix note']);
  }
  publishDevTemplate(devTemplate);

  // Promotion runs first (as in the real workflow), then downstream sync.
  promoteTemplate(config, root, { dryRun: true });
  syncTemplate(config, root);
  const upgrades = loadUpgrades(root);

  const promotionRecord = upgrades.find(
    (u) => u.id === '2026-06-21-shared-fix' && u.sourceRepo === 'nestled-dev-template'
  );
  const downstreamRecord = upgrades.find(
    (u) => u.id === '2026-06-21-shared-fix' && u.sourceRepo === 'nestled-template'
  );
  assert.ok(promotionRecord, 'promotion record should exist');
  assert.ok(downstreamRecord, 'downstream-eligible record must exist for the shared note id');

  const plans = planAll(config, upgrades, root);
  assert.ok(
    plans.some((p) => p.project === 'project-a' && p.upgrade === '2026-06-21-shared-fix'),
    'product project must be planned against the shared note upgrade'
  );
});

test('run workflow is safe on first run with no template delta', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-parent-'));
  const root = path.join(parent, 'nestled-upgrader');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, 'README.md'), 'template\n');
  git(template, ['init']);
  git(template, ['config', 'user.email', 'test@example.com']);
  git(template, ['config', 'user.name', 'Test User']);
  git(template, ['config', 'commit.gpgsign', 'false']);
  git(template, ['add', 'README.md']);
  git(template, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects: []
`);

  const config = loadConfig(root);
  const result = runWorkflow(config, root, { dryRunOnly: true });
  assert.equal(result.sync.created, false);
  assert.equal(result.dryRun.length, 0);
  assert.ok(fs.existsSync(path.join(root, 'reports', 'upgrade-rollup.md')));
});

test('writes advisory extraction recommendation after broad repeated application', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-upgrader-'));
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  const projects = ['project-a', 'project-b', 'project-c'];
  for (const name of projects) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-dev-template
  path: ../nestled-dev-template
  mainBranch: main
projects:
  - name: project-a
    path: project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
  - name: project-b
    path: project-b
    defaultBranch: main
    forkedAreas: []
    verification: []
  - name: project-c
    path: project-c
    defaultBranch: main
    forkedAreas: []
    verification: []
`);
  fs.writeFileSync(path.join(root, 'upgrades', '2026-05-13-auth.yaml'), `
id: 2026-05-13-auth
title: Auth hardening
priority: high
area: auth
type: security
delivery: code-patch
intent: Harden auth.
affectedPaths:
  - apps/api/src/auth/**
verification: []
`);
  const config = loadConfig(root);
  const upgrade = loadUpgrades(root)[0];
  for (const project of config.projects) {
    writeUpgradeLog(project, {
      template: { repo: 'nestled-dev-template' },
      upgrades: {
        [upgrade.id]: { status: 'applied' }
      }
    }, root);
  }

  const recommendations = writeExtractionRecommendations(config, [upgrade], root);
  const filePath = path.join(root, 'reports', 'recommendations', '2026-05-13-auth-extract-library.yaml');
  assert.equal(recommendations.length, 1);
  assert.ok(fs.existsSync(filePath));
  assert.match(fs.readFileSync(filePath, 'utf8'), /@nestledjs\/auth/);
});

test('syncPackagesFromPromotion detects outdated external packages in dry-run', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-sync-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', typescript: '5.8.0' }
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: { react: '18.3.0', typescript: '5.8.0' }
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = syncPackagesFromPromotion(config, root, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].name, 'react');
  assert.equal(result.updates[0].from, '18.3.0');
  assert.equal(result.updates[0].to, '19.0.0');
  assert.equal(result.updates[0].type, 'external');
});

test('syncPackagesFromPromotion skips workspace refs', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-ws-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({
    dependencies: { '@nestledjs/data-browser': 'workspace:*', prisma: '6.0.0' }
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: { '@nestledjs/data-browser': '^1.0.0', prisma: '5.0.0' }
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = syncPackagesFromPromotion(config, root, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.ok(result.updates.every((u) => u.name !== '@nestledjs/data-browser'), 'workspace ref should be skipped');
  assert.equal(result.updates.find((u) => u.name === 'prisma')?.to, '6.0.0');
});

test('syncPackagesFromPromotion detects internal lib version bumps from lib source', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-lib-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(path.join(devTemplate, 'libs', 'data-browser'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(path.join(devTemplate, 'libs', 'data-browser', 'package.json'), JSON.stringify({
    name: '@nestledjs/data-browser', version: '2.1.0'
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: { '@nestledjs/data-browser': '^1.9.0' }
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    rawPatchExcludes:
      - libs/data-browser/**
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = syncPackagesFromPromotion(config, root, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  const libUpdate = result.updates.find((u) => u.name === '@nestledjs/data-browser');
  assert.ok(libUpdate, 'should detect internal lib version bump');
  assert.equal(libUpdate.type, 'internal');
  assert.equal(libUpdate.from, '^1.9.0');
  assert.equal(libUpdate.to, '^2.1.0');
});

test('syncPackagesFromPromotion writes updated package.json when not dry-run', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-apply-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({
    dependencies: { next: '15.0.0' }
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: { next: '14.2.0' }
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  syncPackagesFromPromotion(config, root, { dryRun: false });
  const written = JSON.parse(fs.readFileSync(path.join(template, 'package.json'), 'utf8'));
  assert.equal(written.dependencies.next, '15.0.0');
});

test('syncPackagesFromPromotion syncs pnpm.overrides entries from dev-template', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-overrides-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({
    dependencies: {},
    pnpm: { overrides: { 'baseline-browser-mapping': '0.0.1', 'some-vuln-pkg': '^1.2.0' } }
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: {},
    pnpm: { overrides: { 'some-vuln-pkg': '^1.0.0' } }
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = syncPackagesFromPromotion(config, root, { dryRun: true });
  assert.equal(result.status, 'dry-run');
  const overrideUpdates = result.updates.filter((u) => u.type === 'override');
  assert.equal(overrideUpdates.length, 2);
  const newEntry = overrideUpdates.find((u) => u.name === 'baseline-browser-mapping');
  assert.ok(newEntry, 'should add new pnpm.overrides entry from dev-template');
  assert.equal(newEntry.from, null);
  assert.equal(newEntry.to, '0.0.1');
  assert.equal(newEntry.field, 'pnpm.overrides');
  const updatedEntry = overrideUpdates.find((u) => u.name === 'some-vuln-pkg');
  assert.ok(updatedEntry, 'should update existing pnpm.overrides entry');
  assert.equal(updatedEntry.from, '^1.0.0');
  assert.equal(updatedEntry.to, '^1.2.0');
});

test('syncPackagesFromPromotion writes pnpm.overrides into template package.json', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-pkg-overrides-apply-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({
    dependencies: {},
    pnpm: { overrides: { 'baseline-browser-mapping': '0.0.1' } }
  }));
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({
    dependencies: {}
  }));
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  syncPackagesFromPromotion(config, root, { dryRun: false });
  const written = JSON.parse(fs.readFileSync(path.join(template, 'package.json'), 'utf8'));
  assert.equal(written.pnpm?.overrides?.['baseline-browser-mapping'], '0.0.1');
});

test('promoteTemplate includes packageSync result', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-promote-pkgsync-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'README.md'), 'dev\n');
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({ dependencies: { prisma: '6.0.0' } }));
  fs.writeFileSync(path.join(template, 'README.md'), 'template\n');
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({ dependencies: { prisma: '5.0.0' } }));
  for (const repo of [devTemplate, template]) {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = promoteTemplate(config, root, { dryRun: true });
  assert.ok(result.packageSync, 'promoteTemplate should include packageSync');
  assert.ok(['dry-run', 'up-to-date', 'applied', 'blocked', 'skipped'].includes(result.packageSync.status));
  assert.ok(Array.isArray(result.packageSync.updates));
});

test('promoteTemplate leaves its changes uncommitted', () => {
  // Regression: syncPackageVersions() called commitPackageSync(), which ran `git add -A` and
  // committed the entire working tree under a message naming only the package bumps. One promotion
  // produced a single commit carrying the whole mirror plus any unrelated work in progress,
  // labelled as a version bump, on whatever branch happened to be checked out. Promotion writes
  // and reports; the reviewer commits.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-promote-nocommit-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(devTemplate, 'README.md'), 'dev\n');
  fs.writeFileSync(path.join(devTemplate, 'app.txt'), 'mirrored product file\n');
  fs.writeFileSync(path.join(devTemplate, 'package.json'), JSON.stringify({ dependencies: { prisma: '6.0.0' } }));
  fs.writeFileSync(path.join(template, 'README.md'), 'template\n');
  fs.writeFileSync(path.join(template, 'package.json'), JSON.stringify({ dependencies: { prisma: '5.0.0' } }));
  for (const repo of [devTemplate, template]) {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);
  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const before = gitOutput(template, ['rev-parse', 'HEAD']);

  promoteTemplate(config, root, {});

  const after = gitOutput(template, ['rev-parse', 'HEAD']);
  assert.equal(after, before, 'promotion must not create a commit in the template');

  const status = gitOutput(template, ['status', '--porcelain']);
  assert.ok(status.length > 0, 'mirrored changes must be left in the working tree for review');
  assert.ok(fs.existsSync(path.join(template, 'app.txt')), 'the mirror should still have written its files');
});

test('template-promotion patch applies upgrade note; downstream patch excludes it', () => {
  const notePath = '.nestled-updates/upgrade-notes/2026-05-17-auth-delay.yaml';
  const patch = `diff --git a/auth.service.ts b/auth.service.ts
index 1111111..2222222 100644
--- a/auth.service.ts
+++ b/auth.service.ts
@@ -1 +1 @@
-const delay = Math.random() * 100;
+const delay = randomInt(100, 201);
diff --git a/${notePath} b/${notePath}
new file mode 100644
index 0000000..aaaaaaa
--- /dev/null
+++ b/${notePath}
@@ -0,0 +1,3 @@
+id: 2026-05-17-auth-delay
+title: Use CSPRNG for auth delay
+delivery: code-patch
`;
  const downstreamPatch = `${patch}diff --git a/.nestled/upgrade-log.yaml b/.nestled/upgrade-log.yaml
index 3333333..4444444 100644
--- a/.nestled/upgrade-log.yaml
+++ b/.nestled/upgrade-log.yaml
@@ -1 +1 @@
-local-log: true
+template-log: true
`;
  const upgradeYaml = `
id: 2026-05-17-auth-delay
title: Use CSPRNG for auth delay
priority: high
area: auth
type: security
delivery: code-patch
affectedPaths:
  - auth.service.ts
patch:
  path: patches/2026-05-17-auth-delay.diff
verification: []
`;

  function makeRepo(dir) {
    fs.mkdirSync(path.join(dir, '.nestled-updates', 'upgrade-notes'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.nestled'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.service.ts'), 'const delay = Math.random() * 100;\n');
    fs.writeFileSync(path.join(dir, '.nestled', 'upgrade-log.yaml'), 'local-log: true\n');
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);
  }

  // Template-promotion: upgrade note should be applied
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-promo-note-'));
    const project = path.join(root, 'nestled-template');
    fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
    fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
    makeRepo(project);
    fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: nestled-template
projects:
  - name: nestled-template
    path: nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
    fs.writeFileSync(path.join(root, 'upgrades', '2026-05-17-auth-delay.yaml'), upgradeYaml);
    fs.writeFileSync(path.join(root, 'patches', '2026-05-17-auth-delay.diff'), patch);
    const config = loadConfig(root);
    const upgrade = loadUpgrades(root)[0];
    const result = applyUpgrade(config.projects[0], upgrade, config, root);
    assert.equal(result.patch.applied, true, 'patch should apply to template-promotion project');
    assert.ok(fs.existsSync(path.join(project, notePath)), 'upgrade note should be present in template-promotion project');
  }

  // Downstream: upgrade note should be excluded
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-downstream-note-'));
    const project = path.join(root, 'project-a');
    fs.mkdirSync(path.join(root, 'upgrades'), { recursive: true });
    fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
    makeRepo(project);
    fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
template:
  name: nestled-template
  path: ../nestled-template
projects:
  - name: project-a
    path: project-a
    defaultBranch: main
    forkedAreas: []
    verification: []
`);
    fs.writeFileSync(path.join(root, 'upgrades', '2026-05-17-auth-delay.yaml'), upgradeYaml);
    fs.writeFileSync(path.join(root, 'patches', '2026-05-17-auth-delay.diff'), downstreamPatch);
    const config = loadConfig(root);
    const upgrade = loadUpgrades(root)[0];
    const result = applyUpgrade(config.projects[0], upgrade, config, root);
    assert.equal(result.patch.applied, true, 'patch should apply to downstream project');
    assert.ok(!fs.existsSync(path.join(project, notePath)), 'upgrade note should NOT be present in downstream project');
    assert.ok(!fs.readFileSync(path.join(project, '.nestled', 'upgrade-log.yaml'), 'utf8').includes('template-log: true'));
  }
});

test('mirrorTemplateFromSource copies product files, applies seam substitutions, excludes wiring/tooling, keeps template-only', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-mirror-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(devTemplate, { recursive: true });
  fs.mkdirSync(template, { recursive: true });

  const write = (repo, rel, content) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // dev-template: product files (two carry the imported-vs-embedded seam) + excluded wiring/tooling
  write(devTemplate, 'apps/api/src/service.ts', 'export const svc = 1\n');
  write(devTemplate, 'apps/web/routes/data.tsx', "import { X } from '@nestled-template/data-browser'\n");
  write(devTemplate, '.dev/docker-compose.yml', 'name: nestled-dev-template\nservices: {}\n');
  write(devTemplate, 'nx.json', '{ "release": {} }\n');
  write(devTemplate, 'libs/data-browser/src/index.ts', 'export const v = 1\n');
  write(devTemplate, '.cursor/skills/foo.md', 'authoring\n');
  write(devTemplate, '.nestled-updates/upgrade-notes/n.yaml', 'id: n\n');

  // template: a stale copy of a product file, plus files unique to the template that must survive
  write(template, 'apps/api/src/service.ts', 'export const svc = 0\n');
  write(template, 'apps/web/routes/only-here.tsx', 'export default 1\n');
  write(template, '.nestled/upgrade-log.yaml', 'upgrades: {}\n');

  for (const repo of [devTemplate, template]) {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);

  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  const config = loadConfig(root);
  const result = mirrorTemplateFromSource(config, root, { dryRun: false });
  const read = (rel) => fs.readFileSync(path.join(template, rel), 'utf8');

  // plain product file mirrored; note mirrored
  assert.equal(read('apps/api/src/service.ts'), 'export const svc = 1\n');
  assert.ok(fs.existsSync(path.join(template, '.nestled-updates/upgrade-notes/n.yaml')));
  // seam substitutions applied on the way in
  assert.equal(read('apps/web/routes/data.tsx'), "import { X } from '@nestledjs/data-browser'\n");
  assert.equal(read('.dev/docker-compose.yml'), 'name: nestled-template\nservices: {}\n');
  // excluded wiring / embedded lib / dev tooling NOT mirrored
  assert.ok(!fs.existsSync(path.join(template, 'nx.json')));
  assert.ok(!fs.existsSync(path.join(template, 'libs/data-browser/src/index.ts')));
  assert.ok(!fs.existsSync(path.join(template, '.cursor/skills/foo.md')));
  // template-only files preserved (never deleted); product one is reported, excluded log is not
  assert.equal(read('apps/web/routes/only-here.tsx'), 'export default 1\n');
  assert.equal(read('.nestled/upgrade-log.yaml'), 'upgrades: {}\n');
  assert.ok(result.templateOnly.includes('apps/web/routes/only-here.tsx'));
  assert.ok(!result.templateOnly.includes('.nestled/upgrade-log.yaml'));
  // change kinds recorded
  assert.ok(result.changes.some((c) => c.path === 'apps/api/src/service.ts' && c.kind === 'modified'));
  assert.ok(result.changes.some((c) => c.path === '.nestled-updates/upgrade-notes/n.yaml' && c.kind === 'new'));
});

// A promotion now reads `origin/develop`, never the working tree, so any dev-template fixture must
// look like a real checkout: a develop branch published to an origin it can fetch. Uses a bare repo
// beside the checkout rather than a network remote.
function publishDevTemplate(devTemplate, { branch = 'develop' } = {}) {
  const origin = `${devTemplate}-origin.git`;
  git(devTemplate, ['branch', '-M', branch]);
  // Idempotent: fixtures that commit in several rounds call this after each one, and the second
  // call only needs to push.
  if (!fs.existsSync(origin)) {
    spawnSync('git', ['init', '--bare', '-b', branch, origin], { encoding: 'utf8' });
    git(devTemplate, ['remote', 'add', 'origin', origin]);
  }
  git(devTemplate, ['push', '-u', 'origin', branch]);
  return origin;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

// --- promotion reads committed state only -------------------------------------------------
// These cover the defect where the mirror listed files with `git ls-files` and read them with
// `fs.readFileSync`, so it copied the operator's working tree while reporting a commit sha that
// did not contain those bytes. The report was not merely incomplete, it was wrong.

function promotionFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nestled-committed-'));
  const root = path.join(parent, 'nestled-upgrader');
  const devTemplate = path.join(parent, 'nestled-dev-template');
  const template = path.join(parent, 'nestled-template');
  for (const d of [root, devTemplate, template]) fs.mkdirSync(d, { recursive: true });

  const write = (repo, rel, content) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write(devTemplate, 'apps/api/src/service.ts', 'committed\n');
  write(devTemplate, 'apps/api/src/keep.ts', 'keep\n');
  write(template, 'apps/api/src/service.ts', 'stale\n');

  for (const repo of [devTemplate, template]) {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'initial']);
  }
  publishDevTemplate(devTemplate);

  fs.writeFileSync(path.join(root, 'upgrader.config.yaml'), `
promotion:
  source:
    name: nestled-dev-template
    path: ../nestled-dev-template
template:
  name: nestled-template
  path: ../nestled-template
  mainBranch: main
projects:
  - name: nestled-template
    path: ../nestled-template
    defaultBranch: main
    role: template-promotion
    forkedAreas: []
    verification: []
`);
  return { root, devTemplate, template, write, config: loadConfig(root) };
}

test('promotion ignores tracked uncommitted edits in the source working tree', () => {
  const { root, devTemplate, template, config } = promotionFixture();
  fs.writeFileSync(path.join(devTemplate, 'apps/api/src/service.ts'), 'UNCOMMITTED EDIT\n');

  mirrorTemplateFromSource(config, root, { dryRun: false });

  assert.equal(fs.readFileSync(path.join(template, 'apps/api/src/service.ts'), 'utf8'), 'committed\n');
});

test('promotion ignores uncommitted additions and deletions in the source', () => {
  const { root, devTemplate, template, write, config } = promotionFixture();
  // staged-but-uncommitted addition: `git ls-files` would have reported it
  write(devTemplate, 'apps/api/src/added.ts', 'not committed yet\n');
  git(devTemplate, ['add', 'apps/api/src/added.ts']);
  // uncommitted deletion: reading from disk would have skipped a file that is still committed
  fs.rmSync(path.join(devTemplate, 'apps/api/src/keep.ts'));

  const result = mirrorTemplateFromSource(config, root, { dryRun: false });

  assert.equal(fs.existsSync(path.join(template, 'apps/api/src/added.ts')), false);
  assert.equal(fs.readFileSync(path.join(template, 'apps/api/src/keep.ts'), 'utf8'), 'keep\n');
  assert.ok(!result.changes.some((c) => c.path === 'apps/api/src/added.ts'));
});

test('promotion reads origin/develop even when a feature branch is checked out', () => {
  const { root, devTemplate, template, config } = promotionFixture();
  git(devTemplate, ['checkout', '-b', 'feat/in-progress']);
  fs.writeFileSync(path.join(devTemplate, 'apps/api/src/service.ts'), 'FEATURE BRANCH WORK\n');
  git(devTemplate, ['add', '-A']);
  git(devTemplate, ['commit', '-m', 'in progress']);

  const result = mirrorTemplateFromSource(config, root, { dryRun: false });

  assert.equal(fs.readFileSync(path.join(template, 'apps/api/src/service.ts'), 'utf8'), 'committed\n');
  assert.equal(result.sourceRef, 'origin/develop');
});

test('promotion prefers newer origin/develop over a stale local develop', () => {
  const { root, devTemplate, template, config } = promotionFixture();
  const origin = `${devTemplate}-origin.git`;
  // Advance origin/develop through a second clone, leaving this checkout behind.
  const other = `${devTemplate}-other`;
  spawnSync('git', ['clone', origin, other], { encoding: 'utf8' });
  git(other, ['config', 'user.email', 'test@example.com']);
  git(other, ['config', 'user.name', 'Test User']);
  git(other, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(other, 'apps/api/src/service.ts'), 'newer on origin\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-m', 'newer']);
  git(other, ['push', 'origin', 'develop']);

  const localBefore = gitOutput(devTemplate, ['rev-parse', 'develop']);
  const result = mirrorTemplateFromSource(config, root, { dryRun: false });

  assert.equal(fs.readFileSync(path.join(template, 'apps/api/src/service.ts'), 'utf8'), 'newer on origin\n');
  assert.notEqual(result.sourceSha, localBefore);
  assert.equal(result.sourceSha, gitOutput(other, ['rev-parse', 'HEAD']));
});

test('promotion stops with a clear error when the source ref cannot be fetched', () => {
  const { root, devTemplate, config } = promotionFixture();
  git(devTemplate, ['remote', 'set-url', 'origin', path.join(devTemplate, 'no-such-origin.git')]);

  assert.throws(
    () => mirrorTemplateFromSource(config, root, { dryRun: true }),
    (err) => /Fetching develop for the promotion source failed/.test(err.message)
  );
});

test('the promotion report records the resolved ref and full sha', () => {
  const { root, devTemplate, config } = promotionFixture();
  const head = gitOutput(devTemplate, ['rev-parse', 'develop']);

  const result = mirrorTemplateFromSource(config, root, { dryRun: true });

  assert.equal(result.sourceRef, 'origin/develop');
  assert.equal(result.sourceSha, head);
  assert.equal(result.sourceCommit, head.slice(0, 7));
});
