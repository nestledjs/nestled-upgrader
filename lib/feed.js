import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readYamlFile, writeYamlFile, loadUpgrades } from './upgrader.js';

// Producer side of the distribution channel: bundles the upgrader's unpublished
// downstream upgrade records into a release written to the template's
// `.nestled-upgrades/` feed, and moves channel pointers. See
// docs/DISTRIBUTION-SPEC.md. The consumer that reads this feed is
// `@nestledjs/upgrades` (nestled-update).

function templateRepoPath(config, root = ROOT) {
  if (!config.template?.path) throw new Error('config.template.path is required to publish a feed.');
  return path.resolve(root, config.template.path);
}

function feedDir(config, root = ROOT) {
  return path.join(templateRepoPath(config, root), '.nestled-upgrades');
}

function manifestPath(config, root = ROOT) {
  return path.join(feedDir(config, root), 'manifest.yaml');
}

export function readFeedManifest(config, root = ROOT) {
  return readYamlFile(manifestPath(config, root), { schemaVersion: 1, channels: {}, releases: [] });
}

export function writeFeedManifest(config, manifest, root = ROOT) {
  writeYamlFile(manifestPath(config, root), manifest);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: (result.stdout || '').trim(), stderr: result.stderr || '' };
}

function gitOut(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout : '';
}

/** Downstream records are the unscoped `<id>.yaml` files (not `*.<source>.yaml`). */
function downstreamRecords(upgrades) {
  return upgrades.filter(
    (upgrade) =>
      upgrade.recordPath && path.basename(upgrade.recordPath).replace(/\.ya?ml$/, '') === upgrade.id,
  );
}

function publishedNoteIds(manifest) {
  return new Set((manifest.releases || []).flatMap((release) => (release.notes || []).map((note) => note.id)));
}

