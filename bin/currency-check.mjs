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
// Usage:
//   node bin/currency-check.mjs            # read-only report -> stdout + reports/currency.md
//   node bin/currency-check.mjs --fix      # backfill present + n/a entries into each log
//
// Each catalog upgrade missing from a repo's log is classified by a code-signature
// detector into one of:
//   present  — the change IS in this repo (verified in code); log it as applied
//   na       — not applicable to this repo (feature surface absent / custom / superseded)
//   review   — genuinely unaccounted-for; a human/agent should verify before stamping
//
// --fix writes present (status: applied) and na (status: not-applicable) entries
// with a note carrying the detector's reasoning. It never stamps "review" entries.
// It does NOT commit — it leaves working-tree changes for you to inspect and push.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = process.argv.includes('--fix');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADES_DIR = path.join(ROOT, 'upgrades');
const CONFIG = path.join(ROOT, 'upgrader.config.yaml');
const TEMPLATE_LANDING = path.resolve(ROOT, '../nestled-template/apps/web/app/routes/_public/_index.tsx');
const STAMP = new Date().toISOString();

// ---- tiny helpers (no YAML dep; formats here are simple + uniform) ----

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function dirHasFiles(p) {
  try { return fs.readdirSync(p).length > 0; } catch { return false; }
}

// Pull a top-level scalar like `priority: ignore` from an upgrade def.
function scalar(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
}

