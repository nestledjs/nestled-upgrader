// Argument parsing for the nestled-upgrader CLI.
//
// Every subcommand declares the flags it accepts. Anything else is rejected before the command
// does any work: a permissive parser once let `feed-publish --help` fall through to a real publish
// that committed a feed release, because an unrecognized flag was just ignored and the command ran
// with its defaults. `--help` / `-h` is accepted by every command and prints its usage instead.

const BIN = 'nestled-upgrader';

const project = { name: '--project', value: '<name>', description: 'Limit to one configured project' };
const dryRun = (description) => ({ name: '--dry-run', description });
const allowDirty = { name: '--allow-dirty', description: 'Run even if the target working tree has uncommitted changes' };

// `value` marks a flag that consumes the next token; a flag without one is a boolean switch.
// `default` is documentation only: each command still applies its own defaults.
export const COMMANDS = {
  status: {
    summary: 'Show upgrade counts for each downstream project.',
    flags: [project]
  },
  'convergence-status': {
    summary: 'Show whether each repo has converged on the current template HEAD.',
    positionals: ['[<project>]']
  },
  discover: { summary: 'Add sibling project folders to upgrader.config.yaml and initialize their upgrade logs.' },
  init: { summary: "Initialize each downstream project's upgrade log." },
  'sync-template': { summary: 'Create upgrade records for new template commits.' },
  'format-logs': {
    summary: "Normalize each downstream project's .nestled/upgrade-log.yaml.",
    flags: [
      { name: '--check', description: 'Report what would change and fail if anything would; write nothing' },
      dryRun('Same as --check, but does not fail when a ledger would change'),
      project
    ]
  },
  'retire-upgrade-records': {
    summary: "Retire converged projects' upgrade logs by renaming them in each working tree (never commits).",
    usage: 'retire-upgrade-records (--project <name> | --all) [--dry-run]',
    flags: [
      project,
      { name: '--all', description: 'Retire every converged downstream project' },
      dryRun('Show what would be retired; rename nothing')
    ]
  },
  'promote-template': {
    summary: 'Mirror the dev template into the template checkout (never commits).',
    flags: [dryRun('Report what would be mirrored; write nothing'), allowDirty]
  },
  run: {
    summary: 'Promote the template, sync upgrade records, then plan and apply downstream upgrades.',
    flags: [
      { name: '--dry-run-only', description: 'Stop after planning; apply nothing downstream' },
      allowDirty
    ]
  },
  'create-upgrade': {
    summary: 'Draft an upgrade record from a template commit range.',
    usage: 'create-upgrade --from <commit> --to <commit>',
    flags: [
      { name: '--from', value: '<commit>', description: 'First template commit (exclusive)' },
      { name: '--to', value: '<commit>', description: 'Last template commit (inclusive)' }
    ]
  },
  upgrade: {
    summary: 'Plan or apply every pending upgrade across all downstream projects.',
    usage: 'upgrade --all [--dry-run] [--allow-dirty]',
    flags: [
      { name: '--all', description: 'Required: act on every downstream project' },
      dryRun('Plan only; apply nothing'),
      allowDirty
    ]
  },
  plan: {
    summary: 'Write a plan report for one upgrade on one project.',
    usage: 'plan --project <name> --upgrade <id>',
    flags: [project, { name: '--upgrade', value: '<id>', description: 'Upgrade record id' }]
  },
  apply: {
    summary: 'Apply one upgrade to one project.',
    usage: 'apply --project <name> --upgrade <id> [--dry-run] [--allow-dirty]',
    flags: [
      project,
      { name: '--upgrade', value: '<id>', description: 'Upgrade record id' },
      dryRun('Check whether the patch applies; change nothing'),
      allowDirty
    ]
  },
  report: {
    summary: 'Print the upgrade report for one project.',
    usage: 'report --project <name>',
    flags: [project]
  },
  'report-upstream': {
    summary: 'Draft a template issue (or a private security report) without identifying your projects; never posts.',
    usage:
      'report-upstream --title "..." --description "..." [--repro "..."] [--expected "..."] [--upgrade <id>] [--project <name>] [--security]',
    flags: [
      { name: '--title', value: '"..."', description: 'Issue title' },
      { name: '--description', value: '"..."', description: 'What is wrong, written against the template' },
      { name: '--repro', value: '"..."', description: 'Steps to reproduce' },
      { name: '--expected', value: '"..."', description: 'Expected behaviour' },
      { name: '--upgrade', value: '<id>', description: 'Related upgrade record id' },
      { name: '--project', value: '<name>', description: 'Project the problem was seen in (checked, never named)' },
      { name: '--security', description: 'Draft a private vulnerability report instead of a public issue' }
    ]
  },
  'feed-publish': {
    summary: 'Publish pending upgrade notes as a feed release and commit it to the template checkout.',
    flags: [
      { name: '--channel', value: '<name>', description: 'Channel to publish to', default: 'canary' },
      { name: '--title', value: '"..."', description: 'Release title', default: '"Release <release id>"' },
      { name: '--note', value: '<id>[,<id>]', description: 'Publish only these note ids', default: 'all pending notes' },
      { name: '--push', description: 'Push the template commit after publishing' },
      dryRun('Show what would be published; write and commit nothing'),
      { name: '--allow-identifying', description: 'Publish even if notes look like they name a project' }
    ]
  },
  'feed-promote': {
    summary: 'Point a feed channel at a release and commit it to the template checkout.',
    flags: [
      { name: '--to', value: '<channel>', description: 'Channel to advance', default: 'stable' },
      { name: '--release', value: '<id>', description: 'Release to promote', default: 'the current canary release' },
      { name: '--push', description: 'Push the template commit after promoting' }
    ]
  },
  'feed-status': { summary: 'Show feed channels and releases.' },
  'baseline-fleet': {
    summary: "Stamp every downstream project's upgrade log with a feed baseline.",
    usage: 'baseline-fleet --at <release> [--channel <name>] [--remote <url>] [--ref <branch>] [--dry-run]',
    flags: [
      { name: '--at', value: '<release>', description: 'Baseline release id' },
      { name: '--channel', value: '<name>', description: 'Channel to follow', default: 'canary' },
      { name: '--remote', value: '<url>', description: 'Feed remote URL', default: "the template's origin" },
      { name: '--ref', value: '<branch>', description: 'Feed ref', default: "the template's main branch" },
      dryRun('Show what would be stamped; write nothing')
    ]
  },
  'fleet-update': {
    summary: 'Run the update command in every downstream project.',
    flags: [
      { name: '--bin', value: '<cmd>', description: 'Update command to run', default: '$NESTLED_UPDATE_BIN or npx -y @nestledjs/upgrades' },
      dryRun('Print the command for each project; run nothing'),
      allowDirty,
      { name: '--pr', description: 'Open a pull request for each project' },
      { name: '--verify', value: '"<cmds>"', description: 'Verification commands to run after updating' }
    ]
  }
};

