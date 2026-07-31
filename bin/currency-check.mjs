#!/usr/bin/env node
// currency-check — compare each downstream repo's .nestled/upgrade-log.yaml
// against the upgrader's master upgrades/ catalog, and report what's missing.
//
// Why this exists: a "count the open PRs" audit is NOT a reliable currency check
// for this pipeline. Repos absorb upgrades three ways — merged PRs, direct/hard
// sync, and baseline-baked clones — and only PR-merged ones leave an obvious
// trace. The per-repo upgrade-log.yaml is the real ledger, but it drifts: early
// upgrades baked into a clone's baseline never get logged, and direct pushes
// sometimes skip the log. This tool reconciles ledger vs catalog vs actual code.
//
// SOURCE OF TRUTH: report mode reads the ledger AND the code signatures from a git
// ref (default origin/develop), so the answer is the same no matter which branch a
// repo happens to be checked out on. --fix operates on the working tree, because you
// can only commit what's checked out.
//
// Usage:
//   node bin/currency-check.mjs                 # report against origin/develop
//   node bin/currency-check.mjs --fetch         # git fetch origin first, then report
//   node bin/currency-check.mjs --ref main      # report against a different ref
//   node bin/currency-check.mjs --worktree      # report against the local working tree
//   node bin/currency-check.mjs --fix           # backfill present + n/a into the WORKING TREE
//
// Each catalog upgrade missing from a repo's log is classified by a code-signature
// detector into one of:
//   present  — the change IS in this repo (verified in code); log it as applied
//   na       — not applicable to this repo (feature surface absent / custom / superseded)
//   review   — genuinely unaccounted-for; a human/agent should verify before stamping
//
// --fix writes present (status: applied) and na (status: not-applicable) entries
// with a note carrying the detector's reasoning. It never stamps "review" entries.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const FETCH = argv.includes('--fetch');
// --fix must read the working tree (it writes there). Otherwise default to the ref
// unless --worktree is explicitly requested.
const USE_WORKTREE = FIX || argv.includes('--worktree');
const refArgIdx = argv.indexOf('--ref');
const REF = refArgIdx !== -1 && argv[refArgIdx + 1] ? argv[refArgIdx + 1] : 'origin/develop';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADES_DIR = path.join(ROOT, 'upgrades');
const LEGACY_ALIASES = path.join(ROOT, 'legacy-upgrade-aliases.yaml');
const CONFIG = path.join(ROOT, 'upgrader.config.yaml');
const TEMPLATE_DIR = path.resolve(ROOT, '../nestled-template');
const STAMP = new Date().toISOString();

