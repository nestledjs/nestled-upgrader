// Detects text that would identify an operator's own installations if it were published: their
// project names and paths, links to repositories that aren't public, and absolute local paths.
// Used wherever the upgrader writes something public (the update feed) or drafts something for the
// operator to post publicly (upstream issue reports).
//
// The terms come from the operator's own configuration, so this works for anyone running the
// upgrader, not only the maintainers:
//   - every downstream project's `name` and the last segment of its `path`
//   - optional extra terms under `publicSafety.terms` (client or organization names, domains)
// The template and its promotion source are public by design and are never treated as identifying.

import path from 'node:path';

const DEFAULT_PUBLIC_OWNERS = ['nestledjs'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicNames(config) {
  const names = new Set();
  for (const repo of [config?.template, config?.promotion?.source]) {
    if (!repo) continue;
    if (repo.name) names.add(String(repo.name).toLowerCase());
    if (repo.path) names.add(path.basename(String(repo.path)).toLowerCase());
  }
  return names;
}

/** The identifying terms configured for this operator, lower-cased and de-duplicated. */
export function identifyingTerms(config) {
  const skip = publicNames(config);
  const terms = new Set();
  for (const project of config?.projects || []) {
    for (const value of [project?.name, project?.path && path.basename(String(project.path))]) {
      if (!value) continue;
      const term = String(value).toLowerCase();
      if (term.length >= 3 && !skip.has(term)) terms.add(term);
    }
  }
  for (const value of config?.publicSafety?.terms || []) {
    const term = String(value).trim().toLowerCase();
    if (term) terms.add(term);
  }
  return [...terms];
}

/**
 * Find identifying content in `text`. Returns one finding per distinct match:
 * `{ kind: 'term' | 'private-repo' | 'local-path', match }`. An empty array means the text is safe
 * to publish as far as this check can tell.
 */
export function findIdentifying(text, config) {
  if (!text) return [];
  const source = String(text);
  const findings = new Map();
  const add = (kind, match) => findings.set(`${kind}:${match.toLowerCase()}`, { kind, match });

  for (const term of identifyingTerms(config)) {
    // A term counts when it isn't embedded in a longer word: "app" must not match "apply".
    const pattern = new RegExp(`(^|[^a-z0-9])(${escapeRegExp(term)})(?=$|[^a-z0-9])`, 'gi');
    for (const match of source.matchAll(pattern)) add('term', match[2]);
  }

  const publicOwners = new Set(
    [...DEFAULT_PUBLIC_OWNERS, ...(config?.publicSafety?.publicOwners || [])].map((owner) => owner.toLowerCase()),
  );
  const publicRepos = new Set((config?.publicSafety?.publicRepos || []).map((repo) => repo.toLowerCase()));
  for (const match of source.matchAll(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) {
    const owner = match[1].toLowerCase();
    const repo = `${owner}/${match[2].replace(/\.git$/, '').toLowerCase()}`;
    if (!publicOwners.has(owner) && !publicRepos.has(repo)) add('private-repo', match[0]);
  }

  for (const match of source.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s'"`)]+/g)) {
    add('local-path', match[0]);
  }

  return [...findings.values()];
}

/** Human-readable lines for a list of findings, for local console output only. */
export function describeFindings(findings) {
  const labels = { term: 'project or configured term', 'private-repo': 'link to a non-public repository', 'local-path': 'absolute local path' };
  return findings.map((finding) => `${labels[finding.kind] || finding.kind}: ${finding.match}`);
}
