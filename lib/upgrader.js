import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseYaml, stringifyYaml } from './yaml.js';

export const ROOT = process.cwd();

export function readYamlFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return parseYaml(fs.readFileSync(filePath, 'utf8'));
}

export function writeYamlFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(data));
}

export function loadConfig(root = ROOT) {
  const filePath = path.join(root, 'upgrader.config.yaml');
  const config = readYamlFile(filePath);
  if (!config) throw new Error('Missing upgrader.config.yaml');
  config.projects ||= [];
  return config;
}

export function saveConfig(config, root = ROOT) {
  writeYamlFile(path.join(root, 'upgrader.config.yaml'), config);
}

export function readState(root = ROOT) {
  return readYamlFile(path.join(root, 'upgrader.state.yaml'), { template: {} });
}

export function writeState(state, root = ROOT) {
  writeYamlFile(path.join(root, 'upgrader.state.yaml'), state);
}

export function loadUpgrades(root = ROOT) {
  const dir = path.join(root, 'upgrades');
  if (!fs.existsSync(dir)) return [];
  const legacyAliases = loadLegacyUpgradeAliases(root);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => {
      const recordPath = path.join(dir, name);
      const upgrade = { ...readYamlFile(recordPath), recordPath };
      const legacyIds = [...new Set([
        ...legacyIdsForUpgrade(upgrade),
        ...legacyIdsForUpgrade({ legacyIds: legacyAliases[upgrade.id] })
      ])];
      return legacyIds.length ? { ...upgrade, legacyIds } : upgrade;
    });
}

function loadLegacyUpgradeAliases(root = ROOT) {
  const aliases = readYamlFile(path.join(root, 'legacy-upgrade-aliases.yaml'), {});
  return aliases.aliases || aliases;
}

export function findProject(config, name) {
  const project = (config.projects || []).find((item) => item.name === name);
  if (!project) throw new Error(`Unknown project: ${name}`);
  return project;
}

export function findUpgrade(upgrades, id) {
  const directMatches = upgrades.filter((item) => item.id === id);
  const matches = directMatches.length
    ? directMatches
    : upgrades.filter((item) => legacyIdsForUpgrade(item).includes(id));
  if (!matches.length) throw new Error(`Unknown upgrade: ${id}`);
  // A note id can exist in both pipelines (a promotion record and a downstream
  // record). For a bare `--upgrade <id>` lookup prefer the downstream record,
  // whose file is the unscoped `<id>.yaml`.
  const downstream = matches.find(
    (item) => item.recordPath && path.basename(item.recordPath).replace(/\.ya?ml$/, '') === item.id
  );
  return downstream || matches[0];
}

function legacyIdsForUpgrade(upgrade) {
  if (!upgrade?.legacyIds) return [];
  return Array.isArray(upgrade.legacyIds) ? upgrade.legacyIds : [upgrade.legacyIds];
}

function logEntryForUpgrade(entries, upgrade) {
  if (entries[upgrade.id]) return entries[upgrade.id];
  for (const legacyId of legacyIdsForUpgrade(upgrade)) {
    if (entries[legacyId]) return entries[legacyId];
  }
  return null;
}

function knownLogIdsForCatalog(upgrades) {
  const ids = new Set();
  for (const upgrade of upgrades) {
    ids.add(upgrade.id);
    for (const legacyId of legacyIdsForUpgrade(upgrade)) ids.add(legacyId);
  }
  return ids;
}

export function projectPath(project, root = ROOT) {
  return path.resolve(root, project.path);
}

export function logPath(project, root = ROOT) {
  return path.join(projectPath(project, root), '.nestled', 'upgrade-log.yaml');
}

function templateSource(config) {
  return {
    name: config.template?.name || 'nestled-template',
    path: config.template?.path || '../nestled-template'
  };
}

function promotionSource(config) {
  return {
    name: config.promotion?.source?.name || 'nestled-dev-template',
    path: config.promotion?.source?.path || '../nestled-dev-template'
  };
}

export function readUpgradeLog(project, root = ROOT) {
  return readYamlFile(logPath(project, root), { template: {}, upgrades: {} });
}

/**
 * Plain scalars whose value contains an inline ` #`, which YAML reads as a comment.
 *
 * Both our parser and js-yaml truncate `reason: converged in PR #51. DTOs moved...` at the hash --
 * correctly, per YAML 1.2. The danger is the round trip: reading drops the tail, writing re-emits
 * the value quoted, and the text leaves the file for good. Nothing warns, because every individual
 * step behaved as specified. Agents hand-write these logs (AGENTS.md step 7) and reasons routinely
 * cite a PR number, so this is a matter of when, not whether.
 */
