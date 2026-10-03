// Drafts an upstream report for the template from template-relative facts, so an operator can file it
// without naming their own installation. It never posts anything: it returns a prefilled issue URL
// (and the body, for copying), or, for a security problem, the private vulnerability reporting link.

import { describeFindings, findIdentifying } from './public-safety.js';
import { findProject, findUpgrade, readUpgradeLog } from './upgrader.js';

const DEFAULT_ISSUE_REPO = 'nestledjs/nestled-dev-template';

function issueRepo(config) {
  return config?.publicSafety?.issueRepo || DEFAULT_ISSUE_REPO;
}

/**
 * @param {object} config upgrader config
 * @param {object[]} upgrades loaded upgrade records
 * @param {object} input { title, description, repro, expected, upgrade, project, security }
 * @returns {{ ok: boolean, security?: boolean, url?: string, body?: string, findings?: string[], reason?: string }}
 */
export function draftUpstreamReport(config, upgrades, input) {
  const { title, description, repro, expected, upgrade, project, security = false } = input;
  if (!title || !description) {
    return { ok: false, reason: 'A report needs --title and --description, written in template terms.' };
  }

  // The release comes from the project's ledger; the project itself is only read, never named.
  let release = '';
  if (project) {
    const log = readUpgradeLog(findProject(config, project));
    release = log?.template?.baselineRelease || '';
  }
  let upgradeLine = '';
  if (upgrade) {
    const record = findUpgrade(upgrades, upgrade);
    upgradeLine = `Upgrade: \`${record.id}\`${record.title ? ` (${record.title})` : ''}`;
  }

  const releaseField = [release, upgradeLine].filter(Boolean).join('\n');
  const body = [
    `### Template release\n\n${releaseField || '_unknown_'}`,
    `### What happens\n\n${description}`,
    `### Reproduction\n\n${repro || '_to add: steps on a fresh clone of nestled-template_'}`,
    `### Expected behaviour or proposed fix\n\n${expected || '_to add_'}`,
  ].join('\n\n');

  const findings = findIdentifying([title, body].join('\n'), config);
  if (findings.length) {
    return {
      ok: false,
      findings: describeFindings(findings),
      reason: 'This report would identify your own projects. Rewrite it in template terms and run it again.',
    };
  }

  const repo = issueRepo(config);
  if (security) {
    return { ok: true, security: true, url: `https://github.com/${repo}/security/advisories/new`, body };
  }

  // Issue forms accept prefilled values by field id (see .github/ISSUE_TEMPLATE/bug.yml).
  const params = new URLSearchParams({ template: 'bug.yml', title, release: releaseField, what: description });
  if (repro) params.set('repro', repro);
  if (expected) params.set('expected', expected);
  return { ok: true, url: `https://github.com/${repo}/issues/new?${params.toString()}`, body };
}
