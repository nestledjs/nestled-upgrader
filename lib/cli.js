import {
  addDiscoveredProjects,
  applyDryRun,
  applyUpgrade,
  convergenceStatus,
  createDraftUpgrade,
  downstreamProjects,
  findProject,
  findUpgrade,
  initializeAllLogs,
  inspectPlan,
  loadConfig,
  loadUpgrades,
  normalizeUpgradeLogs,
  planAll,
  promoteTemplate,
  relevantUpgradesForProject,
  reportForProject,
  runWorkflow,
  summarizeProject,
  syncTemplate,
  upgradeAll,
  writePlanReport
} from './upgrader.js';
import { publishFeed, promoteFeed, feedStatus, baselineFleet, fleetUpdate } from './feed.js';

function parseArgs(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
    } else if (arg === '--dry-run' || arg === '--all' || arg === '--allow-dirty' || arg === '--dry-run-only' || arg === '--push' || arg === '--check') {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = true;
    } else {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || command === '--help') return help();
  const config = loadConfig();
  if (command === 'create-upgrade') {
    const draft = createDraftUpgrade({ from: args.from, to: args.to, templatePath: config.template?.path });
    console.log(`Created ${draft.id}`);
    console.log(`Record: ${draft.upgradePath}`);
    console.log(`Patch: ${draft.patchPath}`);
    return;
  }
  const upgrades = loadUpgrades();
  if (command === 'status') return status(config, upgrades, args);
  if (command === 'convergence-status') return convergenceStatusCmd(config, args);
  if (command === 'discover') return discover(config, upgrades);
  if (command === 'init') return init(config);
  if (command === 'sync-template') return sync(config);
  if (command === 'format-logs') return formatLogs(config, args);
  if (command === 'promote-template') return promote(config, args);
  if (command === 'run') return run(config, args);
  if (command === 'upgrade') return upgrade(config, upgrades, args);
  if (command === 'plan') return plan(config, upgrades, args);
  if (command === 'apply') return apply(config, upgrades, args);
  if (command === 'report') return report(config, upgrades, args);
  if (command === 'feed-publish') return feedPublish(config, args);
  if (command === 'feed-promote') return feedPromote(config, args);
  if (command === 'feed-status') return feedShow(config);
  if (command === 'baseline-fleet') return fleetBaseline(config, args);
  if (command === 'fleet-update') return fleetRun(config, args);
  throw new Error(`Unknown command: ${command}`);
}

function help() {
  console.log(`Usage: nestled-upgrader <command>

Commands:
  status [--project <name>]
  convergence-status [<project>]
  discover
  init
  sync-template
  format-logs [--check] [--project <name>]
  promote-template --dry-run
  promote-template
  run
  run --dry-run-only
  create-upgrade --from <commit> --to <commit>
  upgrade --all --dry-run
  upgrade --all
  plan --project <name> --upgrade <id>
  apply --project <name> --upgrade <id> --dry-run
  apply --project <name> --upgrade <id>
  report --project <name>

  feed-publish --channel canary [--title "..."] [--push] [--dry-run]
  feed-promote --to stable [--release <id>] [--push]
  feed-status
  baseline-fleet --at <release> [--channel canary] [--remote <url>] [--ref <branch>] [--dry-run]
  fleet-update [--bin <cmd>] [--dry-run] [--allow-dirty] [--pr] [--verify "<cmds>"]`);
}

// One line per repo: has the template moved since it was last brought level? Reads each repo's
// `.nestled/converged-at` marker vs the local nestled-template HEAD (see the playbook §10.1).
function convergenceSentence(row, headShort) {
  switch (row.state) {
    case 'current':
      return `✓ ${row.project}: current with the template @ ${headShort}${row.date ? ` (converged ${row.date})` : ''}.`;
    case 'behind':
      return `→ ${row.project}: BEHIND by ${row.behind} template commit(s) — converged ${row.date || '?'} @ ${row.sha}. Re-run the §2 divergence scan.`;
    case 'never':
      return `✗ ${row.project}: NEVER CONVERGED — run the full playbook (no .nestled/converged-at marker).`;
    case 'unknown':
      return `? ${row.project}: recorded @ ${row.sha} is not in the template's history — re-record after the next converge.`;
    case 'missing':
      return `- ${row.project}: repo not found at ${row.repoPath}.`;
    default:
      return `${row.project}: ${row.state}`;
  }
}