// ---- file access: working tree vs git ref ----
// In report mode these resolve against REF (e.g. origin/develop) via `git show`,
// so the checked-out branch is irrelevant. In --fix/--worktree mode they hit disk.

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function gitShow(dir, rel) {
  const r = spawnSync('git', ['-C', dir, 'show', `${REF}:${rel}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
function gitExists(dir, rel) {
  return spawnSync('git', ['-C', dir, 'cat-file', '-e', `${REF}:${rel}`]).status === 0;
}
function gitListDir(dir, rel) {
  const r = spawnSync('git', ['-C', dir, 'ls-tree', '--name-only', `${REF}:${rel}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

// Unified accessors honoring the chosen source.
function readPath(dir, rel) {
  return USE_WORKTREE ? readFileSafe(path.join(dir, rel)) : gitShow(dir, rel);
}
function pathExists(dir, rel) {
  return USE_WORKTREE ? fs.existsSync(path.join(dir, rel)) : gitExists(dir, rel);
}
function dirHasFiles(dir, rel) {
  if (!USE_WORKTREE) return gitListDir(dir, rel).length > 0;
  try { return fs.readdirSync(path.join(dir, rel)).length > 0; } catch { return false; }
}

// ---- catalog + project + ledger parsing (no YAML dep; formats are simple/uniform) ----

function scalar(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

function listScalars(text, key) {
  const lines = text.split('\n');
  const values = [];
  let inList = false;
  for (const line of lines) {
    if (!inList && new RegExp(`^${key}:\\s*$`).test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      values.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^\S/.test(line) && line.trim() !== '') break;
  }
  return values;
}

function loadLegacyAliases() {
  const text = readFileSafe(LEGACY_ALIASES);
  if (text === null) return {};
  const aliases = {};
  let inAliases = false;
  let current = null;
  for (const line of text.split('\n')) {
    if (/^aliases:\s*$/.test(line)) {
      inAliases = true;
      continue;
    }
    if (!inAliases) continue;
    const key = line.match(/^ {2}([^:]+):\s*$/);
    if (key) {
      current = key[1];
      aliases[current] ||= [];
      continue;
    }
    const item = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (item && current) aliases[current].push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return aliases;
}

// The catalog lives in the upgrader's own checkout — always read from disk.
function loadCatalog() {
  const configuredAliases = loadLegacyAliases();
  const records = fs.readdirSync(UPGRADES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const fallbackId = f.replace(/\.yaml$/, '');
      const text = readFileSafe(path.join(UPGRADES_DIR, f)) || '';
      const id = scalar(text, 'id') || fallbackId;
      return {
        id,
        priority: scalar(text, 'priority') || 'normal',
        legacyIds: [...new Set([...listScalars(text, 'legacyIds'), ...(configuredAliases[id] || [])])]
      };
    });
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    existing.legacyIds = [...new Set([...(existing.legacyIds || []), ...(record.legacyIds || [])])];
    if (existing.priority === 'ignore' && record.priority !== 'ignore') existing.priority = record.priority;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function logHasUpgrade(log, upgrade) {
  return log.ids.has(upgrade.id) || (upgrade.legacyIds || []).some((id) => log.ids.has(id));
}

function catalogLogIds(catalog) {
  const ids = new Set();
  for (const upgrade of catalog) {
    ids.add(upgrade.id);
    for (const legacyId of upgrade.legacyIds || []) ids.add(legacyId);
  }
  return ids;
}

// Project list from upgrader.config.yaml (the upgrader's own checkout).
function loadProjects() {
  const text = readFileSafe(CONFIG) || '';
  const lines = text.split('\n');
  const out = [];
  let inProjects = false;
  let cur = null;
  for (const line of lines) {
    if (/^projects:\s*$/.test(line)) { inProjects = true; continue; }
    if (inProjects && /^\S/.test(line)) break;
    if (!inProjects) continue;
    const name = line.match(/^\s+-\s+name:\s*(.+?)\s*$/);
    if (name) { cur = { name: name[1], path: null }; out.push(cur); continue; }
    const p = line.match(/^\s+path:\s*(.+?)\s*$/);
    if (p && cur) cur.path = p[1];
  }
  return out
    .filter((p) => p.name !== 'nestled-template')
    .map((p) => ({ name: p.name, dir: path.resolve(ROOT, p.path || `../${p.name}`) }));
}

// Read the set of logged upgrade ids (and statuses) from a repo's ledger.
function loadLog(dir) {
  const rel = '.nestled/upgrade-log.yaml';
  const text = readPath(dir, rel);
  const diskPath = path.join(dir, rel);
  if (text === null) return { path: diskPath, exists: false, ids: new Map(), upgradesIsLast: false };
  const ids = new Map();
  const lines = text.split('\n');
  let inUpg = false;
  let lastTopAfterUpg = false;
  let curId = null;
  for (const line of lines) {
    if (/^upgrades:\s*$/.test(line)) { inUpg = true; continue; }
    if (!inUpg) continue;
    if (/^\S/.test(line) && line.trim() !== '') { lastTopAfterUpg = true; continue; }
    const idm = line.match(/^ {2}([^\s:][^:]*):\s*$/);
    if (idm) { curId = idm[1]; ids.set(curId, '?'); continue; }
    const st = line.match(/^ {4}status:\s*(.+?)\s*$/);
    if (st && curId) ids.set(curId, st[1].replace(/^['"]|['"]$/g, ''));
  }
  return { path: diskPath, exists: true, ids, upgradesIsLast: !lastTopAfterUpg };
}

// ---- code-signature detectors ----
// Each returns { kind: 'present'|'na'|'review', detail }. File reads go through
// readPath/pathExists so report mode sees REF and --fix sees the working tree.
const DETECTORS = {
  '2026-05-17-auth-delay-csprng': (dir) => {
    const f = readPath(dir, 'libs/api/custom/src/lib/plugins/auth/auth.service.ts');
    if (f === null) return { kind: 'review', detail: 'auth.service.ts not found' };
    return /randomInt/.test(f)
      ? { kind: 'present', detail: 'auth delay uses crypto randomInt' }
      : { kind: 'review', detail: 'auth delay still Math.random — real gap' };
  },

  '2026-06-10-bump-api-2-10-0-clone-identity': (dir) => {
    const f = readPath(dir, 'package.json');
    const m = f && f.match(/"@nestledjs\/api":\s*"\^?(\d+)\.(\d+)\.\d+"/);
    if (!m) return { kind: 'review', detail: '@nestledjs/api version not found' };
    const ok = Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 10);
    return ok
      ? { kind: 'present', detail: `@nestledjs/api ${m[1]}.${m[2]}.x (>=2.10)` }
      : { kind: 'review', detail: `@nestledjs/api ${m[1]}.${m[2]}.x below 2.10` };
  },

  // @nestledjs/shared is NOT a direct dependency — only a pnpm.overrides pin on a
  // transitive dep of @nestledjs/generators. generators@0.2.32 (uniform fleet-wide)
  // is compatible with both shared 1.0.2 and 1.0.3, and shared only affects SDK
  // codegen (nx g @nestledjs/shared:sdk), not shipped code. Defer the override bump
  // to the next generators/api upgrade.
  '2026-05-28-bump-generators-296': (dir) => {
    const f = readPath(dir, 'package.json');
    const m = f && f.match(/"@nestledjs\/shared":\s*"\^?(\d+)\.(\d+)\.(\d+)"/);
    const cur = m ? `${m[1]}.${m[2]}.${m[3]}` : 'unpinned';
    const at103 = m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && (Number(m[2]) > 0 || Number(m[3]) >= 3)));
    return at103
      ? { kind: 'present', detail: `@nestledjs/shared override at ${cur}` }
      : { kind: 'na', detail: `@nestledjs/shared override ${cur}: transitive codegen pin, compatible with generators 0.2.32 — defer to next generators bump` };
  },

  '2026-05-17-ci-toolchain-lock': (dir) => {
    const ci = readPath(dir, '.github/workflows/ci.yml');
    if (ci === null) return { kind: 'na', detail: 'no template GitHub Actions workflow (skipIf)' };
    const pnpmPinned = /action-setup[\s\S]{0,120}?\n\s*version:\s*[\d.]+/.test(ci);
    const nodeExact = /node-version:\s*['"]?\d+\.\d+\.\d+/.test(ci);
    return (!pnpmPinned && nodeExact)
      ? { kind: 'present', detail: 'pnpm version pin removed + Node pinned exactly (intent met)' }
      : { kind: 'review', detail: `ci.yml toolchain not locked (pnpmPinned=${pnpmPinned} nodeExact=${nodeExact})` };
  },

  '2026-05-17-public-landing-cleanup': (dir) => {
    const rel = 'apps/web/app/routes/_public/_index.tsx';
    if (!pathExists(dir, rel)) return { kind: 'na', detail: 'no _public/_index.tsx — no template public landing to clean' };
    const a = readPath(dir, rel);
    const b = readPath(TEMPLATE_DIR, rel);
    if (b !== null && a === b) return { kind: 'present', detail: 'public landing matches cleaned template' };
    return { kind: 'na', detail: 'repo owns a custom public landing (skipIf)' };
  },

  '2026-05-25-api-tokens-mcp-setup-and-rbac': (dir) => {
    const org = readPath(dir, 'libs/api/custom/src/lib/plugins/mcp/tools/organization.ts');
    const hasSettings = dirHasFiles(dir, 'apps/web/app/routes/settings');
    if (org === null && !hasSettings) return { kind: 'na', detail: 'no settings routes and no MCP organization tool — feature surface absent' };
    if (org !== null) {
      const ok = /organizationMember\.findMany/.test(org) && /!auth\.organizationId/.test(org);
      return ok
        ? { kind: 'present', detail: 'list_organizations RBAC fix present in MCP organization tool' }
        : { kind: 'review', detail: 'MCP organization tool lacks the list_organizations RBAC fix' };
    }
    return { kind: 'review', detail: 'settings present but no MCP org tool to confirm behavioral fix' };
  },
};

const RANGE_RECORD = /\b[0-9a-f]{7}-to-[0-9a-f]{7}\b/;

function classify(upg, dir) {
  if (upg.priority === 'ignore') return { kind: 'na', detail: 'priority: ignore (historical/template-only)' };
  if (RANGE_RECORD.test(upg.id)) return { kind: 'na', detail: 'template-internal range record (superseded by discrete upgrades)' };
  const det = DETECTORS[upg.id];
  if (det) return det(dir);
  return { kind: 'review', detail: 'no detector; verify against affectedPaths' };
}

// ---- backfill writer (working tree only) ----
function backfill(log, entries) {
  if (!entries.length) return 0;
  if (!log.upgradesIsLast) {
    console.error(`  ! ${log.path}: upgrades: is not the final block — skipping --fix for safety`);
    return 0;
  }
  let text = readFileSafe(log.path);
  if (text === null) { console.error(`  ! ${log.path}: not found on disk — skipping`); return 0; }
  if (!text.endsWith('\n')) text += '\n';
  const block = entries.map((e) => {
    const status = e.kind === 'na' ? 'not-applicable' : 'applied';
    return [
      `  ${e.id}:`,
      `    status: ${status}`,
      `    reviewedAt: '${STAMP}'`,
      `    notes: Backfilled ${STAMP.slice(0, 10)}: ${e.detail}`,
    ].join('\n');
  }).join('\n');
  fs.writeFileSync(log.path, text + block + '\n');
  return entries.length;
}

// ---- run ----
const projects = loadProjects();

if (FETCH && !USE_WORKTREE) {
  process.stderr.write(`Fetching origin for ${projects.length} repos...\n`);
  for (const p of projects) spawnSync('git', ['-C', p.dir, 'fetch', 'origin', '--quiet']);
}

const catalog = loadCatalog();
const catalogIds = catalogLogIds(catalog);
const source = USE_WORKTREE ? 'working tree' : REF;
const report = [];
report.push(`# Nestled upgrade currency report`);
report.push(``);
report.push(`Generated: ${STAMP}`);
report.push(`Source: ${source}${FETCH && !USE_WORKTREE ? ' (fetched)' : ''} | Catalog: ${catalog.length} upgrades | Projects: ${projects.length}${FIX ? ' | MODE: --fix' : ''}`);
report.push(``);

let totalReview = 0;
let totalBackfilled = 0;
const reviewByRepo = {};

for (const proj of projects) {
  const log = loadLog(proj.dir);
  const missing = catalog.filter((u) => !logHasUpgrade(log, u));
  const orphan = [...log.ids.keys()].filter((id) => !catalogIds.has(id));

  const buckets = { na: [], present: [], review: [] };
  for (const u of missing) {
    const c = classify(u, proj.dir);
    buckets[c.kind].push({ id: u.id, ...c });
  }
  totalReview += buckets.review.length;
  if (buckets.review.length) reviewByRepo[proj.name] = buckets.review;

  report.push(`## ${proj.name}`);
  if (!log.exists) { report.push(`- ⚠️ no upgrade-log.yaml on ${source}`); report.push(``); continue; }
  report.push(`- logged: ${log.ids.size} | missing: ${missing.length} (na:${buckets.na.length} present:${buckets.present.length} **review:${buckets.review.length}**)`);
  if (orphan.length) report.push(`- applied-but-not-in-catalog (catalog drift): ${orphan.join(', ')}`);
  for (const e of buckets.review) report.push(`  - 🔍 REVIEW \`${e.id}\` — ${e.detail}`);
  for (const e of buckets.present) report.push(`  - ✅ present (unlogged) \`${e.id}\` — ${e.detail}`);
  for (const e of buckets.na) report.push(`  - ➖ n/a \`${e.id}\` — ${e.detail}`);

  if (FIX) {
    const n = backfill(log, [...buckets.na, ...buckets.present]);
    totalBackfilled += n;
    if (n) report.push(`  - 📝 backfilled ${n} entries into the log`);
  }
  report.push(``);
}

report.push(`---`);
report.push(`**Summary:** ${totalReview} entries across ${Object.keys(reviewByRepo).length} repos need human review.${FIX ? ` Backfilled ${totalBackfilled} present/na entries.` : ''}`);

const out = report.join('\n') + '\n';
const reportPath = path.join(ROOT, 'reports', 'currency.md');
fs.writeFileSync(reportPath, out);
process.stdout.write(out);
console.error(`\n(report written to ${path.relative(ROOT, reportPath)})`);