export function inlineCommentRisks(source) {
  const risks = [];
  const lines = source.split('\n');
  // Block scalars (`notes: |`, `reason: >-`) keep every character of their body, hashes included,
  // so a mapping-shaped line inside one is text and not a key. Scanning without tracking that
  // context refuses ledgers that were never at risk -- and a guard that cries wolf gets bypassed,
  // which costs more than the bug it was added to prevent.
  let blockIndent = null;
  for (const [index, line] of lines.entries()) {
    if (blockIndent !== null) {
      const indent = line.search(/\S/);
      // Blank lines belong to the block; the body ends at the first content indented no further
      // than the key that opened it.
      if (indent === -1 || indent > blockIndent) continue;
      blockIndent = null;
    }

    const match = /^(\s*)(?:- )?([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const [, leading, key, rawValue] = match;
    const value = rawValue ?? '';

    if (/^[|>][-+\d]*\s*$/.test(value.trim()) && value.trim() !== '') {
      blockIndent = leading.length;
      continue;
    }
    // Quoted scalars carry the hash safely; only plain scalars lose it.
    if (value === '' || /^["']/.test(value)) continue;
    const hash = value.search(/\s#/);
    if (hash === -1) continue;
    risks.push({
      line: index + 1,
      key,
      kept: value.slice(0, hash).trim(),
      dropped: value.slice(hash).trim()
    });
  }
  return risks;
}

/**
 * Refuse to overwrite a ledger whose on-disk text a rewrite would swallow.
 *
 * This sits on the shared write path deliberately. The check began life in `normalizeUpgradeLog`,
 * which left every other caller -- `initializeUpgradeLog`, and so `runWorkflow` through
 * `addDiscoveredProjects` -- free to do the same read-modify-write with no guard at all. A
 * safeguard that covers one of several doors is worse than none, because it reads as protection.
 */
function assertLosslessRewrite(filePath) {
  if (!fs.existsSync(filePath)) return;
  const risks = inlineCommentRisks(fs.readFileSync(filePath, 'utf8'));
  if (risks.length === 0) return;
  const detail = risks
    .map((risk) => `  line ${risk.line} (${risk.key}): kept "${risk.kept}" — would lose "${risk.dropped}"`)
    .join('\n');
  throw new Error(
    `Refusing to rewrite ${filePath}: ${risks.length} line(s) would lose text to a YAML comment.\n` +
      `${detail}\nWrap each value in double quotes, then re-run.`
  );
}

export function writeUpgradeLog(project, log, root = ROOT) {
  const filePath = logPath(project, root);
  assertLosslessRewrite(filePath);
  writeYamlFile(filePath, log);
}

export const RETIRED_LOG_NAME = 'upgrade-log.retired.yaml';

const RETIREMENT_HEADER = [
  '# RETIRED — historical record only.',
  '#',
  '# This ledger belonged to the upgrade-record system, which convergence replaced. Nothing reads',
  '# it any more, and `lastReviewedCommit` below is a pointer that stopped moving when the system',
  '# was retired: it does NOT mean this repo is that far behind. The current measure is',
  '# .nestled/converged-at, reported by `nestled-upgrader convergence-status`.',
  '#',
  '# Kept rather than deleted because the decisions here carry reasons nobody will reconstruct',
  '# later, and a repo losing the record of why it adapted something is worse than a stale file.',
  ''
].join('\n');

/**
 * Retire one repo's upgrade ledger, keeping the file as history.
 *
 * Refuses a repo with no convergence marker. For those the ledger is still the only bookkeeping
 * there is, so retiring it first would leave the repo with no record at all through the window
 * where it most needs one -- its first convergence pass.
 */
export function retireUpgradeRecords(project, root = ROOT, { dryRun = false } = {}) {
  const repoPath = path.resolve(root, project.path);
  const from = logPath(project, root);
  const to = path.join(path.dirname(from), RETIRED_LOG_NAME);
  const result = { project: project.name, from, to };

  if (!fs.existsSync(from)) {
    return fs.existsSync(to) ? { ...result, state: 'already-retired' } : { ...result, state: 'no-ledger' };
  }
  if (!readConvergenceMarker(repoPath)) return { ...result, state: 'not-converged' };
  if (fs.existsSync(to)) return { ...result, state: 'conflict' };

  const body = fs.readFileSync(from, 'utf8');
  if (dryRun) return { ...result, state: 'would-retire', bytes: body.length };

  // 'wx' rather than a plain write: the existsSync above can go stale between the check and the
  // write, and the file this would clobber is the historical record this command exists to keep.
  // Exclusive create makes the check authoritative instead of advisory.
  try {
    fs.writeFileSync(to, `${RETIREMENT_HEADER}${body}`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { ...result, state: 'conflict' };
    throw error;
  }
  fs.rmSync(from);
  return { ...result, state: 'retired', bytes: body.length };
}

export function retireAllUpgradeRecords(config, root = ROOT, options = {}) {
  const only = options.project;
  return downstreamProjects(config)
    .filter((project) => !only || project.name === only)
    .map((project) => retireUpgradeRecords(project, root, options));
}

export function normalizeUpgradeLog(project, root = ROOT, options = {}) {
  const filePath = logPath(project, root);
  if (!fs.existsSync(filePath)) {
    return {
      project: project.name,
      path: filePath,
      changed: false,
      missing: true
    };
  }
  const before = fs.readFileSync(filePath, 'utf8');
  // Refuse rather than normalize: rewriting is exactly the step that would drop this text, and a
  // tool that destroys a human's sentence while reporting success is worse than one that stops.
  const risks = inlineCommentRisks(before);
  if (risks.length > 0) {
    return { project: project.name, path: filePath, changed: false, risks };
  }
  const after = stringifyYaml(parseYaml(before));
  const changed = before !== after;
  if (changed && !options.check) fs.writeFileSync(filePath, after);
  return {
    project: project.name,
    path: filePath,
    changed,
    missing: false
  };
}

export function normalizeUpgradeLogs(config, root = ROOT, options = {}) {
  const projects = options.project
    ? [findProject(config, options.project)]
    : downstreamProjects(config);
  return projects.map((project) => {
    if (project.role === 'template-promotion') {
      return {
        project: project.name,
        path: logPath(project, root),
        changed: false,
        missing: false,
        skipped: true,
        reason: 'template-promotion target is not a downstream upgrade ledger'
      };
    }
    return normalizeUpgradeLog(project, root, options);
  });
}

export function initializeUpgradeLog(project, config, root = ROOT) {
  // A retired repo must not have its ledger recreated. Renaming the file was never enough on its
  // own: every path that reaches here writes one back, so a `run` after a retirement silently
  // restored the stale lastReviewedCommit the retirement existed to remove. mi-core regenerated
  // one within a day of its retirement merging.
  const retired = path.join(path.dirname(logPath(project, root)), RETIRED_LOG_NAME);
  if (fs.existsSync(retired)) return null;
  const existing = readUpgradeLog(project, root);
  const templatePath = path.resolve(root, templateSource(config).path);
  const originCommit = gitOutput(templatePath, ['rev-parse', '--short', 'HEAD']) || '';
  const log = {
    template: {
      repo: templateSource(config).name,
      originCommit: existing.template?.originCommit || originCommit,
      lastReviewedCommit: existing.template?.lastReviewedCommit || originCommit
    },
    upgrades: existing.upgrades || {}
  };
  writeUpgradeLog(project, log, root);
  return log;
}

export function initializeAllLogs(config, root = ROOT) {
  return downstreamProjects(config).map((project) => ({ project: project.name, log: initializeUpgradeLog(project, config, root) }));
}

export function discoverProjects(config, root = ROOT) {
  const parent = path.resolve(root, '..');
  const current = path.basename(root);
  const excludedNames = new Set([current, templateSource(config).name, promotionSource(config).name, ...(config.discover?.exclude || [])]);
  const existing = new Set((config.projects || []).map((project) => path.resolve(root, project.path)));
  const discovered = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || excludedNames.has(entry.name)) continue;
    const absolute = path.join(parent, entry.name);
    if (existing.has(absolute)) continue;
    if (!looksLikeProject(absolute)) continue;
    discovered.push({
      name: entry.name,
      path: path.relative(root, absolute),
      defaultBranch: gitOutput(absolute, ['branch', '--show-current']) || 'main',
      forkedAreas: [],
      verification: inferVerification(absolute)
    });
  }
  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export function addDiscoveredProjects(config, root = ROOT) {
  const discovered = discoverProjects(config, root);
  config.projects = [...(config.projects || []), ...discovered];
  if (discovered.length > 0) saveConfig(config, root);
  initializeAllLogs(config, root);
  return discovered;
}

export function summarizeProject(project, upgrades, root = ROOT, catalogUpgrades = upgrades) {
  const log = readUpgradeLog(project, root);
  const entries = log.upgrades || {};
  const counts = { pending: 0, applied: 0, adapted: 0, skipped: 0, superseded: 0, blocked: 0, 'not-applicable': 0 };
  for (const upgrade of upgrades) {
    const status = logEntryForUpgrade(entries, upgrade)?.status || 'pending';
    counts[status] = (counts[status] || 0) + 1;
  }
  // Log keys that match no catalog id or declared legacy id. Historical agents sometimes keyed
  // completed work by the date it ran plus a hand-written slug; declared legacy ids keep those
  // known aliases from being offered again while still surfacing genuinely unknown future keys.
  const known = knownLogIdsForCatalog(catalogUpgrades);
  const orphans = Object.keys(entries).filter((id) => !known.has(id)).sort();
  return { project: project.name, counts, orphans };
}

export function relevantUpgradesForProject(config, project, upgrades) {
  return project.role === 'template-promotion'
    ? promotionUpgrades(config, upgrades)
    : downstreamUpgrades(config, upgrades);
}

export function inspectPlan(project, upgrade, root = ROOT) {
  const absoluteProject = projectPath(project, root);
  const log = readUpgradeLog(project, root);
  const existing = logEntryForUpgrade(log.upgrades || {}, upgrade);
  const forked = (project.forkedAreas || []).includes(upgrade.area);
  const affected = (upgrade.affectedPaths || []).map((pattern) => ({ pattern, exists: affectedPathExists(absoluteProject, pattern) }));
  let recommendation = 'apply';
  let reason = 'Upgrade is pending and no configured forked area matches.';
  if (existing?.status && existing.status !== 'pending') {
    recommendation = 'no-op';
    reason = `Upgrade already recorded as ${existing.status}.`;
  } else if (upgrade.priority === 'ignore') {
    recommendation = 'no-op';
    reason = 'Upgrade note is a historical/decision record (priority: ignore).';
  } else if (!isValidDelivery(upgrade)) {
    recommendation = 'blocked';
    reason = 'Upgrade note is missing required delivery metadata.';
  } else if (project.role === 'template-promotion' && deliveryIncludesPatch(upgrade) && promotionPatchOnlyTouchesExcludedPaths(project, upgrade)) {
    recommendation = 'blocked';
    reason = 'Template promotion patch only touches paths excluded from raw promotion; use package-release/hybrid delivery or handle the template-specific manifest change manually.';
  } else if (isTemplateToolingUpgrade(upgrade) && !fs.existsSync(path.join(absoluteProject, '.nestled-updates'))) {
    recommendation = 'not-applicable';
    reason = 'Project does not keep local dev-template upgrade-note tooling.';
  } else if (hasUnresolvedPackageRelease(upgrade)) {
    recommendation = 'pending-release';
    reason = 'Package release delivery is missing targetVersion and versionRange; wait for a published version before applying.';
  } else if (deliveryIncludesPackage(upgrade) && !deliveryIncludesPatch(upgrade)) {
    recommendation = 'package-release';
    reason = `Upgrade should be delivered by bumping ${packageReleaseNames(upgrade)} instead of copying package source files.`;
  } else if (deliveryIncludesPackage(upgrade) && deliveryIncludesPatch(upgrade)) {
    recommendation = 'hybrid';
    reason = `Upgrade requires package release handling first (${packageReleaseNames(upgrade)}), then local code adaptation.`;
  } else if (forked) {
    recommendation = 'adapt-or-review';
    reason = `Project marks ${upgrade.area} as forked; inspect intent before patching.`;
  } else if (affected.length > 0 && affected.every((item) => !item.exists)) {
    recommendation = 'not-applicable-or-adapt';
    reason = 'None of the affected path hints exist in the project.';
  }
  return { project: project.name, upgrade: upgrade.id, recommendation, reason, forkedArea: forked, affectedPaths: affected };
}

export function planAll(config, upgrades, root = ROOT) {
  const plans = [];
  for (const project of downstreamProjects(config)) {
    for (const upgrade of downstreamUpgrades(config, upgrades)) {
      const plan = inspectPlan(project, upgrade, root);
      const reportPath = writePlanReport(project, upgrade, plan, root, true, { preserveExistingNoOp: true });
      plans.push({ ...plan, reportPath });
    }
  }
  writeRollupReport(plans, root);
  return plans;
}

function affectedPathExists(base, pattern) {
  const prefix = pattern.replace(/\*\*.*$/, '').replace(/\*.*$/, '');
  return fs.existsSync(path.join(base, prefix));
}

function planReportPath(project, upgrade, root = ROOT) {
  return path.join(root, 'reports', project.name, `${upgrade.id}.md`);
}

export function writePlanReport(project, upgrade, plan, root = ROOT, dryRun = false, options = {}) {
  const dir = path.join(root, 'reports', project.name);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = planReportPath(project, upgrade, root);
  if (options.preserveExistingNoOp && dryRun && plan.recommendation === 'no-op' && fs.existsSync(filePath)) {
    return filePath;
  }
  const lines = [
    `# ${upgrade.title || upgrade.id}`,
    '',
    `Project: ${project.name}`,
    `Upgrade: ${upgrade.id}`,
    `Mode: ${dryRun ? 'dry-run' : 'plan'}`,
    `Recommendation: ${plan.recommendation}`,
    '',
    `Reason: ${plan.reason}`,
    '',
    '## Intent',
    '',
    upgrade.intent || '(none provided)',
    '',
    '## Affected Paths',
    '',
    ...(plan.affectedPaths.length ? plan.affectedPaths.map((item) => `- ${item.pattern}: ${item.exists ? 'present' : 'not found'}`) : ['- (none listed)']),
    '',
    '## Agent Next Step',
    '',
    agentNextStep(plan)
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function agentNextStep(plan) {
  if (plan.recommendation === 'apply') return 'Try direct patch application first. If it fails, inspect the intent and adapt the downstream implementation conservatively.';
  if (plan.recommendation === 'package-release') return 'Do not copy package source files. Verify the target package version exists, bump downstream package manifests and lockfile if this project consumes it, otherwise mark not-applicable.';
  if (plan.recommendation === 'pending-release') return 'Do not apply this upgrade until packageReleases specify targetVersion or versionRange for every package.';
  if (plan.recommendation === 'hybrid') return 'Apply package-release behavior first without copying package source files, then adapt the local code-patch behavior described by the intent.';
  if (plan.recommendation === 'adapt-or-review') return 'Inspect the forked area before editing. Preserve local product decisions and implement only the upgrade intent if still relevant.';
  if (plan.recommendation === 'not-applicable-or-adapt') return 'Confirm whether the project has equivalent code in different paths. Mark not-applicable only after inspection.';
  return 'No code change is recommended from this plan.';
}

export function createDraftUpgrade({ from, to, templatePath = '../nestled-template', scope = '' }, root = ROOT) {
  if (!from || !to) throw new Error('create-upgrade requires --from <commit> and --to <commit>');
  const id = `${new Date().toISOString().slice(0, 10)}-${from.slice(0, 7)}-to-${to.slice(0, 7)}`;
  const suffix = scope ? `.${scope}` : '';
  const patchPath = path.join(root, 'patches', `${id}${suffix}.diff`);
  const upgradePath = path.join(root, 'upgrades', `${id}${suffix}.yaml`);
  if (fs.existsSync(upgradePath)) {
    return { id, upgradePath, patchPath, existed: true };
  }
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.mkdirSync(path.dirname(upgradePath), { recursive: true });
  const absoluteTemplate = path.resolve(root, templatePath);
  const sourceRepo = path.basename(absoluteTemplate);
  const diff = spawnSync('git', ['-C', absoluteTemplate, 'diff', `${from}..${to}`], { encoding: 'utf8' });
  const patch = diff.status === 0 ? diff.stdout : `# Unable to generate patch automatically: ${diff.stderr || diff.error?.message || 'git diff failed'}\n`;
  const changedPaths = changedTemplatePaths(absoluteTemplate, from, to);
  fs.writeFileSync(patchPath, patch);
  writeYamlFile(upgradePath, {
    id,
    title: `Template changes ${from.slice(0, 7)} to ${to.slice(0, 7)}`,
    priority: 'normal',
    area: inferArea(changedPaths),
    type: 'cleanup',
    delivery: 'code-patch',
    sourceRepo,
    sourceCommitRange: `${from}..${to}`,
    intent: `Propagate relevant template changes from ${from.slice(0, 7)} to ${to.slice(0, 7)} while preserving downstream product decisions.`,
    why: 'Template moved forward and downstream projects should be reviewed for applicable fixes or improvements.',
    affectedPaths: changedPaths,
    patch: { path: path.relative(root, patchPath) },
    skipIf: [],
    verification: []
  });
  return { id, upgradePath, patchPath };
}

function createUpgradeFromNote(note, { from, to, templatePath = '../nestled-template', scope = '' }, root = ROOT) {
  if (!note.id) throw new Error('Upgrade note is missing id.');
  const absoluteTemplate = path.resolve(root, templatePath);
  const sourceRepo = path.basename(absoluteTemplate);
  // Promotion and downstream are separate pipelines that need separate records
  // for the same note id (different source + different diff). Scope the promotion
  // record's file by its source so it never occupies the downstream `<id>.yaml`
  // slot — otherwise downstream sync would skip creating its own record and the
  // fix would never reach product projects.
  const suffix = scope ? `.${scope}` : '';
  const patchPath = path.join(root, 'patches', `${note.id}${suffix}.diff`);
  const upgradePath = path.join(root, 'upgrades', `${note.id}${suffix}.yaml`);
  if (fs.existsSync(upgradePath)) return { id: note.id, upgradePath, patchPath, existed: true };
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.mkdirSync(path.dirname(upgradePath), { recursive: true });
  const diff = spawnSync('git', ['-C', absoluteTemplate, 'diff', `${from}..${to}`], { encoding: 'utf8' });
  fs.writeFileSync(patchPath, diff.status === 0 ? diff.stdout : `# Unable to generate patch automatically: ${diff.stderr || diff.error?.message || 'git diff failed'}\n`);
  writeYamlFile(upgradePath, {
    ...note,
    sourceRepo,
    sourceCommitRange: `${from}..${to}`,
    patch: { path: path.relative(root, patchPath) }
  });
  return { id: note.id, upgradePath, patchPath };
}

export function syncTemplate(config, root = ROOT) {
  return syncTemplateSource(config, root, {
    stateKey: 'template',
    source: templateSource(config)
  });
}

// One-time, idempotent migration: earlier versions stored promotion records at the
// unscoped `upgrades/<id>.yaml`, which blocked downstream sync from creating its own
// `nestled-template`-sourced record for the same note id. Move any promotion-sourced
// record to the scoped `upgrades/<id>.<promotion-source>.yaml` so the downstream slot
// is free. Safe to call on every sync — it skips records that are already scoped.
function migratePromotionRecords(config, root = ROOT) {
  const dir = path.join(root, 'upgrades');
  if (!fs.existsSync(dir)) return;
  let promoName;
  try { promoName = promotionSource(config).name; } catch { return; }
  if (!promoName) return;
  const suffix = `.${promoName}`;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    if (name.includes(`${suffix}.`)) continue; // already scoped
    const filePath = path.join(dir, name);
    let record;
    try { record = readYamlFile(filePath); } catch { continue; }
    if (!record || record.sourceRepo !== promoName) continue;
    const id = record.id || name.replace(/\.ya?ml$/, '');
    const targetPath = path.join(dir, `${id}${suffix}.yaml`);
    if (fs.existsSync(targetPath)) continue; // never clobber an existing scoped record
    const oldPatchRel = record.patch?.path || path.join('patches', `${id}.diff`);
    const oldPatch = path.resolve(root, oldPatchRel);
    if (fs.existsSync(oldPatch)) {
      const newPatchRel = path.join('patches', `${id}${suffix}.diff`);
      fs.renameSync(oldPatch, path.resolve(root, newPatchRel));
      record.patch = { ...(record.patch || {}), path: newPatchRel };
    }
    writeYamlFile(targetPath, record);
    fs.rmSync(filePath);
  }
}

function syncPromotionSource(config, root = ROOT) {
  return syncTemplateSource(config, root, {
    stateKey: 'promotion',
    source: promotionSource(config)
  });
}

function syncTemplateSource(config, root = ROOT, { stateKey, source }) {
  initializeAllLogs(config, root);
  migratePromotionRecords(config, root);
  const templatePath = path.resolve(root, source.path);
  const to = gitOutput(templatePath, ['rev-parse', '--short', 'HEAD']);
  if (!to) throw new Error(`Unable to read template HEAD at ${templatePath}`);
  const state = readState(root);
  const previous = state[stateKey] || {};
  const candidateFrom = previous.lastSyncedCommit || (stateKey === 'template' ? latestUpgradeCommit(root) : '') || to;
  const from = commitExists(templatePath, candidateFrom) ? candidateFrom : to;
  state[stateKey] = {
    repo: source.name,
    path: source.path,
    lastSeenCommit: to,
    lastSyncedCommit: from
  };
  if (!from) throw new Error('Unable to determine template baseline commit.');
  if (from === to) {
    writeState(state, root);
    return { created: false, from, to, reason: 'Template HEAD matches last synced commit. Baseline is current.' };
  }
  const changedPaths = changedTemplatePaths(templatePath, from, to);
  const notes = upgradeNotesFromRange(templatePath, from, to);
  if (notes.length === 0 && changedPaths.length > 0 && changedPaths.every((filePath) => filePath.startsWith('.nestled/'))) {
    state[stateKey].lastSyncedCommit = to;
    writeState(state, root);
    return {
      created: false,
      from,
      to,
      reason: 'Template delta only touches .nestled metadata. Baseline advanced without creating a downstream upgrade.'
    };
  }
  // Promotion records are scoped by their source repo so a note id promoted
  // from the dev template does not occupy the downstream `<id>.yaml` slot.
  const scope = stateKey === 'promotion' ? path.basename(templatePath) : '';
  const drafts = notes.length
    ? notes.map((note) => createUpgradeFromNote(note, { from, to, templatePath: source.path, scope }, root))
    : [createDraftUpgrade({ from, to, templatePath: source.path, scope }, root)];
  const created = drafts.filter((draft) => !draft.existed);
  state[stateKey].lastSyncedCommit = to;
  state[stateKey].lastCreatedUpgrade = drafts.at(-1)?.id;
  state[stateKey].lastCreatedUpgrades = drafts.map((draft) => draft.id);
  writeState(state, root);
  return { created: created.length > 0, from, to, drafts, ...drafts[0] };
}

export function applyDryRun(project, upgrade, root = ROOT) {
  const plan = inspectPlan(project, upgrade, root);
  const reportPath = writePlanReport(project, upgrade, plan, root, true, { preserveExistingNoOp: true });
  return { ...plan, reportPath };
}

export function applyUpgrade(project, upgrade, config, root = ROOT, options = {}) {
  initializeUpgradeLog(project, config, root);
  if (options.dryRun) return applyDryRun(project, upgrade, root);
  const plan = inspectPlan(project, upgrade, root);
  const absoluteProject = projectPath(project, root);
  const log = readUpgradeLog(project, root);
  log.upgrades ||= {};
  const reviewedAt = new Date().toISOString();
  const branch = `nestled-upgrade/${upgrade.id}`;
  const result = { ...plan, branch, verification: [], patch: null };

  if (plan.recommendation === 'no-op') {
    result.reportPath = writePlanReport(project, upgrade, plan, root, false);
    return result;
  }
  if (plan.recommendation === 'blocked' || plan.recommendation === 'pending-release' || plan.recommendation === 'not-applicable') {
    result.recommendation = plan.recommendation === 'not-applicable' ? 'not-applicable' : 'blocked';
    result.reason = plan.reason;
    recordOutcome(log, upgrade.id, { status: result.recommendation, reviewedAt, branch, reason: result.reason });
    writeUpgradeLog(project, log, root);
    result.reportPath = writeApplyReport(project, upgrade, result, root);
    return result;
  }
  if (!isGitRepo(absoluteProject)) {
    result.recommendation = 'blocked';
    result.reason = 'Project is not a git repository; cannot safely create an upgrade branch.';
    recordOutcome(log, upgrade.id, { status: 'blocked', reviewedAt, reason: result.reason });
    writeUpgradeLog(project, log, root);
    result.reportPath = writeApplyReport(project, upgrade, result, root);
    return result;
  }
  if (!options.allowDirty && hasUncommittedChanges(absoluteProject)) {
    result.recommendation = 'blocked';
    result.reason = 'Project has uncommitted changes. Re-run with --allow-dirty only if those edits are intentional upgrade context.';
    recordOutcome(log, upgrade.id, { status: 'blocked', reviewedAt, reason: result.reason });
    writeUpgradeLog(project, log, root);
    result.reportPath = writeApplyReport(project, upgrade, result, root);
    return result;
  }

  checkoutBranch(absoluteProject, branch);
  if (deliveryIncludesPackage(upgrade)) {
    result.packageRelease = applyPackageReleases(absoluteProject, upgrade);
    if (result.packageRelease.status === 'blocked') {
      result.recommendation = 'blocked';
      result.reason = result.packageRelease.reason;
      recordOutcome(log, upgrade.id, { status: 'blocked', reviewedAt, branch, reason: result.reason });
      writeUpgradeLog(project, log, root);
      result.reportPath = writeApplyReport(project, upgrade, result, root);
      return result;
    }
    if (result.packageRelease.status === 'not-applicable' && !deliveryIncludesPatch(upgrade)) {
      result.recommendation = 'not-applicable';
      result.reason = result.packageRelease.reason;
      recordOutcome(log, upgrade.id, { status: 'not-applicable', reviewedAt, branch, reason: result.reason });
      writeUpgradeLog(project, log, root);
      result.reportPath = writeApplyReport(project, upgrade, result, root);
      return result;
    }
  }

  if (!deliveryIncludesPatch(upgrade)) {
    result.verification = runVerification(project, upgrade, absoluteProject);
    const failed = result.verification.find((item) => item.status !== 0);
    recordOutcome(log, upgrade.id, {
      status: failed ? 'blocked' : 'applied',
      reviewedAt,
      branch,
      notes: failed ? `Package release applied, but verification failed: ${failed.command}` : 'Package release applied.'
    });
    if (!failed) {
      markTemplateReviewed(log, upgrade);
      writeUpgradeLog(project, log, root);
      commitUpgrade(absoluteProject, upgrade.id);
    }
    writeUpgradeLog(project, log, root);
    result.reportPath = writeApplyReport(project, upgrade, result, root);
    return result;
  }

  const patchResult = tryApplyPatch(absoluteProject, upgrade, root, project);
  result.patch = patchResult;
  if (patchResult.alreadyApplied) {
    recordOutcome(log, upgrade.id, {
      status: 'superseded',
      reviewedAt,
      branch,
      notes: 'Patch appears to already be present in this project.'
    });
    markTemplateReviewed(log, upgrade);
    writeUpgradeLog(project, log, root);
    commitUpgrade(absoluteProject, upgrade.id);
    if (project.autoPR) result.pr = pushAndCreatePR(absoluteProject, project, upgrade, branch);
  } else if (patchResult.applied) {
    result.verification = runVerification(project, upgrade, absoluteProject);
    const failed = result.verification.find((item) => item.status !== 0);
    if (!failed) {
      recordOutcome(log, upgrade.id, {
        status: 'applied',
        reviewedAt,
        branch,
        notes: 'Patch applied cleanly.'
      });
      markTemplateReviewed(log, upgrade);
      writeUpgradeLog(project, log, root);
      commitUpgrade(absoluteProject, upgrade.id);
      if (project.autoPR) result.pr = pushAndCreatePR(absoluteProject, project, upgrade, branch);
    } else {
      result.recommendation = 'blocked';
      result.reason = `Patch applied, but verification failed: ${failed.command}`;
      recordOutcome(log, upgrade.id, {
        status: 'blocked',
        reviewedAt,
        branch,
        reason: result.reason
      });
    }
  } else {
    recordOutcome(log, upgrade.id, {
      status: 'blocked',
      reviewedAt,
      branch,
      reason: 'Direct patch did not apply cleanly; agent adaptation is required.',
      notes: patchResult.output
    });
  }
  writeUpgradeLog(project, log, root);
  result.reportPath = writeApplyReport(project, upgrade, result, root);
  return result;
}

export function promoteTemplate(config, root = ROOT, options = {}) {
  const project = templatePromotionProject(config);
  const templatePath = path.resolve(root, templateSource(config).path);
  if (!options.dryRun && !options.allowDirty && hasUncommittedChanges(templatePath)) {
    return {
      project: project.name,
      mode: 'mirror',
      blocked: true,
      reason: 'nestled-template has uncommitted changes. Commit or stash them first, or re-run with --allow-dirty.'
    };
  }
  // Audit/state bookkeeping only: records the promoted dev-template commit range and keeps a
  // note-scoped trail (unchanged from the legacy flow). It no longer drives the apply — the
  // mirror below does the real work.
  const sync = syncPromotionSource(config, root);
  // The promotion itself: an import-aware file mirror of dev-template's product surface into
  // nestled-template. Additive, substitution-aware, and never blocks on conflicts.
  const mirror = mirrorTemplateFromSource(config, root, { dryRun: options.dryRun });
  const packageSync = syncPackagesFromPromotion(config, root, { dryRun: options.dryRun });
  writeMirrorReport(mirror, packageSync, root);
  return { project: project.name, mode: 'mirror', sync, mirror, packageSync };
}

function gitTrackedFiles(cwd) {
  const out = gitOutput(cwd, ['ls-files']);
  return out ? out.split('\n').filter(Boolean) : [];
}

// The branch a promotion always reads. Never HEAD: an operator with a feature branch checked out
// would otherwise promote whatever they happen to be working on.
const PROMOTION_SOURCE_BRANCH = 'develop';

// gitOutput() swallows failures by returning '' — fine for optional lookups, wrong for the steps a
// promotion depends on. A failed fetch or an unresolvable ref must stop the run, not silently
// promote a stale or empty tree.
function gitStrict(cwd, args, what) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${what} failed (git ${args.join(' ')} in ${cwd})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

// Resolve the promotion source to a commit on origin/<branch>. Fetching first is what stops a stale
// local develop from winning: the operator's checkout may be days behind, or on another branch
// entirely, and neither should change what gets promoted.
export function resolvePromotionRef(cwd, branch = PROMOTION_SOURCE_BRANCH) {
  gitStrict(cwd, ['fetch', 'origin', branch], `Fetching ${branch} for the promotion source`);
  const ref = `origin/${branch}`;
  const sha = gitStrict(cwd, ['rev-parse', `${ref}^{commit}`], `Resolving ${ref}`).trim();
  return { ref, sha, short: sha.slice(0, 7) };
}

// Files as of a commit, from Git's object store. Deliberately not `git ls-files`, which reports the
// index and so leaks staged-but-uncommitted additions and hides uncommitted deletions.
// -z avoids Git's path quoting for names with spaces or non-ASCII characters.
function gitCommittedFiles(cwd, sha) {
  const out = gitStrict(cwd, ['ls-tree', '-r', '--name-only', '-z', sha], 'Listing the committed tree');
  return out.split('\0').filter(Boolean);
}

// A blob as of a commit. Read as a Buffer, never via fs: the working tree is irrelevant to a
// promotion, and utf8 round-tripping would corrupt binary assets.
function gitCommittedBlob(cwd, sha, rel) {
  const result = spawnSync('git', ['cat-file', 'blob', `${sha}:${rel}`], {
    cwd,
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = (result.stderr || '').toString().trim();
    throw new Error(`Reading ${rel} at ${sha} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

// Glob match limited to the shapes the promotion policy uses: exact paths, `dir/**` subtree
// excludes, and simple single-segment `*` wildcards.
function mirrorPathExcluded(rel, excludes) {
  return excludes.some((pattern) => {
    if (pattern === rel) return true;
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3);
      return rel === base || rel.startsWith(`${base}/`);
    }
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      return re.test(rel);
    }
    return false;
  });
}

// Find/replace over a file's bytes. `find` is a literal string or a RegExp (use a global RegExp to
// replace every occurrence). Skips binary files and only rewrites when the match is actually present,
// so images and lockfiles are never touched.
function applyMirrorSubstitutions(buffer, substitutions) {
  if (!substitutions.length || buffer.includes(0)) return buffer;
  let text = buffer.toString('utf8');
  let changed = false;
  for (const { find, replace } of substitutions) {
    if (find instanceof RegExp) {
      const next = text.replace(find, replace ?? '');
      if (next !== text) { text = next; changed = true; }
      continue;
    }
    if (find && text.includes(find)) {
      text = text.split(find).join(replace ?? '');
      changed = true;
    }
  }
  return changed ? Buffer.from(text, 'utf8') : buffer;
}

// The imported-vs-embedded seam: nestled-template consumes published libraries as
// packages, so dev-template's local `@nestled-template/data-browser` import and its Compose
// project name are rewritten on the way in. Also excludes wiring, template-owned docs/identity,
// and dev-authoring tooling that the cloneable template never carries. Extend via the config's
// `promotion.mirror` block or the promotion project's `mirror` key.
function defaultMirrorPolicy(config) {
  const dev = promotionSource(config).name;
  const tmpl = templateSource(config).name;
  return {
    excludePaths: [
      'nx.json',
      'tsconfig.base.json',
      'AGENTS.md',
      '.nestled/**',
      '.cursor/**',
      '.agents/**',
      '.opencode/**',
      '.junie/**',
      '.windsurf/**',
      '.gemini/**',
      '.codex/**',
      '.ai/**',
      'agents/**',
      'ai-docs/**',
      'plans/**',
      'tools/ai-migrations/**'
    ],
    substitutions: [
      { find: '@nestled-template/data-browser', replace: '@nestledjs/data-browser' },
      { find: `name: ${dev}`, replace: `name: ${tmpl}` }
    ]
  };
}

function mirrorPolicyFor(config, project) {
  const defaults = defaultMirrorPolicy(config);
  const configured = project.mirror || config.promotion?.mirror || {};
  const rawExcludes = project.promotion?.rawPatchExcludes || defaultTemplatePromotionPolicy().rawPatchExcludes;
  return {
    excludePaths: [...rawExcludes, ...defaults.excludePaths, ...(configured.excludePaths || [])],
    substitutions: [...defaults.substitutions, ...(configured.substitutions || [])]
  };
}

// Matches a `"<name>": "workspace:<anything>"` dependency entry, tolerant of JSON spacing
// (`"n": "workspace:*"` and minified `"n":"workspace:*"`) and of any workspace protocol
// (`workspace:*`, `workspace:^`, `workspace:~1.2.3`). Group 1 keeps the key and separator so only the
// version value is rewritten.
function workspaceRefRegex(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`("${escaped}"\\s*:\\s*)"workspace:[^"]*"`, 'g');
}

// The excluded internal libs' name+version AS OF a committed ref — read from Git, not the working
// tree, so the substitutions stay consistent with the files the mirror copies from origin/develop
// even when dev-template is checked out on another branch or is dirty. (findInternalLibVersions reads
// the working tree, which is right for syncPackagesFromPromotion but wrong for the committed mirror.)
function committedLibVersions(devPath, sha, promotionProject) {
  const excludes = [
    ...(promotionProject.promotion?.rawPatchExcludes || []),
    ...defaultTemplatePromotionPolicy().rawPatchExcludes
  ];
  return [...new Set(excludes)]
    .filter((p) => p.endsWith('/**') && !p.slice(0, -3).includes('*'))
    .map((p) => `${p.slice(0, -3)}/package.json`)
    .flatMap((rel) => {
      let pkg;
      try { pkg = JSON.parse(gitCommittedBlob(devPath, sha, rel).toString('utf8')); } catch { return []; }
      return pkg?.name && pkg?.version ? [{ name: pkg.name, version: pkg.version }] : [];
    });
}

// The imported-vs-embedded seam also lives in app-level package.json: dev-template consumes its own
// libraries via a `workspace:` ref while the cloneable template pins the published range those libs
// ship under. The package sync (syncPackagesFromPromotion) already reconciles that version, but the
// raw file mirror compares bytes — so without this it reports every app manifest carrying such a ref
// as drift on each promotion (and would transiently write the workspace ref before the sync corrects
// it), and a correct clone-template never mirrors clean. Translate each internal lib's `workspace:`
// ref to the `^version` the template declares — the same idea as the data-browser import
// substitution, but for the package.json version field. Real, non-seam manifest changes still flow.
// (fleet-upstream #103)
function internalLibWorkspaceSubstitutions(devPath, sha, promotionProject) {
  return committedLibVersions(devPath, sha, promotionProject).map(({ name, version }) => ({
    find: workspaceRefRegex(name),
    replace: `$1"^${version}"`
  }));
}

// The mirror deliberately skips a few files because they carry the imported-vs-embedded seam:
// package.json holds workspace: refs, tsconfig.base.json maps libraries the template consumes as
// packages, and sonar-project.properties names an analysis surface that differs by repo. Those
// exclusions are right, but they are silent — a script, a path alias, or an analysed source that
// appears upstream simply never arrives, and nobody learns until something breaks.
//
// So report the parts of those files that are structured enough to compare. Never write: the whole
// reason they are excluded is that a blind copy would be wrong.
function stripJsonComments(text) {
  // Enough for tsconfig files: line comments, block comments, and neither inside a string.
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += ch;
  }
  return out;
}

// Trailing commas are as common as comments in a hand-edited tsconfig, and JSON.parse rejects
// both. Returning null on failure would make an unparseable file look like "no drift" — the same
// direction as the bug this feature exists to catch — so failures are surfaced, not swallowed.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonish(text) {
  try {
    return { value: JSON.parse(stripTrailingCommas(stripJsonComments(text))) };
  } catch (error) {
    return { error: error.message };
  }
}

// A backslash-continued properties list, e.g. sonar.sources=\\\n  a,\\\n  b
function propertiesList(text, key) {
  // Line scan rather than a regex: the continuation escapes made the pattern unreadable and, as
  // written, wrong. Tolerates leading indentation, spaces around `=`, and trailing whitespace
  // after the continuation backslash — all of which appear in hand-maintained .properties files
  // and would otherwise silently yield no drift.
  const lines = text.split('\n');
  const matches = (line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith(key) && /^\s*=/.test(trimmed.slice(key.length));
  };
  const start = lines.findIndex(matches);
  if (start === -1) return null;

  const values = [];
  let line = lines[start].trimStart().slice(key.length).replace(/^\s*=/, '');
  let index = start;
  for (;;) {
    const trimmedEnd = line.trimEnd();
    const continues = trimmedEnd.endsWith('\\');
    const value = (continues ? trimmedEnd.slice(0, -1) : trimmedEnd).trim().replace(/,$/, '').trim();
    if (value) values.push(value);
    if (!continues) break;
    index += 1;
    if (index >= lines.length) break;
    line = lines[index];
  }
  return values;
}

function diffMaps(sourceMap, targetMap, ignore) {
  const skip = new Set(ignore || []);
  const missing = [];
  const differing = [];
  const targetOnly = [];
  for (const [key, value] of Object.entries(sourceMap || {})) {
    if (skip.has(key)) continue;
    if (!(key in (targetMap || {}))) missing.push({ key, source: value });
    else if (targetMap[key] !== value) differing.push({ key, source: value, target: targetMap[key] });
  }
  for (const key of Object.keys(targetMap || {})) {
    if (skip.has(key) || key in (sourceMap || {})) continue;
    targetOnly.push({ key, target: targetMap[key] });
  }
  return { missing, differing, targetOnly };
}

function listToMap(list) {
  return Object.fromEntries((list || []).map((item) => [item, item]));
}

export function collectExcludedFileDrift(devPath, sha, templatePath, ignore = {}) {
  const sourceText = (rel) => {
    try { return gitCommittedBlob(devPath, sha, rel).toString('utf8'); } catch { return null; }
  };
  const targetText = (rel) => {
    const abs = path.join(templatePath, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };

  const sections = [];

  const emptyDiff = { missing: [], differing: [], targetOnly: [] };

  // An unreadable file is itself drift worth reporting: staying silent would claim the comparison
  // succeeded and found nothing, which is the failure this whole section exists to prevent.
  const parsedPair = (rel) => {
    const src = sourceText(rel);
    const tgt = targetText(rel);
    if (src === null || tgt === null) return { skip: true };
    const a = parseJsonish(src);
    const b = parseJsonish(tgt);
    if (a.error || b.error) {
      return {
        unreadable: a.error ? `source: ${a.error}` : `template: ${b.error}`
      };
    }
    return { source: a.value, target: b.value };
  };

  const pkg = parsedPair('package.json');
  if (pkg.unreadable) {
    sections.push({ file: 'package.json', field: 'scripts', unreadable: pkg.unreadable, ignored: [], ...emptyDiff });
  } else if (!pkg.skip) {
    sections.push({
      file: 'package.json',
      field: 'scripts',
      ignored: ignore.scripts || [],
      ...diffMaps(pkg.source.scripts, pkg.target.scripts, ignore.scripts)
    });
  }

  const ts = parsedPair('tsconfig.base.json');
  if (ts.unreadable) {
    sections.push({ file: 'tsconfig.base.json', field: 'compilerOptions.paths', unreadable: ts.unreadable, ignored: [], ...emptyDiff });
  } else if (!ts.skip) {
    // Order is preserved, not sorted: TypeScript tries path targets in order and takes the first
    // match, so two orderings are two different resolution behaviours. Sorting would hide that.
    const flatten = (cfg) =>
      Object.fromEntries(
        Object.entries(cfg?.compilerOptions?.paths || {}).map(([k, v]) => [k, [].concat(v).join(', ')])
      );
    sections.push({
      file: 'tsconfig.base.json',
      field: 'compilerOptions.paths',
      ignored: ignore.paths || [],
      ...diffMaps(flatten(ts.source), flatten(ts.target), ignore.paths)
    });
  }

  const devSonar = sourceText('sonar-project.properties');
  const tmplSonar = targetText('sonar-project.properties');
  if (devSonar && tmplSonar) {
    sections.push({
      file: 'sonar-project.properties',
      field: 'sonar.sources',
      ignored: ignore.sonarSources || [],
      ...diffMaps(
        listToMap(propertiesList(devSonar, 'sonar.sources')),
        listToMap(propertiesList(tmplSonar, 'sonar.sources')),
        ignore.sonarSources
      )
    });
  }

  return sections.filter((s) => s.unreadable || s.missing.length || s.differing.length || s.targetOnly.length);
}

// Mirror dev-template's tracked product files into nestled-template. Copies every tracked source
// file except the excluded wiring/docs/tooling, applying import/name substitutions. Additive
// only: it never deletes, but reports template-only files so nothing is silently missed.
export function mirrorTemplateFromSource(config, root = ROOT, { dryRun = false } = {}) {
  const devPath = path.resolve(root, promotionSource(config).path);
  const templatePath = path.resolve(root, templateSource(config).path);
  const project = templatePromotionProject(config);
  const { excludePaths, substitutions: policySubstitutions } = mirrorPolicyFor(config, project);

  // The source is read entirely from a committed ref — its working tree is deliberately irrelevant,
  // so an operator can promote while mid-change on another branch without leaking that work.
  const sourceRef = resolvePromotionRef(devPath);
  const sourceCommit = sourceRef.short;
  // Add the workspace→published translation for app-level manifests so the intentional seam does not
  // read as drift (fleet-upstream #103). Read the lib versions from the SAME committed ref the mirror
  // copies from, not the working tree, so a dirty or branched dev-template checkout can't skew them.
  const substitutions = [
    ...policySubstitutions,
    ...internalLibWorkspaceSubstitutions(devPath, sourceRef.sha, project)
  ];

  const targetCommit = gitOutput(templatePath, ['rev-parse', '--short', 'HEAD']);
  const devFiles = gitCommittedFiles(devPath, sourceRef.sha);
  const templateFiles = new Set(gitTrackedFiles(templatePath));

  const changes = [];
  for (const rel of devFiles) {
    if (mirrorPathExcluded(rel, excludePaths)) continue;
    const content = applyMirrorSubstitutions(gitCommittedBlob(devPath, sourceRef.sha, rel), substitutions);
    const dstAbs = path.join(templatePath, rel);
    const existing = fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs) : null;
    if (existing && existing.equals(content)) continue;
    changes.push({ path: rel, kind: existing ? 'modified' : 'new' });
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.writeFileSync(dstAbs, content);
    }
  }
  const devFileSet = new Set(devFiles);
  const templateOnly = [...templateFiles]
    .filter((rel) => !devFileSet.has(rel) && !mirrorPathExcluded(rel, excludePaths))
    .sort();
  const drift = collectExcludedFileDrift(
    devPath,
    sourceRef.sha,
    templatePath,
    config.promotion?.driftIgnore || {}
  );

  return {
    drift,
    source: promotionSource(config).name,
    sourceRef: sourceRef.ref,
    sourceSha: sourceRef.sha,
    sourceCommit,
    targetCommit,
    dryRun,
    changes,
    templateOnly
  };
}

// Rendered as guidance, not a task list. Several of these differences are permanent and correct —
// dev-template publishes libraries the template consumes — so the section names what is missing and
// leaves the judgement to the operator. Anything known-permanent belongs in promotion.driftIgnore
// so the report keeps its signal.
function renderDriftSection(drift) {
  if (!drift || drift.length === 0) return ['- (none)'];
  const lines = [];
  for (const section of drift) {
    lines.push(`### ${section.file} — ${section.field}`, '');
    for (const item of section.missing) lines.push(`- missing in template: \`${item.key}\``);
    for (const item of section.differing) {
      lines.push(`- differs: \`${item.key}\``);
      lines.push(`  - source:   \`${item.source}\``);
      lines.push(`  - template: \`${item.target}\``);
    }
    for (const item of section.targetOnly) lines.push(`- template-only: \`${item.key}\``);
    if (section.unreadable) lines.push(`- could not compare — ${section.unreadable}`);
    if (section.ignored?.length) lines.push('', `_Ignored by config: ${section.ignored.join(', ')}_`);
    lines.push('');
  }
  return lines;
}

function writeMirrorReport(mirror, packageSync, root = ROOT) {
  const dir = path.join(root, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const news = mirror.changes.filter((c) => c.kind === 'new');
  const mods = mirror.changes.filter((c) => c.kind === 'modified');
  const lines = [
    '# Template Promotion Mirror',
    '',
    `Source: ${mirror.source}@${mirror.sourceCommit} → nestled-template@${mirror.targetCommit}`,
    // The exact commit promoted, and where it came from. The short sha alone was ambiguous once the
    // mirror could read a working tree; recording ref + full sha makes a promotion reproducible.
    `Source ref: ${mirror.sourceRef ?? 'origin/develop'} @ ${mirror.sourceSha ?? mirror.sourceCommit}`,
    `Mode: ${mirror.dryRun ? 'dry-run (no files written)' : 'applied to working tree'}`,
    `Files changed: ${mirror.changes.length} (${news.length} new, ${mods.length} modified)`,
    '',
    '## New files',
    '',
    ...(news.length ? news.map((c) => `- ${c.path}`) : ['- (none)']),
    '',
    '## Modified files',
    '',
    ...(mods.length ? mods.map((c) => `- ${c.path}`) : ['- (none)']),
    '',
    '## Excluded-file drift (the mirror does not carry these)',
    '',
    ...renderDriftSection(mirror.drift),
    '',
    '## Template-only files (kept, not present in source)',
    '',
    ...(mirror.templateOnly.length ? mirror.templateOnly.map((p) => `- ${p}`) : ['- (none)'])
  ];
  if (packageSync?.updates?.length) {
    lines.push('', '## Package version updates', '');
    for (const u of packageSync.updates) {
      const location = u.manifest && u.manifest !== 'package.json' ? ` (${u.manifest})` : '';
      lines.push(`- ${u.name}${location}: ${u.from ?? '(absent)'} → ${u.to}`);
    }
  }
  fs.writeFileSync(path.join(dir, 'promotion-mirror.md'), `${lines.join('\n')}\n`);
}

export function syncPackagesFromPromotion(config, root = ROOT, { dryRun = false } = {}) {
  const devPath = path.resolve(root, promotionSource(config).path);
  const templatePath = path.resolve(root, templateSource(config).path);
  let promotionProject;
  try { promotionProject = templatePromotionProject(config); } catch {
    return { status: 'skipped', reason: 'No template promotion target configured.', updates: [] };
  }

  const devPkg = safeReadPackageJson(path.join(devPath, 'package.json'));
  const tmplPkg = safeReadPackageJson(path.join(templatePath, 'package.json'));
  if (!devPkg || !tmplPkg) {
    return { status: 'skipped', reason: 'Could not read one or both root package.json files.', updates: [] };
  }

  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const updates = [];
  const templateManifests = packageManifestsByRelativePath(templatePath);
  const sourceManifests = packageManifestsByRelativePath(devPath);

  for (const field of depFields) {
    for (const [name, tmplVersion] of Object.entries(tmplPkg[field] || {})) {
      const devVersion = findVersionInPkg(devPkg, name);
      if (!devVersion || isWorkspaceRef(devVersion)) continue;
      if (devVersion === tmplVersion) continue;
      updates.push({
        type: 'external',
        manifest: 'package.json',
        field,
        name,
        from: tmplVersion,
        to: devVersion
      });
    }
  }

  for (const { name, version } of findInternalLibVersions(devPath, promotionProject)) {
    const targetVersion = `^${version}`;
    for (const [manifest, templateManifest] of templateManifests) {
      const sourceManifest = sourceManifests.get(manifest);
      const templateField = findDepField(templateManifest, name);
      const sourceField = sourceManifest ? findDepField(sourceManifest, name) : null;
      const field = templateField || sourceField;
      if (!field) continue;
      const currentVersion = templateField ? templateManifest[templateField][name] : undefined;
      if (currentVersion === targetVersion) continue;
      updates.push({
        type: 'internal',
        manifest,
        field,
        name,
        from: currentVersion,
        to: targetVersion
      });
    }
  }

  for (const { label, setPath } of [
    { label: 'overrides', setPath: ['overrides'] },
    { label: 'pnpm.overrides', setPath: ['pnpm', 'overrides'] },
    { label: 'resolutions', setPath: ['resolutions'] },
  ]) {
    const devObj = getNestedValue(devPkg, setPath);
    if (!devObj) continue;
    const tmplObj = getNestedValue(tmplPkg, setPath) || {};
    for (const [name, devValue] of Object.entries(devObj)) {
      if (isWorkspaceRef(devValue)) continue;
      if (tmplObj[name] === devValue) continue;
      updates.push({
        type: 'override',
        manifest: 'package.json',
        field: label,
        setPath,
        name,
        from: tmplObj[name] ?? null,
        to: devValue
      });
    }
  }

  if (updates.length === 0) return { status: 'up-to-date', updates: [] };
  if (dryRun) return { status: 'dry-run', updates };

  const changedManifests = new Map();
  for (const update of updates) {
    const manifest = update.manifest || 'package.json';
    const packageJson = changedManifests.get(manifest)
      || structuredClone(templateManifests.get(manifest));
    if (update.setPath) {
      let cursor = packageJson;
      for (const key of update.setPath) { cursor[key] ??= {}; cursor = cursor[key]; }
      cursor[update.name] = update.to;
    } else {
      packageJson[update.field] ??= {};
      packageJson[update.field][update.name] = update.to;
    }
    changedManifests.set(manifest, packageJson);
  }
  for (const [manifest, packageJson] of changedManifests) {
    fs.writeFileSync(path.join(templatePath, manifest), `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  // Deliberately NOT committed. This used to call commitPackageSync(), which ran `git add -A` and
  // committed the whole working tree under a message naming only the package bumps — so a single
  // promotion produced one commit carrying the entire mirror plus whatever else the operator had
  // in progress, described as if it were a version bump. It also landed on whatever branch was
  // checked out (in practice the integration branch) before anyone had read the mirror report.
  // Promotion now writes and reports only; committing is the reviewer's step. See docs/HOWTO.md.
  const lockfile = updateLockfile(templatePath);
  if (lockfile.status !== 0) {
    return { status: 'blocked', reason: `Package sync applied but lockfile update failed: ${lockfile.reason}`, updates };
  }
  return { status: 'applied', updates };
}

export function upgradeAll(config, upgrades, root = ROOT, options = {}) {
  const results = [];
  for (const project of downstreamProjects(config)) {
    for (const upgrade of downstreamUpgrades(config, upgrades)) {
      const log = readUpgradeLog(project, root);
      const existing = logEntryForUpgrade(log.upgrades || {}, upgrade);
      if (existing?.status && existing.status !== 'pending') {
        results.push({ project: project.name, upgrade: upgrade.id, recommendation: 'no-op', reason: `Already ${existing.status}.` });
        continue;
      }
      results.push(applyUpgrade(project, upgrade, config, root, options));
    }
  }
  writeRollupReport(results, root);
  writeExtractionRecommendations(config, downstreamUpgrades(config, upgrades), root);
  return results;
}

export function runWorkflow(config, root = ROOT, options = {}) {
  const discovered = addDiscoveredProjects(config, root);
  const promotion = hasTemplatePromotionTarget(config)
    ? promoteTemplate(config, root, { dryRun: options.dryRunOnly, allowDirty: options.allowDirty })
    : { project: '(none)', sync: { created: false, reason: 'No template promotion target configured.' }, mirror: null };
  const sync = syncTemplate(config, root);
  const upgrades = loadUpgrades(root);
  const dryRun = planAll(config, upgrades, root);
  const apply = options.dryRunOnly ? [] : upgradeAll(config, upgrades, root, { allowDirty: options.allowDirty });
  if (options.dryRunOnly) writeExtractionRecommendations(config, downstreamUpgrades(config, upgrades), root);
  return { discovered, promotion, sync, dryRun, apply };
}

export function reportForProject(project, upgrades, root = ROOT) {
  const log = readUpgradeLog(project, root);
  const entries = log.upgrades || {};
  const lines = [`# Upgrade Report: ${project.name}`, ''];
  for (const upgrade of upgrades) {
    const entry = logEntryForUpgrade(entries, upgrade) || { status: 'pending' };
    lines.push(`- ${upgrade.id}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  const blocked = Object.entries(entries).filter(([, entry]) => entry.status === 'blocked');
  if (blocked.length) {
    lines.push('', '## Blocked Decisions', '');
    for (const [id, entry] of blocked) lines.push(`- ${id}: ${entry.reason || entry.notes || 'No reason recorded.'}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeApplyReport(project, upgrade, result, root) {
  const dir = path.join(root, 'reports', project.name);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${upgrade.id}.md`);
  const lines = [
    `# ${upgrade.title || upgrade.id}`,
    '',
    `Project: ${project.name}`,
    `Upgrade: ${upgrade.id}`,
    `Mode: apply`,
    `Outcome: ${applyOutcome(result)}`,
    `Branch: ${result.branch || '(none)'}`,
    '',
    `Reason: ${result.reason}`,
    '',
    '## Package Releases',
    '',
    packageReleaseReportLine(result.packageRelease),
    '',
    '## Patch',
    '',
    result.patch ? patchReportLine(result.patch) : '- Not attempted.',
    '',
    '## Verification',
    '',
    ...(result.verification?.length ? result.verification.map((item) => `- ${item.command}: ${item.status === 0 ? 'passed' : 'failed'}`) : ['- Not run.']),
    '',
    '## Agent Next Step',
    '',
    result.patch?.applied ? 'Review the branch commit and open the downstream PR when ready.' : 'Inspect the intent and affected paths, then adapt the downstream implementation manually or with a coding agent.'
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function writeRollupReport(results, root) {
  const dir = path.join(root, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'upgrade-rollup.md');
  const lines = ['# Upgrade Rollup', ''];
  for (const result of results) {
    lines.push(`- ${result.project}/${result.upgrade}: ${result.recommendation || (result.patch?.applied ? 'applied' : 'blocked')} - ${result.reason || 'No reason recorded.'}`);
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function templatePromotionProject(config) {
  const configured = (config.projects || []).find((project) => project.role === 'template-promotion')
    || (config.projects || []).find((project) => project.name === 'nestled-template');
  if (!configured) throw new Error('No template promotion target configured. Add nestled-template to projects.');
  return {
    ...configured,
    role: configured.role || 'template-promotion',
    promotion: {
      ...defaultTemplatePromotionPolicy(),
      ...(configured.promotion || {}),
      rawPatchExcludes: [
        ...defaultTemplatePromotionPolicy().rawPatchExcludes,
        ...(configured.rawPatchExcludes || []),
        ...((configured.promotion || {}).rawPatchExcludes || [])
      ]
    }
  };
}

function hasTemplatePromotionTarget(config) {
  return (config.projects || []).some((project) => project.role === 'template-promotion' || project.name === 'nestled-template');
}

export function downstreamProjects(config) {
  return (config.projects || []).filter((project) => project.role !== 'template-promotion');
}

// The per-repo marker written at the end of a convergence pass (playbook §10): which nestled-template
// commit this repo was last brought into agreement with. Lives in .nestled/ (excluded from the mirror,
// so promotion never rewrites it). A couple of `key: value` lines, parsed leniently.
function readConvergenceMarker(repoPath) {
  const file = path.join(repoPath, '.nestled', 'converged-at');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const sha = text.match(/template-sha:\s*([0-9a-f]{7,40})/i)?.[1];
  const date = text.match(/date:\s*(\S+)/i)?.[1];
  return sha ? { sha, date } : null;
}

// Per-repo convergence currency: how far each downstream repo's recorded convergence point trails the
// current nestled-template HEAD. End-state convergence makes provenance irrelevant — the only question
// is "has the template moved since this repo was last brought level?" — so this answers it fleet-wide
// at once, from each repo's `.nestled/converged-at` marker vs the template's local HEAD.
// The enforcement surface: the checks a repo is judged by. These are template-owned and
// identity-free — the promotion mirror copies them verbatim — so a downstream copy that differs
// has been edited locally. That is not automatically wrong (playbook §0 sanctions a temporary
// local fix while the real one goes upstream), but it must be VISIBLE. Until now nothing compared
// them, so a weakened check and a pending-upstream patch looked identical: invisible.
// Both prefixes in both directories, and .mjs as well as .ts. The first cut matched only
// scripts/doctor*.ts and tools/verify-*.ts, which silently excluded five enforcement files CI
// actually runs — scripts/verify-prisma-client.ts, tools/verify-selects.mjs,
// tools/verify-select-coverage.mjs and the two .mjs specs. A drift report with an arbitrary blind
// spot is worse than none: the gap is invisible from its clean output.
const ENFORCEMENT_DIRECTORIES = ['scripts', 'tools'].map((dir) => ({
  dir,
  match: (name) => /^(?:doctor|verify-).*\.(?:ts|mjs)$/.test(name)
}));

// Every sanctioned way a repo may hold less than the full rule set. Each is a deliberate escape
// hatch; the point of listing them here is that "who holds an exception" becomes one question
// against the fleet rather than nine separate archaeology digs.
const EXCEPTION_FILES = [
  { label: 'guard-baseline', file: '.nestled-updates/security/guard-baseline.json', counts: 'nested' },
  { label: 'public-operations', file: '.nestled-updates/security/public-operations.json', counts: 'nested' },
  { label: 'permission-exemptions', file: '.nestled-updates/security/permission-exemptions.json', counts: 'nested' },
  { label: 'sdk-contract-baseline', file: '.nestled-updates/sdk-contract-baseline.json', counts: 'flat' },
  { label: 'sdk-contract-exceptions', file: '.nestled-updates/sdk-contract-exceptions.json', counts: 'flat' },
  { label: 'generated-crud-posture', file: '.nestled-updates/security/generated-crud-posture.json', counts: 'posture' }
];

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function enforcementFiles(basePath) {
  const found = [];
  for (const { dir, match } of ENFORCEMENT_DIRECTORIES) {
    const full = path.join(basePath, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (match(name)) found.push(path.posix.join(dir, name));
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * Compare a repo's enforcement files against the template's.
 *
 * `missing` matters as much as `differing`: deleting a check is the quietest way to pass it.
 */
const ENFORCEMENT_PACKAGE = '@nestledjs/doctor';

export function enforcementDrift(templatePath, repoPath) {
  const expected = enforcementFiles(templatePath);
  const differing = [];
  const missing = [];

  for (const relative of expected) {
    const repoFile = path.join(repoPath, relative);
    if (!fs.existsSync(repoFile)) {
      missing.push(relative);
      continue;
    }
    if (sha256(repoFile) !== sha256(path.join(templatePath, relative))) differing.push(relative);
  }

  const extra = enforcementFiles(repoPath).filter((relative) => !expected.includes(relative));
  return { checked: expected.length, differing, missing, extra };
}

/**
 * What a manifest declares for the enforcement package.
 *
 * Absent, missing and unreadable are three different repo states with three different fixes, and
 * collapsing them into null would report a manifest this tool simply failed to parse as a
 * deliberate decision not to depend on the enforcement package -- pointing the reader at the wrong
 * repair. `exceptionInventory` already draws this distinction; this matches it.
 */
function declaredDoctor(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { state: 'no-manifest' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { state: 'unreadable' };
  }
  const spec =
    parsed?.devDependencies?.[ENFORCEMENT_PACKAGE] ?? parsed?.dependencies?.[ENFORCEMENT_PACKAGE] ?? null;
  return spec ? { state: 'declared', spec } : { state: 'absent' };
}

/**
 * What the lockfile actually resolved the enforcement package to.
 *
 * The manifest states an intent; the lockfile states what runs. A caret range satisfies the manifest
 * while resolving to whatever was current when the lockfile was last written, so reading the
 * manifest alone can call a repo current while it executes an older build of the checks.
 */
function resolvedDoctor(repoPath) {
  const lock = path.join(repoPath, 'pnpm-lock.yaml');
  if (!fs.existsSync(lock)) return null;
  const text = fs.readFileSync(lock, 'utf8');
  // The importer entry lists `specifier:` then `version:`; the version carries peer suffixes in
  // parentheses that are not part of the package's own version.
  const match = text.match(
    new RegExp(`'${ENFORCEMENT_PACKAGE}':\\s*\\n\\s*specifier:[^\\n]*\\n\\s*version:\\s*([0-9][^\\s(]*)`)
  );
  return match ? match[1] : null;
}

/** Compare dotted numeric versions. Returns <0, 0, or >0. Non-numeric parts sort as 0. */
function compareVersions(left, right) {
  const parts = (value) => String(value).split('.').map((piece) => Number.parseInt(piece, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Compare the enforcement package a repo actually runs against the template's.
 *
 * Enforcement moved from ~7,400 copied lines into a versioned dependency, which means the file
 * comparison in `enforcementDrift` no longer sees most of it: a repo can hold byte-identical
 * config, carry no extra checks, and still run a build of the checks with a known bug in it.
 * `promote-template` cannot close this gap either, since the mirror excludes `package.json` --
 * the version only ever travels as an instruction, so something has to verify it arrived.
 *
 * Older than the template is drift. Newer is not: a repo that took a fix first is ahead, not
 * broken, and flagging it would train readers to ignore this line.
 */
export function enforcementVersion(templatePath, repoPath) {
  const templateManifest = declaredDoctor(path.join(templatePath, 'package.json'));
  if (templateManifest.state === 'unreadable') return { state: 'template-unreadable' };
  const expected = resolvedDoctor(templatePath) ?? templateManifest.spec ?? null;
  // A template that declares no enforcement package cannot judge anyone.
  if (!expected) return { state: 'untracked' };

  const manifest = declaredDoctor(path.join(repoPath, 'package.json'));
  if (manifest.state === 'unreadable') return { state: 'unreadable', expected };
  if (manifest.state === 'no-manifest') return { state: 'no-manifest', expected };

  const actual = resolvedDoctor(repoPath) ?? manifest.spec ?? null;
  if (!actual) {
    return manifest.state === 'declared'
      ? { state: 'unresolved', expected }
      : { state: 'absent', expected };
  }

  const order = compareVersions(actual, expected);
  if (order < 0) return { state: 'drift', expected, actual };
  return { state: order > 0 ? 'ahead' : 'ok', expected, actual };
}

function countExceptionEntries(value, counts) {
  if (counts === 'posture') {
    return value && typeof value === 'object' && typeof value.posture === 'string' ? 1 : 0;
  }
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.length;
  if (counts === 'flat') return Object.keys(value).length;
  return Object.values(value).reduce(
    (total, entry) => total + (entry && typeof entry === 'object' ? Object.keys(entry).length : 1),
    0
  );
}

/** Every sanctioned exception a repo currently holds, with its entry count. */
export function exceptionInventory(repoPath) {
  const held = [];
  for (const { label, file, counts } of EXCEPTION_FILES) {
    const full = path.join(repoPath, file);
    if (!fs.existsSync(full)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      held.push({ label, entries: null, unreadable: true });
      continue;
    }
    const entries = countExceptionEntries(parsed, counts);
    const detail = counts === 'posture' && parsed?.posture ? String(parsed.posture) : null;
    if (entries > 0) held.push({ label, entries, detail });
  }
  return held;
}

// The dev-port formula (PIR-260). App ports stride by 1, infra by 10, so a block's dev/test
// Postgres pair never overlaps the next block's.
const PORT_FORMULA = [
  { key: 'PORT', base: 3000, stride: 1 },
  { key: 'WEB_PORT', base: 4200, stride: 1 },
  { key: 'WEB_PREVIEW_PORT', base: 4300, stride: 1 },
  { key: 'POSTGRES_PORT', base: 5432, stride: 10 },
  { key: 'POSTGRES_TEST_PORT', base: 5433, stride: 10 },
  { key: 'REDIS_PORT', base: 6379, stride: 10 },
  { key: 'MAILHOG_SMTP_PORT', base: 1025, stride: 10 },
  { key: 'MAILHOG_UI_PORT', base: 8025, stride: 10 }
];

export function expectedPorts(block) {
  return Object.fromEntries(
    PORT_FORMULA.map(({ key, base, stride }) => [key, base + stride * block])
  );
}

/**
 * Read ONLY the port keys out of a repo's .env.
 *
 * Deliberately key-scoped rather than a general parser: .env holds credentials, and a tool that
 * reads all of it is one refactor away from printing all of it.
 */
function readDeclaredPorts(repoPath) {
  const envPath = path.join(repoPath, '.env');
  if (!fs.existsSync(envPath)) return null;
  const wanted = new Set(PORT_FORMULA.map(({ key }) => key));
  const declared = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_]+)\s*=\s*(\d+)\s*$/.exec(line);
    if (match && wanted.has(match[1])) declared[match[1]] = Number(match[2]);
  }
  return declared;
}

/**
 * Does this repo's .env match the block it was assigned?
 *
 * `unset` is not a pass. Every port in the formula has a default that lands on block 0 — compose
 * uses `${POSTGRES_PORT:-5432}` — so an unset variable silently claims the TEMPLATE's port. That is
 * exactly how one repo came to hold 5432, 1025 and 8025 while its assignment said otherwise, and
 * nothing anywhere reported it.
 */
export function portConformance(repoPath, block) {
  if (block === undefined || block === null) return { state: 'unassigned' };
  const declared = readDeclaredPorts(repoPath);
  if (!declared) return { state: 'no-env', block };

  const expected = expectedPorts(block);
  const blockZero = expectedPorts(0);
  const mismatched = [];
  const unset = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in declared)) {
      // Block 0 IS the default, so an unset variable there lands on the right port. Recording it as
      // a deviation would report drift the reader cannot act on — and would count a repo as drifted
      // while printing nothing to explain why.
      if (block !== 0) unset.push({ key, expected: value, fallsBackTo: blockZero[key] });
      continue;
    }
    if (declared[key] !== value) mismatched.push({ key, declared: declared[key], expected: value });
  }
  return { state: mismatched.length === 0 && unset.length === 0 ? 'ok' : 'drift', block, mismatched, unset };
}

export function convergenceStatus(config, root = ROOT) {
  const templateProject = templateSource(config);
  const templatePath = path.resolve(root, templateProject.path);
  const templateHead = gitOutput(templatePath, ['rev-parse', 'HEAD']);
  const rows = downstreamProjects(config).map((project) => {
    const repoPath = path.resolve(root, project.path);
    if (!isGitRepo(repoPath)) return { project: project.name, state: 'missing', repoPath };
    // Independent of the marker: a repo can be perfectly current and still be running edited
    // checks, and a repo that never converged can still be asked what it holds.
    const drift = enforcementDrift(templatePath, repoPath);
    const exceptions = exceptionInventory(repoPath);
    const ports = portConformance(repoPath, project.portBlock);
    const version = enforcementVersion(templatePath, repoPath);
    const marker = readConvergenceMarker(repoPath);
    if (!marker) return { project: project.name, state: 'never', repoPath, drift, exceptions, ports, version };
    // Ancestry, not mere existence: a marker recorded from a branch tip that never landed (squash
    // merges leave those SHAs in the object store) must read as unknown, not as a huge behind-count.
    const inHistory =
      templateHead &&
      commitExists(templatePath, marker.sha) &&
      gitSucceeds(templatePath, ['merge-base', '--is-ancestor', marker.sha, templateHead]);
    if (!inHistory) {
      return {
        project: project.name,
        state: 'unknown',
        sha: marker.sha.slice(0, 7),
        date: marker.date,
        drift,
        exceptions,
        ports,
        version
      };
    }
    const behind = Number(
      gitOutput(templatePath, ['rev-list', '--count', `${marker.sha}..${templateHead}`]) || '0'
    );
    return {
      project: project.name,
      state: behind === 0 ? 'current' : 'behind',
      sha: marker.sha.slice(0, 7),
      date: marker.date,
      behind,
      drift,
      exceptions,
      ports,
      version
    };
  });
  return {
    template: templateProject.name,
    templateHead,
    templateHeadShort: templateHead ? templateHead.slice(0, 7) : null,
    rows
  };
}

function downstreamUpgrades(config, upgrades) {
  const sourceName = templateSource(config).name;
  return upgrades.filter((upgrade) => !upgrade.sourceRepo || upgrade.sourceRepo === sourceName);
}

function promotionUpgrades(config, upgrades) {
  const sourceName = promotionSource(config).name;
  return upgrades.filter((upgrade) => !upgrade.sourceRepo || upgrade.sourceRepo === sourceName);
}

function defaultTemplatePromotionPolicy() {
  return {
    rawPatchExcludes: [
      'package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'libs/data-browser/**',
      'libs/shared-components/**',
      'libs/access-control/**'
    ]
  };
}

export function writeExtractionRecommendations(config, upgrades, root = ROOT) {
  const recommendableAreas = new Set(['auth', 'billing', 'api', 'database', 'codegen', 'infra']);
  const recommendations = [];
  for (const upgrade of upgrades) {
    if (!recommendableAreas.has(upgrade.area)) continue;
    if (deliveryIncludesPackage(upgrade)) continue;
    const appliedProjects = [];
    const skippedProjects = [];
    for (const project of config.projects || []) {
      const status = logEntryForUpgrade(readUpgradeLog(project, root).upgrades || {}, upgrade)?.status || 'pending';
      if (status === 'applied' || status === 'adapted') appliedProjects.push(project.name);
      if (status === 'skipped' || status === 'not-applicable' || status === 'blocked' || status === 'pending') skippedProjects.push(project.name);
    }
    if (appliedProjects.length < 3 || skippedProjects.length > 0) continue;
    const recommendation = {
      type: 'extract-library',
      upgrade: upgrade.id,
      area: upgrade.area,
      candidatePackage: candidatePackageName(upgrade.area),
      reason: `Same ${upgrade.area} upgrade applied or adapted across ${appliedProjects.length} projects.`,
      projects: appliedProjects
    };
    const dir = path.join(root, 'reports', 'recommendations');
    fs.mkdirSync(dir, { recursive: true });
    writeYamlFile(path.join(dir, `${upgrade.id}-extract-library.yaml`), recommendation);
    recommendations.push(recommendation);
  }
  return recommendations;
}

function recordOutcome(log, id, entry) {
  log.upgrades[id] = entry;
}

function markTemplateReviewed(log, upgrade) {
  const to = String(upgrade.sourceCommitRange || '').split('..')[1];
  if (to) log.template.lastReviewedCommit = to;
}

function looksLikeProject(absolute) {
  if (fs.existsSync(path.join(absolute, '.nestled'))) return true;
  const packageJsonPath = path.join(absolute, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const workspaces = Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces
      : [...Object.keys(packageJson.workspaces || {}), ...Object.values(packageJson.workspaces || {}).flat()];
    const searchable = [
      packageJson.name,
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {}),
      ...workspaces
    ].join('\n');
    return /nestled/i.test(searchable);
  } catch {
    return false;
  }
}

function inferVerification(absolute) {
  if (!fs.existsSync(path.join(absolute, 'package.json'))) return [];
  return ['pnpm lint', 'pnpm test'];
}

function gitOutput(cwd, args) {
  if (!fs.existsSync(cwd)) return '';
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function commitExists(cwd, commit) {
  if (!commit) return false;
  const result = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, encoding: 'utf8' });
  return result.status === 0;
}

function gitSucceeds(cwd, args) {
  if (!fs.existsSync(cwd)) return false;
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;
}

function isGitRepo(cwd) {
  return gitOutput(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function hasUncommittedChanges(cwd) {
  const status = gitOutput(cwd, ['status', '--porcelain']);
  return status.split('\n')
    .filter(Boolean)
    .some((line) => !line.includes('.nestled/'));
}

function checkoutBranch(cwd, branch) {
  const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, encoding: 'utf8' });
  const args = existing.status === 0 ? ['checkout', branch] : ['checkout', '-b', branch];
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Unable to checkout ${branch}: ${result.stderr || result.stdout}`);
}

function tryApplyPatch(cwd, upgrade, root, project = {}) {
  const patchRef = upgrade.patch?.path;
  if (!patchRef) return { applied: false, output: 'Upgrade record has no patch.path.' };
  const patchPath = path.resolve(root, patchRef);
  if (!fs.existsSync(patchPath)) return { applied: false, output: `Patch file not found: ${patchPath}` };
  const excludes = patchExcludesFor(project, upgrade);
  const excludeArgs = excludes.map((pattern) => `--exclude=${pattern}`);
  const check = spawnSync('git', ['apply', ...excludeArgs, '--check', patchPath], { cwd, encoding: 'utf8' });
  if (check.status !== 0) {
    const reverse = spawnSync('git', ['apply', ...excludeArgs, '--reverse', '--check', patchPath], { cwd, encoding: 'utf8' });
    if (reverse.status === 0) return { applied: false, alreadyApplied: true, output: 'Reverse patch check succeeded.', excludedPaths: excludes };
    // Direct check failed and reverse check failed — some hunks may have already landed via
    // a different path (e.g. a patch that bundled earlier changes already merged separately).
    // Try 3-way merge, which resolves already-applied hunks as no-ops.
    const apply3way = spawnSync('git', ['apply', '--3way', ...excludeArgs, patchPath], { cwd, encoding: 'utf8' });
    if (apply3way.status === 0) return { applied: true, via3way: true, output: apply3way.stderr || apply3way.stdout, excludedPaths: excludes };
    // 3-way may have left partial state (modified files or conflict markers) — reset the working tree.
    spawnSync('git', ['checkout', '--', '.'], { cwd, encoding: 'utf8' });
    return { applied: false, output: check.stderr || check.stdout, excludedPaths: excludes };
  }
  const apply = spawnSync('git', ['apply', ...excludeArgs, patchPath], { cwd, encoding: 'utf8' });
  return { applied: apply.status === 0, output: apply.stderr || apply.stdout, excludedPaths: excludes };
}

function runVerification(project, upgrade, cwd) {
  const commands = [...new Set([...(project.verification || []), ...(upgrade.verification || [])])];
  return commands.map((command) => {
    if (typeof command !== 'string') return { command: JSON.stringify(command), status: 1, output: '', error: 'Verification command is not a string; check upgrade note YAML for unquoted colons.' };
    const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
    return { command, status: result.status, output: result.stdout, error: result.stderr };
  });
}

function changedTemplatePaths(templatePath, from, to) {
  const result = spawnSync('git', ['diff', '--name-only', `${from}..${to}`], { cwd: templatePath, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function upgradeNotesFromRange(templatePath, from, to) {
  return changedTemplatePaths(templatePath, from, to)
    .filter((filePath) => /^\.nestled-updates\/upgrade-notes\/.+\.ya?ml$/.test(filePath))
    .map((filePath) => readTemplateFileAtCommit(templatePath, to, filePath))
    .filter(Boolean)
    .map((source) => parseYaml(source));
}

function readTemplateFileAtCommit(templatePath, commit, filePath) {
  const result = spawnSync('git', ['show', `${commit}:${filePath}`], { cwd: templatePath, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function inferArea(paths) {
  const joined = paths.join('\n');
  if (/auth/i.test(joined)) return 'auth';
  if (/billing|stripe/i.test(joined)) return 'billing';
  if (/database|schema|migration|prisma/i.test(joined)) return 'database';
  if (/api/i.test(joined)) return 'api';
  if (/web|app\/routes|ui/i.test(joined)) return 'web';
  if (/infra|docker|ci|workflow/i.test(joined)) return 'infra';
  if (/doc|readme/i.test(joined)) return 'docs';
  return 'codegen';
}

function candidatePackageName(area) {
  return `@nestledjs/${area}`;
}

function latestUpgradeCommit(root) {
  const upgrades = loadUpgrades(root)
    .map((upgrade) => String(upgrade.sourceCommitRange || '').split('..')[1])
    .filter(Boolean);
  return upgrades.at(-1) || '';
}

function commitUpgrade(cwd, upgradeId) {
  const status = gitOutput(cwd, ['status', '--porcelain']);
  if (!status) return gitOutput(cwd, ['rev-parse', '--short', 'HEAD']);
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  if (add.status !== 0) return '';
  const commit = spawnSync('git', ['commit', '--no-gpg-sign', '-m', `Apply Nestled upgrade ${upgradeId}`], { cwd, encoding: 'utf8' });
  if (commit.status !== 0) return '';
  return gitOutput(cwd, ['rev-parse', '--short', 'HEAD']);
}

function pushAndCreatePR(cwd, project, upgrade, branch) {
  const push = spawnSync('git', ['push', '-u', 'origin', branch], { cwd, encoding: 'utf8' });
  if (push.status !== 0) return { status: 'blocked', reason: `Push failed: ${push.stderr || push.stdout}` };
  const body = [
    '## Summary',
    '',
    upgrade.intent || upgrade.title || upgrade.id,
    '',
    '## Source',
    '',
    `Promoted from \`nestled-dev-template\` via Nestled Upgrader (\`${upgrade.id}\`)`,
    '',
    '🤖 Generated by Nestled Upgrader'
  ].join('\n');
  const pr = spawnSync('gh', [
    'pr', 'create',
    '--title', upgrade.title || upgrade.id,
    '--base', project.defaultBranch || 'develop',
    '--head', branch,
    '--body', body
  ], { cwd, encoding: 'utf8' });
  if (pr.status !== 0) return { status: 'blocked', reason: `PR creation failed: ${pr.stderr || pr.stdout}` };
  return { status: 'created', url: pr.stdout.trim() };
}

function patchReportLine(patch) {
  const excluded = patch.excludedPaths?.length ? `\n- Excluded paths: ${patch.excludedPaths.join(', ')}` : '';
  if (patch.applied && patch.via3way) return `- Applied via 3-way merge (some hunks were already present via a different path).${excluded}`;
  if (patch.applied) return `- Applied cleanly.${excluded}`;
  if (patch.alreadyApplied) return `- Patch content already appears to be present.${excluded}`;
  return `- Did not apply cleanly.${excluded}\n- ${patch.output || 'No git output.'}`;
}

function applyOutcome(result) {
  if (result.recommendation === 'blocked') return 'blocked';
  if (result.recommendation === 'not-applicable') return 'not-applicable';
  if (result.patch?.applied) return 'applied';
  if (result.packageRelease?.status === 'applied') return 'applied';
  return result.recommendation;
}

function packageReleaseReportLine(packageRelease) {
  if (!packageRelease) return '- Not applicable.';
  if (packageRelease.status === 'applied') {
    return packageRelease.updated.map((item) => `- ${item.manifest}: ${item.name} -> ${item.version}`).join('\n') || '- No package changes recorded.';
  }
  return `- ${packageRelease.status}: ${packageRelease.reason}`;
}

function isValidDelivery(upgrade) {
  if (upgrade.priority === 'ignore') return true;
  if (!upgrade.delivery) return false;
  if (!['code-patch', 'package-release', 'hybrid'].includes(upgrade.delivery)) return false;
  if (deliveryIncludesPatch(upgrade) && !Array.isArray(upgrade.affectedPaths)) return false;
  if (deliveryIncludesPackage(upgrade) && !Array.isArray(upgrade.packageReleases)) return false;
  return true;
}

function deliveryIncludesPackage(upgrade) {
  return upgrade.delivery === 'package-release' || upgrade.delivery === 'hybrid';
}

function deliveryIncludesPatch(upgrade) {
  return !upgrade.delivery || upgrade.delivery === 'code-patch' || upgrade.delivery === 'hybrid';
}

function hasUnresolvedPackageRelease(upgrade) {
  if (!deliveryIncludesPackage(upgrade)) return false;
  return (upgrade.packageReleases || []).some((release) => !release.targetVersion && !release.versionRange);
}

function packageReleaseNames(upgrade) {
  return (upgrade.packageReleases || []).map((release) => release.name).filter(Boolean).join(', ') || 'the referenced packages';
}

function applyPackageReleases(cwd, upgrade) {
  if (hasUnresolvedPackageRelease(upgrade)) {
    return { status: 'blocked', reason: 'Package release is missing targetVersion and versionRange.' };
  }
  for (const release of upgrade.packageReleases || []) {
    const version = release.versionRange || release.targetVersion;
    if (!verifyPublishedPackage(release.name, release.targetVersion || release.versionRange)) {
      return { status: 'blocked', reason: `Cannot verify published version for ${release.name}@${release.targetVersion || release.versionRange}.` };
    }
    release.version = version;
  }
  const manifests = findPackageManifests(cwd, upgrade.packageReleases || []);
  const updated = [];
  for (const manifest of manifests) {
    const packageJson = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    let changed = false;
    for (const release of upgrade.packageReleases || []) {
      const version = release.versionRange || release.targetVersion;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (packageJson[field]?.[release.name]) {
          packageJson[field][release.name] = version;
          updated.push({ manifest: path.relative(cwd, manifest), name: release.name, version });
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync(manifest, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  if (updated.length === 0) {
    return { status: 'not-applicable', reason: `Project does not consume ${packageReleaseNames(upgrade)}.` };
  }
  const lockfile = updateLockfile(cwd);
  return { status: lockfile.status === 0 ? 'applied' : 'blocked', reason: lockfile.reason, updated };
}

function findPackageManifests(cwd, releases) {
  const explicit = releases.flatMap((release) => release.manifests || []);
  if (explicit.length) return explicit.map((manifest) => path.join(cwd, manifest)).filter((manifest) => fs.existsSync(manifest));
  const result = [];
  walkPackageJson(cwd, result);
  return result;
}

const PACKAGE_MANIFEST_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.nx',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp'
]);

function walkPackageJson(dir, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (PACKAGE_MANIFEST_IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPackageJson(absolute, result);
    } else if (entry.name === 'package.json') {
      result.push(absolute);
    }
  }
}

function verifyPublishedPackage(name, version) {
  if (!name || !version) return false;
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '';
}

function getNestedValue(obj, path) {
  return path.reduce((curr, key) => curr?.[key], obj);
}

function safeReadPackageJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function isWorkspaceRef(version) {
  return typeof version === 'string' && (version.startsWith('workspace:') || version.startsWith('file:'));
}

function findVersionInPkg(pkg, name) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[field]?.[name]) return pkg[field][name];
  }
  return null;
}

function findDepField(pkg, name) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[field]?.[name]) return field;
  }
  return null;
}

function packageManifestsByRelativePath(cwd) {
  return new Map(findPackageManifests(cwd, []).map((manifest) => [
    path.relative(cwd, manifest),
    JSON.parse(fs.readFileSync(manifest, 'utf8'))
  ]));
}

function findInternalLibVersions(devPath, promotionProject) {
  const excludes = [
    ...(promotionProject.promotion?.rawPatchExcludes || []),
    ...defaultTemplatePromotionPolicy().rawPatchExcludes
  ];
  return [...new Set(excludes)]
    .filter((p) => p.endsWith('/**') && !p.slice(0, -3).includes('*'))
    .map((p) => p.slice(0, -3))
    .flatMap((libDir) => {
      const pkg = safeReadPackageJson(path.join(devPath, libDir, 'package.json'));
      return pkg?.name && pkg?.version ? [{ name: pkg.name, version: pkg.version }] : [];
    });
}

function updateLockfile(cwd) {
  const command = packageManagerInstallCommand(cwd);
  if (!command) return { status: 0, reason: 'No package manager lockfile detected.' };
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
  return { status: result.status, reason: result.status === 0 ? 'Lockfile updated.' : (result.stderr || result.stdout || 'Package manager install failed.') };
}

function packageManagerInstallCommand(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return ['pnpm', 'install'];
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return ['yarn', 'install'];
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return ['npm', 'install'];
  return null;
}

function isTemplateToolingUpgrade(upgrade) {
  return (upgrade.affectedPaths || []).some((pattern) => pattern.startsWith('.nestled-updates/'));
}

function shouldExcludeUpgradeNotes(upgrade) {
  return !(upgrade.affectedPaths || []).some((pattern) => pattern.startsWith('.nestled-updates/upgrade-notes'));
}

function patchExcludesFor(project, upgrade) {
  const excludes = [];
  if (project.role !== 'template-promotion') {
    excludes.push('.nestled/**');
    if (shouldExcludeUpgradeNotes(upgrade)) excludes.push('.nestled-updates/upgrade-notes/**');
  }
  if (project.role === 'template-promotion') {
    excludes.push(...(project.rawPatchExcludes || []));
    excludes.push(...(project.promotion?.rawPatchExcludes || defaultTemplatePromotionPolicy().rawPatchExcludes));
    for (const release of upgrade.packageReleases || []) {
      if (release.sourcePath) excludes.push(`${release.sourcePath.replace(/\/+$/, '')}/**`);
    }
    if (deliveryIncludesPackage(upgrade)) {
      excludes.push('package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock');
    }
  }
  return [...new Set(excludes)];
}

function promotionPatchOnlyTouchesExcludedPaths(project, upgrade) {
  const affectedPaths = upgrade.affectedPaths || [];
  if (affectedPaths.length === 0) return false;
  const excludes = patchExcludesFor(project, upgrade);
  if (excludes.length === 0) return false;
  return affectedPaths.every((affectedPath) => excludes.some((exclude) => pathPatternMatches(exclude, affectedPath)));
}

function pathPatternMatches(pattern, candidate) {
  const cleanPattern = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const cleanCandidate = candidate.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleanPattern === cleanCandidate) return true;
  if (cleanPattern.endsWith('/**')) return cleanCandidate === cleanPattern.slice(0, -3) || cleanCandidate.startsWith(cleanPattern.slice(0, -2));
  if (cleanCandidate.endsWith('/**')) return cleanPattern === cleanCandidate.slice(0, -3) || cleanPattern.startsWith(cleanCandidate.slice(0, -2));
  return false;
}