function nextReleaseId(manifest, dateStr) {
  const [year, month] = dateStr.split('-');
  const prefix = `${year}.${month}.`;
  const taken = (manifest.releases || [])
    .map((release) => release.id)
    .filter((id) => typeof id === 'string' && id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  const next = (taken.length ? Math.max(...taken) : 0) + 1;
  return `${prefix}${next}`;
}

function includesPatch(record) {
  return !record.delivery || record.delivery === 'code-patch' || record.delivery === 'hybrid';
}

function includesPackage(record) {
  return record.delivery === 'package-release' || record.delivery === 'hybrid';
}

/** Convert an upgrade record to a feed note; returns the note + the patch to copy. */
function buildNote(record) {
  const note = {
    id: record.id,
    title: record.title || record.id,
    delivery: record.delivery || 'code-patch',
    intent: record.intent || '',
  };
  if (record.area) note.area = record.area;
  if (Array.isArray(record.affectedPaths) && record.affectedPaths.length) {
    note.affectedPaths = record.affectedPaths;
  }
  let patchSource = null;
  if (includesPatch(record) && record.patch?.path) {
    note.patch = `patches/${record.id}.diff`;
    patchSource = record.patch.path;
  }
  if (includesPackage(record) && Array.isArray(record.packageReleases)) {
    note.packageReleases = record.packageReleases;
  }
  return { note, patchSource };
}

function commitFeed(templatePath, message, push) {
  git(templatePath, ['add', '.nestled-upgrades']);
  const status = gitOut(templatePath, ['status', '--porcelain', '.nestled-upgrades']);
  if (!status) return { committed: false, sha: gitOut(templatePath, ['rev-parse', '--short', 'HEAD']) };
  const commit = git(templatePath, ['commit', '--no-gpg-sign', '-m', message]);
  if (commit.status !== 0) return { committed: false, error: commit.stderr || commit.stdout };
  const sha = gitOut(templatePath, ['rev-parse', '--short', 'HEAD']);
  let pushed = false;
  let pushError;
  if (push) {
    const result = git(templatePath, ['push']);
    pushed = result.status === 0;
    if (!pushed) pushError = result.stderr || result.stdout;
  }
  return { committed: true, sha, pushed, pushError };
}

export function publishFeed(config, options = {}, root = ROOT) {
  const { channel = 'canary', title, push = false, dryRun = false } = options;
  const manifest = readFeedManifest(config, root);
  const published = publishedNoteIds(manifest);
  const records = downstreamRecords(loadUpgrades(root)).filter(
    (record) =>
      !published.has(record.id) &&
      record.priority !== 'ignore' &&
      (record.patch?.path || (record.packageReleases || []).length > 0),
  );
  if (!records.length) {
    return { published: false, reason: 'No unpublished downstream upgrade records to publish.' };
  }

  const templatePath = templateRepoPath(config, root);
  const templateCommit = gitOut(templatePath, ['rev-parse', '--short', 'HEAD']);
  const date = new Date().toISOString().slice(0, 10);
  const releaseId = nextReleaseId(manifest, date);
  const built = records.map(buildNote);

  const release = {
    id: releaseId,
    date,
    title: title || `Release ${releaseId}`,
    templateCommit,
    notes: built.map((item) => item.note),
  };
  manifest.releases = [...(manifest.releases || []), release];
  manifest.channels = { ...manifest.channels, [channel]: releaseId };
  manifest.generatedAt = date;

  const noteIds = release.notes.map((note) => note.id);
  if (dryRun) {
    return { published: false, dryRun: true, releaseId, channel, notes: noteIds };
  }

  const patchesDir = path.join(feedDir(config, root), 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  for (const { note, patchSource } of built) {
    if (!patchSource) continue;
    const source = path.resolve(root, patchSource);
    if (!fs.existsSync(source)) {
      return { published: false, reason: `Patch file missing for ${note.id}: ${source}` };
    }
    fs.copyFileSync(source, path.join(patchesDir, `${note.id}.diff`));
  }
  writeFeedManifest(config, manifest, root);
  const commit = commitFeed(templatePath, `feed: publish ${releaseId} (${channel})`, push);
  return { published: true, releaseId, channel, notes: noteIds, commit };
}

export function promoteFeed(config, options = {}, root = ROOT) {
  const { toChannel = 'stable', release, push = false } = options;
  const manifest = readFeedManifest(config, root);
  const target = release || manifest.channels?.canary;
  if (!target) return { promoted: false, reason: 'No release to promote (canary pointer is empty).' };
  if (!(manifest.releases || []).some((item) => item.id === target)) {
    return { promoted: false, reason: `Unknown release: ${target}` };
  }
  manifest.channels = { ...manifest.channels, [toChannel]: target };
  writeFeedManifest(config, manifest, root);
  const commit = commitFeed(templateRepoPath(config, root), `feed: promote ${target} to ${toChannel}`, push);
  return { promoted: true, toChannel, release: target, commit };
}

export function feedStatus(config, root = ROOT) {
  const manifest = readFeedManifest(config, root);
  return {
    channels: manifest.channels || {},
    releases: (manifest.releases || []).map((release) => ({
      id: release.id,
      title: release.title,
      notes: (release.notes || []).length,
    })),
  };
}

/**
 * Fleet manager: run the `nestled-update` consumer across every fleet site.
 * Reuses the same project list the upgrader already manages (upgrader.config.yaml)
 * — no separate fleet.yaml is needed because the producer is private. Each site
 * follows the channel recorded in its own `.nestled/upgrade-log.yaml` (canary
 * for the fleet), so this just invokes `apply` per site and collects outcomes.
 */
export function fleetUpdate(config, options = {}, root = ROOT) {
  // Default to npx so the fleet loop works whether or not a site has the
  // updater installed as a devDependency yet (bootstrap-friendly).
  const { bin = process.env.NESTLED_UPDATE_BIN || 'npx -y @nestledjs/upgrades', dryRun = false, allowDirty = false, pr = false, verify } = options;
  const results = [];
  for (const project of config.projects || []) {
    if (project.role === 'template-promotion') continue;
    const projectPath = path.resolve(root, project.path);
    if (!fs.existsSync(projectPath)) {
      results.push({ project: project.name, status: 'missing', output: `Path not found: ${projectPath}` });
      continue;
    }
    const args = ['apply', '--project', projectPath];
    if (allowDirty) args.push('--allow-dirty');
    if (pr) args.push('--pr');
    if (verify != null) args.push('--verify', verify);
    if (dryRun) {
      results.push({ project: project.name, status: 'dry-run', command: `${bin} ${args.join(' ')}` });
      continue;
    }
    const result = spawnSync(bin, args, { encoding: 'utf8', shell: true });
    results.push({
      project: project.name,
      status: (result.status ?? 1) === 0 ? 'ok' : 'failed',
      code: result.status ?? 1,
      output: (result.stdout || '') + (result.stderr || ''),
    });
  }
  return results;
}

/**
 * One-time migration: stamp every fleet site with a baseline so it only receives
 * releases published after the cutover. Sites default to the `canary` channel
 * (the fleet validates releases before they reach `stable`). Preserves any
 * existing per-note history.
 */
export function baselineFleet(config, options = {}, root = ROOT) {
  const { at, channel = 'canary', remote, ref, dryRun = false } = options;
  if (!at) throw new Error('baseline-fleet requires --at <release>.');
  const templatePath = templateRepoPath(config, root);
  const originUrl = remote || gitOut(templatePath, ['remote', 'get-url', 'origin']);
  const feedRef = ref || config.template?.mainBranch || 'develop';

  const results = [];
  for (const project of config.projects || []) {
    if (project.role === 'template-promotion') continue;
    const logFile = path.join(path.resolve(root, project.path), '.nestled', 'upgrade-log.yaml');
    const existing = readYamlFile(logFile, { template: {}, upgrades: {} });
    const log = {
      template: {
        ...existing.template,
        channel: existing.template?.channel || channel,
        baselineRelease: at,
        remote: existing.template?.remote || originUrl || undefined,
        ref: existing.template?.ref || feedRef,
      },
      upgrades: existing.upgrades || {},
    };
    if (!dryRun) writeYamlFile(logFile, log);
    results.push({ project: project.name, baselineRelease: at, channel: log.template.channel });
  }
  return results;
}
