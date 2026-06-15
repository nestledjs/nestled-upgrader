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
//   node bin/currency-check.mjs --fix      # backfill verified-applied + ignore entries into each log
//
// Classification of each catalog upgrade missing from a repo's log:
//   na-ignore  — upgrade def is priority: ignore (historical/template-only; no downstream action)
//   present    — a code-signature detector confirms the change IS in this repo (unlogged)
//   review     — genuinely unaccounted-for; a human/agent should verify before stamping
//
// --fix writes na-ignore (status: not-applicable) and present (status: applied)
// entries with a backfill note. It never stamps "review" entries. It does NOT
// commit — it leaves working-tree changes for you to inspect and push per repo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = process.argv.includes('--fix');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADES_DIR = path.join(ROOT, 'upgrades');
const CONFIG = path.join(ROOT, 'upgrader.config.yaml');
const STAMP = new Date().toISOString();

// ---- tiny helpers (no YAML dep; formats here are simple + uniform) ----

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
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

// ---- code-signature detectors: high-confidence "is this change in the code?" ----
// Keyed by upgrade id. Return true if present, false if absent, null if undetectable.
const DETECTORS = {
  '2026-05-17-auth-delay-csprng': (dir) => {
    const f = readFileSafe(path.join(dir, 'libs/api/custom/src/lib/plugins/auth/auth.service.ts'));
    return f === null ? null : /randomInt/.test(f);
  },
  '2026-06-10-bump-api-2-10-0-clone-identity': (dir) => {
    const f = readFileSafe(path.join(dir, 'package.json'));
    if (f === null) return null;
    const m = f.match(/"@nestledjs\/api":\s*"\^?(\d+)\.(\d+)\.(\d+)"/);
    if (!m) return null;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    return maj > 2 || (maj === 2 && min >= 10);
  },
  '2026-05-28-bump-generators-296': (dir) => {
    const f = readFileSafe(path.join(dir, 'package.json'));
    if (f === null) return null;
    const m = f.match(/"@nestledjs\/shared":\s*"\^?(\d+)\.(\d+)\.(\d+)"/);
    if (!m) return null;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return maj > 1 || (maj === 1 && (min > 0 || (min === 0 && pat >= 3)));
  },
};

// "Template changes <sha>-to-<sha>" range records are template-internal bookkeeping —
// the upgrader extracts discrete upgrades from them, so a missing range record is not
// a downstream gap. Treat as not-applicable.
const RANGE_RECORD = /\b[0-9a-f]{7}-to-[0-9a-f]{7}\b/;

function classify(upg, dir) {
  if (upg.priority === 'ignore') return { kind: 'na-ignore', detail: 'priority: ignore (historical/template-only)' };
  if (RANGE_RECORD.test(upg.id)) return { kind: 'na-ignore', detail: 'template-internal range record (superseded by discrete upgrades)' };
  const det = DETECTORS[upg.id];
  if (det) {
    const r = det(dir);
    if (r === true) return { kind: 'present', detail: 'code signature confirms applied' };
    if (r === false) return { kind: 'review', detail: 'code signature ABSENT — likely a real gap' };
  }
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
    const status = e.kind === 'na-ignore' ? 'not-applicable' : 'applied';
    const note = e.kind === 'na-ignore'
      ? `Backfilled ${STAMP.slice(0, 10)}: priority-ignore upgrade, no downstream action.`
      : `Backfilled ${STAMP.slice(0, 10)}: ${e.detail}; present in code, previously unlogged.`;
    return [
      `  ${e.id}:`,
      `    status: ${status}`,
      `    reviewedAt: '${STAMP}'`,
      `    notes: ${note}`,
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

  const buckets = { 'na-ignore': [], present: [], review: [] };
  for (const u of missing) {
    const c = classify(u, proj.dir);
    buckets[c.kind].push({ id: u.id, ...c });
  }
  totalReview += buckets.review.length;
  if (buckets.review.length) reviewByRepo[proj.name] = buckets.review;

  report.push(`## ${proj.name}`);
  if (!log.exists) { report.push(`- ⚠️ no upgrade-log.yaml found at ${log.path}`); report.push(``); continue; }
  report.push(`- logged: ${log.ids.size} | missing: ${missing.length} (ignore:${buckets['na-ignore'].length} present:${buckets.present.length} **review:${buckets.review.length}**)`);
  if (orphan.length) report.push(`- applied-but-not-in-catalog (catalog drift): ${orphan.join(', ')}`);
  for (const e of buckets.review) report.push(`  - 🔍 REVIEW \`${e.id}\` — ${e.detail}`);
  for (const e of buckets.present) report.push(`  - ✅ present (unlogged) \`${e.id}\``);
  for (const e of buckets['na-ignore']) report.push(`  - ➖ n/a \`${e.id}\``);

  if (FIX) {
    const toWrite = [...buckets['na-ignore'], ...buckets.present];
    const n = backfill(log, toWrite);
    totalBackfilled += n;
    if (n) report.push(`  - 📝 backfilled ${n} entries into the log`);
  }
  report.push(``);
}

report.push(`---`);
report.push(`**Summary:** ${totalReview} entries across ${Object.keys(reviewByRepo).length} repos need human review.${FIX ? ` Backfilled ${totalBackfilled} verified/ignore entries.` : ''}`);

const out = report.join('\n') + '\n';
const reportPath = path.join(ROOT, 'reports', 'currency.md');
fs.writeFileSync(reportPath, out);
process.stdout.write(out);
console.error(`\n(report written to ${path.relative(ROOT, reportPath)})`);
