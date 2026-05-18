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

function parseArgs(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
    } else if (arg === '--dry-run' || arg === '--all' || arg === '--allow-dirty' || arg === '--dry-run-only') {
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
  report --project <name>`);
}

function run(config, args) {
  const result = runWorkflow(config, undefined, { allowDirty: args.allowDirty, dryRunOnly: args.dryRunOnly });
  for (const project of result.discovered) console.log(`Added ${project.name} (${project.path})`);
  const promotionCounts = new Map();
  for (const item of result.promotion.results) {
    const key = item.recommendation || (item.patch?.applied ? 'applied' : 'blocked');
    promotionCounts.set(key, (promotionCounts.get(key) || 0) + 1);
  }
  console.log(`Promotion ${result.promotion.project}: ${[...promotionCounts.entries()].map(([key, count]) => `${key}: ${count}`).join(', ') || 'no pending upgrades'}`);
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
  if (result.sync.created) {
    console.log(`Created ${result.sync.drafts?.length || 1} upgrade record(s) from ${result.sync.from}..${result.sync.to}`);
  } else {
    console.log(result.sync.reason);
  }
  const counts = new Map();
  for (const item of result.results) {
    const key = item.recommendation || (item.patch?.applied ? 'applied' : 'blocked');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  console.log(`Promoted ${result.project}: ${[...counts.entries()].map(([key, count]) => `${key}: ${count}`).join(', ') || 'no pending upgrades'}`);
  console.log('Rollup: reports/upgrade-rollup.md');
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