// Enforcement drift is reported even for a repo that is otherwise current: "current" answers
// whether the template moved, never whether this repo is still running the template's checks.
// A never-converged repo is missing the whole modular doctor, so the raw list is 15 paths of
// noise. Name a few and count the rest — the actionable fact is "this repo predates the refactor",
// not which files.
function nameSome(files, limit = 3) {
  if (files.length <= limit) return files.join(', ');
  return `${files.slice(0, limit).join(', ')} +${files.length - limit} more`;
}

function driftLines(row) {
  const drift = row.drift;
  if (!drift) return [];
  const lines = [];
  if (drift.missing.length > 0) {
    lines.push(`⚠ ${drift.missing.length} enforcement file(s) MISSING: ${nameSome(drift.missing)}`);
  }
  if (drift.differing.length > 0) {
    lines.push(
      `⚠ ${drift.differing.length} enforcement file(s) differ from the template: ${nameSome(drift.differing)}`
    );
  }
  if (drift.extra.length > 0) {
    lines.push(`· ${drift.extra.length} enforcement file(s) the template does not have: ${nameSome(drift.extra)}`);
  }
  return lines;
}

function exceptionLine(row) {
  if (!row.exceptions || row.exceptions.length === 0) return null;
  const parts = row.exceptions.map((held) =>
    held.unreadable
      ? `${held.label}(unreadable)`
      : `${held.label}(${held.detail ?? held.entries})`
  );
  return `· exceptions held: ${parts.join(', ')}`;
}

function portLines(row) {
  const ports = row.ports;
  if (!ports) return [];
  if (ports.state === 'unassigned') {
    return [`⚠ no port block assigned — add portBlock to upgrader.config.yaml, or it runs on block 0`];
  }
  if (ports.state === 'no-env') return [];
  if (ports.state === 'ok') return [];

  const lines = [];
  if (ports.mismatched.length > 0) {
    lines.push(
      `⚠ block ${ports.block} port(s) wrong: ` +
        nameSome(ports.mismatched.map((p) => `${p.key}=${p.declared} (expected ${p.expected})`))
    );
  }
  // Unset is not neutral outside block 0: every default lands on block 0, so silence claims the
  // template's ports. portConformance only records unset for non-zero blocks, so there is nothing
  // to filter here — state and output cannot disagree.
  if (ports.unset.length > 0) {
    lines.push(
      `⚠ ${ports.unset.length} port(s) unset, so they fall back to block 0: ` +
        nameSome(ports.unset.map((p) => `${p.key}→${p.fallsBackTo} (expected ${p.expected})`))
    );
  }
  return lines;
}

function versionLines(row) {
  const version = row.version;
  if (!version || version.state === 'ok' || version.state === 'untracked') return [];
  if (version.state === 'absent') {
    return [`⚠ does not depend on the enforcement package at all (template runs ${version.expected})`];
  }
  if (version.state === 'unresolved') {
    return [`⚠ declares the enforcement package but no lockfile resolves it (template runs ${version.expected})`];
  }
  // Ahead is reported without a warning mark: taking a fix first is not a defect, but a reader
  // comparing two repos still needs to know they are not running the same checks.
  if (version.state === 'ahead') {
    return [`· enforcement package is ${version.actual}, ahead of the template's ${version.expected}`];
  }
  // Loud, because file comparison cannot see this: the checks themselves are the wrong build.
  return [`⚠ enforcement package is ${version.actual}, template runs ${version.expected}`];
}

function convergenceDetailLines(row) {
  const lines = [...driftLines(row), ...versionLines(row), ...portLines(row)];
  const exceptions = exceptionLine(row);
  if (exceptions) lines.push(exceptions);
  return lines;
}