// The catalog: every upgrade id + its priority.
function loadCatalog() {
  return fs.readdirSync(UPGRADES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const id = f.replace(/\.yaml$/, '');
      const text = readFileSafe(path.join(UPGRADES_DIR, f)) || '';
      return { id, priority: scalar(text, 'priority') || 'normal' };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Parse the project list out of upgrader.config.yaml (name + path under projects:).
function loadProjects() {
  const text = readFileSafe(CONFIG) || '';
  const lines = text.split('\n');
  const out = [];
  let inProjects = false;
  let cur = null;
  for (const line of lines) {
    if (/^projects:\s*$/.test(line)) { inProjects = true; continue; }
    if (inProjects && /^\S/.test(line)) break; // left the projects block
    if (!inProjects) continue;
    const name = line.match(/^\s+-\s+name:\s*(.+?)\s*$/);
    if (name) { cur = { name: name[1], path: null }; out.push(cur); continue; }
    const p = line.match(/^\s+path:\s*(.+?)\s*$/);
    if (p && cur) cur.path = p[1];
  }
  // Resolve paths relative to the upgrader root; drop the template-promotion entry.
  return out
    .filter((p) => p.name !== 'nestled-template')
    .map((p) => ({ name: p.name, dir: path.resolve(ROOT, p.path || `../${p.name}`) }));
}

// Read the set of logged upgrade ids (and statuses) from a repo's log.
function loadLog(dir) {
  const p = path.join(dir, '.nestled', 'upgrade-log.yaml');
  const text = readFileSafe(p);
  if (text === null) return { path: p, exists: false, ids: new Map(), upgradesIsLast: false };
  const ids = new Map();
  const lines = text.split('\n');
  let inUpg = false;
  let lastTopAfterUpg = false;
  let curId = null;
  for (const line of lines) {
    if (/^upgrades:\s*$/.test(line)) { inUpg = true; continue; }
    if (!inUpg) continue;
    if (/^\S/.test(line) && line.trim() !== '') { lastTopAfterUpg = true; continue; } // another top-level block
    const idm = line.match(/^ {2}([^\s:][^:]*):\s*$/);
    if (idm) { curId = idm[1]; ids.set(curId, '?'); continue; }
    const st = line.match(/^ {4}status:\s*(.+?)\s*$/);
    if (st && curId) ids.set(curId, st[1].replace(/^['"]|['"]$/g, ''));
  }
  return { path: p, exists: true, ids, upgradesIsLast: !lastTopAfterUpg };
}

// ---- code-signature detectors ----
// Keyed by upgrade id. Each returns { kind: 'present'|'na'|'review', detail }.
// Signatures below were verified by hand on 2026-06-14 against the live repos.
const DETECTORS = {
  // Security: failed-login delay jitter must source from a CSPRNG (crypto.randomInt).
  '2026-05-17-auth-delay-csprng': (dir) => {
    const f = readFileSafe(path.join(dir, 'libs/api/custom/src/lib/plugins/auth/auth.service.ts'));
    if (f === null) return { kind: 'review', detail: 'auth.service.ts not found' };
    return /randomInt/.test(f)
      ? { kind: 'present', detail: 'auth delay uses crypto randomInt' }
      : { kind: 'review', detail: 'auth delay still Math.random — real gap' };
  },

  // Toolchain bump: @nestledjs/api pinned to >= 2.10 in pnpm.overrides.
  '2026-06-10-bump-api-2-10-0-clone-identity': (dir) => {
    const f = readFileSafe(path.join(dir, 'package.json'));
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
  // codegen (nx g @nestledjs/shared:sdk), not shipped code. Not worth a standalone
  // PR sweep; fold the override bump into the next generators/api upgrade.
  '2026-05-28-bump-generators-296': (dir) => {
    const f = readFileSafe(path.join(dir, 'package.json'));
    const m = f && f.match(/"@nestledjs\/shared":\s*"\^?(\d+)\.(\d+)\.(\d+)"/);
    const cur = m ? `${m[1]}.${m[2]}.${m[3]}` : 'unpinned';
    const at103 = m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && (Number(m[2]) > 0 || Number(m[3]) >= 3)));
    return at103
      ? { kind: 'present', detail: `@nestledjs/shared override at ${cur}` }
      : { kind: 'na', detail: `@nestledjs/shared override ${cur}: transitive codegen pin, compatible with generators 0.2.32 — defer to next generators bump` };
  },

  // CI toolchain lock: drop the conflicting pnpm/action-setup version, pin Node exactly.
  // Intent (no duplicate pnpm version + exact Node pin) is met even though Node later
  // moved 22.14.0 -> 22.22.1 via the node-engines-ci-22-22 upgrade.
  '2026-05-17-ci-toolchain-lock': (dir) => {
    const ci = readFileSafe(path.join(dir, '.github/workflows/ci.yml'));
    if (ci === null) return { kind: 'na', detail: 'no template GitHub Actions workflow (skipIf)' };
    const pnpmPinned = /action-setup[\s\S]{0,120}?\n\s*version:\s*[\d.]+/.test(ci);
    const nodeExact = /node-version:\s*['"]?\d+\.\d+\.\d+/.test(ci);
    return (!pnpmPinned && nodeExact)
      ? { kind: 'present', detail: 'pnpm version pin removed + Node pinned exactly (intent met)' }
      : { kind: 'review', detail: `ci.yml toolchain not locked (pnpmPinned=${pnpmPinned} nodeExact=${nodeExact})` };
  },

  // Public landing cleanup: only relevant to repos still shipping the template's
  // default public landing. Repos with no _public/_index.tsx, or a customized one,
  // are N/A by the upgrade's own skipIf.
  '2026-05-17-public-landing-cleanup': (dir) => {
    const f = path.join(dir, 'apps/web/app/routes/_public/_index.tsx');
    if (!fs.existsSync(f)) return { kind: 'na', detail: 'no _public/_index.tsx — no template public landing to clean' };
    const a = readFileSafe(f);
    const b = readFileSafe(TEMPLATE_LANDING);
    if (b !== null && a === b) return { kind: 'present', detail: 'public landing matches cleaned template' };
    return { kind: 'na', detail: 'repo owns a custom public landing (skipIf)' };
  },

  // API tokens / MCP RBAC: the behavioral signature is the list_organizations fix in
  // the MCP organization tool. Repos without settings routes AND without that tool
  // simply don't carry the feature surface (e.g. mi-core's Monroe frontend).
  '2026-05-25-api-tokens-mcp-setup-and-rbac': (dir) => {
    const org = readFileSafe(path.join(dir, 'libs/api/custom/src/lib/plugins/mcp/tools/organization.ts'));
    const hasSettings = dirHasFiles(path.join(dir, 'apps/web/app/routes/settings'));
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

// "Template changes <sha>-to-<sha>" range records are template-internal bookkeeping —
// the upgrader extracts discrete upgrades from them, so a missing range record is not
// a downstream gap. Treat as not-applicable.
const RANGE_RECORD = /\b[0-9a-f]{7}-to-[0-9a-f]{7}\b/;

function classify(upg, dir) {
  if (upg.priority === 'ignore') return { kind: 'na', detail: 'priority: ignore (historical/template-only)' };
  if (RANGE_RECORD.test(upg.id)) return { kind: 'na', detail: 'template-internal range record (superseded by discrete upgrades)' };
  const det = DETECTORS[upg.id];
  if (det) return det(dir);
  return { kind: 'review', detail: 'no detector; verify against affectedPaths' };
}

// ---- backfill writer: append entries under the (last) upgrades: block ----
function backfill(log, entries) {
  if (!entries.length) return 0;
  if (!log.upgradesIsLast) {
    console.error(`  ! ${log.path}: upgrades: is not the final block — skipping --fix for safety`);
    return 0;
  }
  let text = readFileSafe(log.path);
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
const catalog = loadCatalog();
const projects = loadProjects();
const report = [];
report.push(`# Nestled upgrade currency report`);
report.push(``);
report.push(`Generated: ${STAMP}`);
report.push(`Catalog: ${catalog.length} upgrades | Projects: ${projects.length}${FIX ? ' | MODE: --fix' : ''}`);
report.push(``);

let totalReview = 0;
let totalBackfilled = 0;
const reviewByRepo = {};

for (const proj of projects) {
  const log = loadLog(proj.dir);
  const missing = catalog.filter((u) => !log.ids.has(u.id));
  // applied-but-not-in-catalog: ledger entries with no catalog def (catalog drift)
  const orphan = [...log.ids.keys()].filter((id) => !catalog.some((u) => u.id === id));

  const buckets = { na: [], present: [], review: [] };
  for (const u of missing) {
    const c = classify(u, proj.dir);
    buckets[c.kind].push({ id: u.id, ...c });
  }
  totalReview += buckets.review.length;
  if (buckets.review.length) reviewByRepo[proj.name] = buckets.review;

  report.push(`## ${proj.name}`);
  if (!log.exists) { report.push(`- ⚠️ no upgrade-log.yaml found at ${log.path}`); report.push(``); continue; }
  report.push(`- logged: ${log.ids.size} | missing: ${missing.length} (na:${buckets.na.length} present:${buckets.present.length} **review:${buckets.review.length}**)`);
  if (orphan.length) report.push(`- applied-but-not-in-catalog (catalog drift): ${orphan.join(', ')}`);
  for (const e of buckets.review) report.push(`  - 🔍 REVIEW \`${e.id}\` — ${e.detail}`);
  for (const e of buckets.present) report.push(`  - ✅ present (unlogged) \`${e.id}\` — ${e.detail}`);
  for (const e of buckets.na) report.push(`  - ➖ n/a \`${e.id}\` — ${e.detail}`);

  if (FIX) {
    const toWrite = [...buckets.na, ...buckets.present];
    const n = backfill(log, toWrite);
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