export class UsageError extends Error {
  constructor(message, command) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

const HELP_FLAGS = new Set(['--help', '-h']);

export function isHelpFlag(arg) {
  return HELP_FLAGS.has(arg);
}

function camelKey(flagName) {
  return flagName.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function flagLabel(flag) {
  return flag.value ? `${flag.name} ${flag.value}` : flag.name;
}

export function usageLine(command) {
  const spec = COMMANDS[command];
  if (spec.usage) return `${BIN} ${spec.usage}`;
  const parts = [command, ...(spec.positionals || []), ...(spec.flags || []).map((flag) => `[${flagLabel(flag)}]`)];
  return `${BIN} ${parts.join(' ')}`;
}

export function commandHelp(command) {
  const spec = COMMANDS[command];
  const flags = [...(spec.flags || []), { name: '--help', description: 'Show this help and exit' }];
  const labels = flags.map((flag) => (flag.name === '--help' ? '-h, --help' : flagLabel(flag)));
  const width = Math.max(...labels.map((label) => label.length));
  const lines = [`Usage: ${usageLine(command)}`, '', spec.summary, '', 'Options:'];
  flags.forEach((flag, index) => {
    const suffix = flag.default ? ` (default: ${flag.default})` : '';
    lines.push(`  ${labels[index].padEnd(width)}  ${flag.description}${suffix}`);
  });
  return lines.join('\n');
}

export function generalHelp() {
  const lines = [`Usage: ${BIN} <command> [options]`, '', 'Commands:'];
  for (const command of Object.keys(COMMANDS)) {
    lines.push(`  ${usageLine(command).slice(BIN.length + 1)}`);
    lines.push(`      ${COMMANDS[command].summary}`);
  }
  lines.push('', `Run "${BIN} <command> --help" for a command's options.`);
  return lines.join('\n');
}

function usageError(command, message) {
  return new UsageError(`${message}\nUsage: ${usageLine(command)}\nRun "${BIN} ${command} --help" for details.`, command);
}

// Parses `[command, ...rest]` strictly against the command's declared flags. Returns
// `{ _: [command, ...positionals], help?: true, <camelCasedFlag>: value }`. Throws a UsageError for an
// unknown command, an unknown flag, a value flag with no value, or an unexpected positional, unless
// help was requested, in which case `help: true` is returned so the caller can print usage instead.
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  // Own keys only: `toString` or `__proto__` must not resolve to an inherited "spec".
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) throw new UsageError(`Unknown command: ${command}\nRun "${BIN} --help" for the list of commands.`);
  const flags = new Map((spec.flags || []).map((flag) => [flag.name, flag]));
  const maxPositionals = (spec.positionals || []).length;
  const parsed = { _: [command] };
  let error = null;
  const fail = (message) => {
    error ||= usageError(command, message);
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (isHelpFlag(arg)) {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (parsed._.length - 1 >= maxPositionals) fail(`Unexpected argument for ${command}: ${arg}`);
      else parsed._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const flag = flags.get(name);
    if (!flag) {
      fail(`Unknown option for ${command}: ${name}`);
      continue;
    }
    const key = camelKey(flag.name);
    if (!flag.value) {
      if (eq !== -1 && name !== arg) fail(`Option ${flag.name} does not take a value`);
      else parsed[key] = true;
      continue;
    }
    if (name !== arg) {
      parsed[key] = arg.slice(eq + 1);
      continue;
    }
    const next = rest[i + 1];
    // A missing value must not swallow the next flag: `--note --push` would otherwise publish
    // a note literally named "--push" and never push.
    if (next === undefined || next.startsWith('--') || isHelpFlag(next)) {
      fail(`Option ${flag.name} requires a value ${flag.value}`);
      continue;
    }
    parsed[key] = next;
    i += 1;
  }

  if (error && !parsed.help) throw error;
  return parsed;
}