function convergenceStatusCmd(config, args) {
  const result = convergenceStatus(config);
  if (!result.templateHead) {
    console.log(`Could not resolve ${result.template} HEAD — is it cloned at the configured path?`);
    return;
  }
  const only = args._[1];
  const rows = only ? result.rows.filter((row) => row.project === only) : result.rows;
  if (only && rows.length === 0) {
    console.log(`No downstream project named "${only}".`);
    return;
  }
  // Single-repo mode is for scripts and prompts: exactly the one sentence, no header, no indent.
  if (only) {
    console.log(convergenceSentence(rows[0], result.templateHeadShort));
    for (const line of convergenceDetailLines(rows[0])) console.log(`  ${line}`);
    return;
  }
  console.log(`Convergence vs ${result.template} @ ${result.templateHeadShort}\n`);
  for (const row of rows) {
    console.log(`  ${convergenceSentence(row, result.templateHeadShort)}`);
    for (const line of convergenceDetailLines(row)) console.log(`      ${line}`);
  }
  const count = (state) => result.rows.filter((row) => row.state === state).length;
  const attention = count('unknown') + count('missing');
  const portDrift = result.rows.filter(
    (row) => row.ports && (row.ports.state === 'drift' || row.ports.state === 'unassigned')
  ).length;
  const drifted = result.rows.filter(
    (row) => row.drift && (row.drift.differing.length > 0 || row.drift.missing.length > 0)
  ).length;
  const staleVersion = result.rows.filter(
    (row) => row.version && (row.version.state === 'drift' || row.version.state === 'absent')
  ).length;
  console.log(
    `\n${count('behind')} behind · ${count('current')} current · ${count('never')} never converged` +
      (attention ? ` · ${attention} need attention` : '') +
      (drifted ? ` · ${drifted} running edited enforcement` : '') +
      (staleVersion ? ` · ${staleVersion} on a stale enforcement package` : '') +
      (portDrift ? ` · ${portDrift} with port drift` : '')
  );
}

function fleetRun(config, args) {
  const results = fleetUpdate(config, {
    bin: args.bin,
    dryRun: args.dryRun,
    allowDirty: args.allowDirty,
    pr: args.pr,
    verify: args.verify
  });
  for (const item of results) {
    if (item.status === 'dry-run') {
      console.log(`  ${item.project}: ${item.command}`);
    } else {
      console.log(`  ${item.project}: ${item.status}${item.code ? ` (exit ${item.code})` : ''}`);
    }
  }
  const failed = results.filter((item) => item.status === 'failed' || item.status === 'missing');
  console.log(`Fleet update: ${results.length} site(s), ${failed.length} needing attention.`);
}

function feedPublish(config, args) {
  const result = publishFeed(config, {
    channel: args.channel || 'canary',
    title: args.title,
    push: args.push,
    dryRun: args.dryRun
  });
  if (!result.published && !result.dryRun) {
    console.log(result.reason);
    return;
  }
  const verb = result.dryRun ? 'Would publish' : 'Published';
  console.log(`${verb} release ${result.releaseId} to channel "${result.channel}" with ${result.notes.length} note(s):`);
  for (const id of result.notes) console.log(`  - ${id}`);
  if (result.dryRun) return;
  if (result.commit?.committed) console.log(`Committed to template: ${result.commit.sha}${result.commit.pushed ? ' (pushed)' : ''}`);
  if (result.commit?.pushError) console.log(`Push failed: ${result.commit.pushError}`);
}

function feedPromote(config, args) {
  const result = promoteFeed(config, { toChannel: args.to || 'stable', release: args.release, push: args.push });
  if (!result.promoted) {
    console.log(result.reason);
    return;
  }
  console.log(`Promoted ${result.release} to channel "${result.toChannel}".`);
  if (result.commit?.committed) console.log(`Committed to template: ${result.commit.sha}${result.commit.pushed ? ' (pushed)' : ''}`);
  if (result.commit?.pushError) console.log(`Push failed: ${result.commit.pushError}`);
}

function feedShow(config) {
  const result = feedStatus(config);
  console.log('Channels:');
  for (const [channel, id] of Object.entries(result.channels)) console.log(`  ${channel}: ${id}`);
  if (!Object.keys(result.channels).length) console.log('  (none)');
  console.log(`Releases: ${result.releases.length}`);
  for (const release of result.releases) console.log(`  ${release.id} — ${release.title} (${release.notes} note(s))`);
}

function fleetBaseline(config, args) {
  const results = baselineFleet(config, {
    at: args.at,
    channel: args.channel || 'canary',
    remote: args.remote,
    ref: args.ref,
    dryRun: args.dryRun
  });
  const verb = args.dryRun ? 'Would baseline' : 'Baselined';
  console.log(`${verb} ${results.length} fleet site(s) at ${args.at}:`);
  for (const item of results) console.log(`  ${item.project}: baseline ${item.baselineRelease}, channel ${item.channel}`);
}

