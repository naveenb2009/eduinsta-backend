/*
 * Reports of reels, comments and accounts (Google Play's user-generated
 * content rules: users must be able to report content and accounts, and the
 * owner must be able to act on reports).
 *
 *   kind      : 'reel' | 'comment' | 'account'
 *   target_id : reel id | comment id | account public id
 *   status    : 'open' | 'removed' | 'dismissed'
 *
 * Postgres when DATABASE_URL is set, in-memory otherwise (local testing).
 */
const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
function getPool() {
  if (pool || !HAS_DB) return pool;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}
const mem = []; let memId = 0;
const KINDS = ['reel', 'comment', 'account'];

async function initSchema() {
  if (!HAS_DB) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS reports (
      id           BIGSERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      reason       TEXT NOT NULL,
      details      TEXT,
      reporter_pid TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, id DESC);
  `);
}

/* One open report per person per item is enough: repeats are ignored. */
async function create({ kind, targetId, reason, details, reporterPid }) {
  if (!KINDS.includes(kind)) return { error: 'Unknown report type' };
  const target = String(targetId || '').slice(0, 64);
  const why = String(reason || '').trim().slice(0, 120);
  if (!target || !why) return { error: 'Choose a reason for the report' };
  const det = String(details || '').slice(0, 1000);
  if (!HAS_DB) {
    if (reporterPid && mem.some((r) => r.kind === kind && r.target_id === target && r.reporter_pid === reporterPid && r.status === 'open')) return { ok: true, duplicate: true };
    mem.push({ id: ++memId, kind, target_id: target, reason: why, details: det, reporter_pid: reporterPid || null, status: 'open', created_at: new Date() });
    return { ok: true };
  }
  if (reporterPid) {
    const { rowCount } = await getPool().query(
      `SELECT 1 FROM reports WHERE kind=$1 AND target_id=$2 AND reporter_pid=$3 AND status='open'`, [kind, target, reporterPid]
    );
    if (rowCount) return { ok: true, duplicate: true };
  }
  await getPool().query(
    'INSERT INTO reports (kind, target_id, reason, details, reporter_pid) VALUES ($1,$2,$3,$4,$5)', [kind, target, why, det, reporterPid || null]
  );
  return { ok: true };
}

/* Open reports grouped per item (newest first), with how many people reported it. */
async function listOpen(limit = 100) {
  let rows;
  if (!HAS_DB) rows = mem.filter((r) => r.status === 'open');
  else ({ rows } = await getPool().query(`SELECT * FROM reports WHERE status='open' ORDER BY id DESC LIMIT 1000`));
  const groups = new Map();
  for (const r of rows.sort((a, b) => Number(b.id) - Number(a.id))) {
    const k = `${r.kind}|${r.target_id}`;
    if (!groups.has(k)) groups.set(k, { kind: r.kind, targetId: r.target_id, reasons: [], details: [], count: 0, latest: new Date(r.created_at).getTime(), id: Number(r.id) });
    const g = groups.get(k);
    g.count++; if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    if (r.details) g.details.push(r.details);
  }
  return [...groups.values()].slice(0, limit);
}

/* Close every open report about one item. */
async function resolve(kind, targetId, status) {
  const st = status === 'removed' ? 'removed' : 'dismissed';
  if (!HAS_DB) { mem.forEach((r) => { if (r.kind === kind && r.target_id === String(targetId) && r.status === 'open') r.status = st; }); return; }
  await getPool().query(
    `UPDATE reports SET status=$3, resolved_at=now() WHERE kind=$1 AND target_id=$2 AND status='open'`, [kind, String(targetId), st]
  );
}
async function countOpen() {
  if (!HAS_DB) return mem.filter((r) => r.status === 'open').length;
  const { rows } = await getPool().query(`SELECT COUNT(*)::int AS n FROM reports WHERE status='open'`);
  return rows[0].n;
}

module.exports = { initSchema, create, listOpen, resolve, countOpen, KINDS, HAS_DB };
