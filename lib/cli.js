import {
  addDiscoveredProjects,
  applyDryRun,
  applyUpgrade,
  createDraftUpgrade,
  findProject,
  findUpgrade,
  initializeAllLogs,
  inspectPlan,
  loadConfig,
  loadUpgrades,
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
    } else if (arg === '--dry-run' || arg === '--all' || arg === '--allow-dirty' || arg === '--dry-run-only' || arg === '--push') {
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
  if (command === 'status') return status(config, upgrades);
  if (command === 'discover') return discover(config, upgrades);
  if (command === 'init') return init(config);
  if (command === 'sync-template') return sync(config);
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
  status
  discover
  init
  sync-template
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

function status(config, upgrades) {
  if (!config.projects?.length) {
    console.log('No projects configured.');
    return;
  }
  for (const project of config.projects || []) {
    const summary = summarizeProject(project, relevantUpgradesForProject(config, project, upgrades));
    const counts = Object.entries(summary.counts).filter(([, count]) => count > 0).map(([key, count]) => `${key}: ${count}`).join(', ');
    console.log(`${summary.project}: ${counts || 'no upgrades'}`);
  }
}

function discover(config, upgrades) {
  const discovered = addDiscoveredProjects(config);
  if (!discovered.length) {
    console.log('No new projects discovered.');
    return;
  }
  for (const project of discovered) console.log(`Added ${project.name} (${project.path})`);
  console.log(`Initialized local upgrade logs for ${config.projects.length} project(s).`);
}

function init(config) {
  const initialized = initializeAllLogs(config);
  if (!initialized.length) {
    console.log('No projects configured.');
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
  const output = reportForProject(project, relevantUpgradesForProject(config, project, upgrades));
  process.stdout.write(output);
}