function run(config, args) {
  const result = runWorkflow(config, undefined, { allowDirty: args.allowDirty, dryRunOnly: args.dryRunOnly });
  for (const project of result.discovered) console.log(`Added ${project.name} (${project.path})`);
  const pm = result.promotion.mirror;
  if (pm) {
    const news = pm.changes.filter((c) => c.kind === 'new').length;
    const mods = pm.changes.filter((c) => c.kind === 'modified').length;
    const verb = pm.dryRun ? 'would mirror' : 'mirrored';
    console.log(`Promotion ${result.promotion.project}: ${verb} ${pm.changes.length} file(s) (${news} new, ${mods} modified)`);
  } else {
    console.log(`Promotion ${result.promotion.project}: skipped (no template promotion target).`);
  }
  if (result.sync.created) {
    console.log(`Created ${result.sync.drafts?.length || 1} upgrade record(s) from ${result.sync.from}..${result.sync.to}`);
  } else {
    console.log(result.sync.reason);
  }
  console.log(`Planned ${result.dryRun.length} project upgrade(s).`);
  if (args.dryRunOnly) {
    console.log('Stopped before apply because --dry-run-only was set.');
  } else {
    console.log(`Applied or classified ${result.apply.length} project upgrade(s).`);
  }
  console.log('Rollup: reports/upgrade-rollup.md');
}

function sync(config) {
  const result = syncTemplate(config);
  if (!result.created) {
    console.log(result.reason);
    return;
  }
  console.log(`Created ${result.drafts?.length || 1} upgrade record(s) from ${result.from}..${result.to}`);
  for (const draft of result.drafts || [result]) {
    console.log(`Record: ${draft.upgradePath}`);
    console.log(`Patch: ${draft.patchPath}`);
  }
}

function formatLogs(config, args) {
  const check = Boolean(args.check || args.dryRun);
  const results = normalizeUpgradeLogs(config, undefined, { check, project: args.project });
  const changed = results.filter((item) => item.changed);
  const missing = results.filter((item) => item.missing);
  const skipped = results.filter((item) => item.skipped);
  for (const item of results) {
    if (item.skipped) {
      console.log(`${item.project}: skipped (${item.reason})`);
    } else if (item.missing) {
      console.log(`${item.project}: missing ${item.path}`);
    } else if (item.changed) {
      console.log(`${item.project}: ${check ? 'would normalize' : 'normalized'}`);
    } else {
      console.log(`${item.project}: ok`);
    }
  }
  const verb = check ? 'would change' : 'changed';
  console.log(`Upgrade log format: ${changed.length} ${changed.length === 1 ? 'ledger' : 'ledgers'} ${verb}, ${missing.length} missing, ${skipped.length} skipped.`);
  if (args.check && changed.length) throw new Error('Upgrade log formatting check failed.');
}

function promote(config, args) {
  const result = promoteTemplate(config, undefined, { dryRun: args.dryRun, allowDirty: args.allowDirty });
  if (result.blocked) {
    console.log(result.reason);
    return;
  }
  const m = result.mirror;
  const news = m.changes.filter((c) => c.kind === 'new').length;
  const mods = m.changes.filter((c) => c.kind === 'modified').length;
  const verb = m.dryRun ? 'Would mirror' : 'Mirrored';
  console.log(`${verb} ${m.source}@${m.sourceCommit} → ${result.project}: ${m.changes.length} file(s) (${news} new, ${mods} modified)`);
  if (m.templateOnly.length) {
    console.log(`Template-only files kept (not in source): ${m.templateOnly.length}`);
  }
  if (result.packageSync?.updates?.length) {
    console.log(`Package version updates: ${result.packageSync.updates.length}`);
  }
  console.log('Report: reports/promotion-mirror.md');
  // The tree is dirty if the mirror wrote files OR the package sync did. Package sync touches
  // package.json/lockfile, which the mirror deliberately excludes, so a run can leave the template
  // dirty while reporting 0 mirrored files — gating this on m.changes alone hid the guidance
  // exactly when the only change was a dependency bump.
  const wroteFiles = m.changes.length > 0 || (result.packageSync?.updates?.length || 0) > 0;
  if (!m.dryRun && wroteFiles) {
    // Promotion never commits. Say so, so the uncommitted tree does not read as a failed run.
    console.log('');
    console.log('Left uncommitted in the template working tree. Review the report, then:');
    console.log('  git -C <template> switch -c chore/promote-<topic>');
    console.log('  git -C <template> add -A && git -C <template> commit');
    console.log('Describe the mirrored change, not just the package bumps, and open a PR.');
  }
}

function status(config, upgrades, args = {}) {
  if (!config.projects?.length) {
    console.log('No projects configured.');
    return;
  }
  const requestedProject = args.project ? findProject(config, args.project) : null;
  if (requestedProject?.role === 'template-promotion') {
    console.log(`${requestedProject.name}: promotion target (not a downstream upgrade ledger)`);
    console.log('  Run `node bin/nestled-upgrader.js promote-template --dry-run` to inspect mirror currency.');
    console.log('  Promotion report: reports/promotion-mirror.md');
    return;
  }

  if (!requestedProject) {
    for (const project of config.projects || []) {
      if (project.role === 'template-promotion') {
        console.log(`${project.name}: promotion target (not a downstream upgrade ledger)`);
      }
    }
  }

  const projects = requestedProject ? [requestedProject] : downstreamProjects(config);
  if (!projects.length) {
    console.log('No downstream projects configured.');
    return;
  }
  for (const project of projects) {
    const summary = summarizeProject(project, relevantUpgradesForProject(config, project, upgrades), undefined, upgrades);
    const counts = Object.entries(summary.counts).filter(([, count]) => count > 0).map(([key, count]) => `${key}: ${count}`).join(', ');
    console.log(`${summary.project}: ${counts || 'no upgrades'}`);
    // An orphan means work may already be done but filed under a key nothing looks up, so the
    // pending count above is an overstatement until these are reconciled.
    if (summary.orphans?.length) {
      const n = summary.orphans.length;
      console.log(`  ${n} log ${n === 1 ? 'entry matches' : 'entries match'} no known upgrade id (pending count may be overstated):`);
      for (const id of summary.orphans) console.log(`    ${id}`);
    }
  }
}

function discover(config, upgrades) {
  const discovered = addDiscoveredProjects(config);
  if (!discovered.length) {
    console.log('No new projects discovered.');
    return;
  }
  for (const project of discovered) console.log(`Added ${project.name} (${project.path})`);
  console.log(`Initialized local upgrade logs for ${downstreamProjects(config).length} downstream project(s).`);
}

function init(config) {
  const initialized = initializeAllLogs(config);
  if (!initialized.length) {
    console.log('No downstream projects configured.');
    return;
  }
  for (const item of initialized) console.log(`Initialized ${item.project}`);
}

function plan(config, upgrades, args) {
  const project = findProject(config, args.project);
  const upgrade = findUpgrade(upgrades, args.upgrade);
  const result = inspectPlan(project, upgrade);
  const reportPath = writePlanReport(project, upgrade, result);
  console.log(`${project.name}/${upgrade.id}: ${result.recommendation}`);
  console.log(result.reason);
  console.log(`Report: ${reportPath}`);
}

function apply(config, upgrades, args) {
  const project = findProject(config, args.project);
  const upgrade = findUpgrade(upgrades, args.upgrade);
  const result = args.dryRun
    ? applyDryRun(project, upgrade)
    : applyUpgrade(project, upgrade, config, undefined, { allowDirty: args.allowDirty });
  console.log(`${project.name}/${upgrade.id}: ${result.recommendation}`);
  console.log(`Report: ${result.reportPath}`);
}

function upgrade(config, upgrades, args) {
  if (!args.all) throw new Error('upgrade currently requires --all.');
  const results = args.dryRun ? planAll(config, upgrades) : upgradeAll(config, upgrades, undefined, { allowDirty: args.allowDirty });
  const counts = new Map();
  for (const result of results) {
    const key = result.recommendation || (result.patch?.applied ? 'applied' : 'blocked');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  console.log([...counts.entries()].map(([key, count]) => `${key}: ${count}`).join(', ') || 'No upgrades found.');
  console.log('Rollup: reports/upgrade-rollup.md');
}

function report(config, upgrades, args) {
  const project = findProject(config, args.project);
  if (project.role === 'template-promotion') {
    process.stdout.write([
      `# Template Promotion: ${project.name}`,
      '',
      `${project.name} is updated by the promotion mirror, not by downstream upgrade decisions.`,
      '',
      'Run `node bin/nestled-upgrader.js promote-template --dry-run` to inspect whether `nestled-dev-template` would mirror any files into this template.',
      '',
      'Promotion report: `reports/promotion-mirror.md`',
      ''
    ].join('\n'));
    return;
  }
  const output = reportForProject(project, relevantUpgradesForProject(config, project, upgrades));
  process.stdout.write(output);
}
