import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../_worker.js';

// 解析记录预览卡片（parse-log v3）：成功解析把封面 / 标题 / 类型写进 D1；上游没封面时用视频 ID 拼 i.ytimg.com；迁移前照样能写
const BASE = `CREATE TABLE parse_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', fp TEXT NOT NULL DEFAULT '');
CREATE TABLE blocklist (type TEXT NOT NULL, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (type, value));
CREATE TABLE rate_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL DEFAULT 0);`;
const MIGRATION = `ALTER TABLE parse_log ADD COLUMN cover TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN title TEXT DEFAULT ''; ALTER TABLE parse_log ADD COLUMN media TEXT DEFAULT '';`;
function fakeD1(migrated) {
  const db = new DatabaseSync(':memory:');
  db.exec(BASE); if (migrated) db.exec(MIGRATION);
  return { db, prepare(sql) {
    let args = [];
    const st = { bind(...a) { args = a; return st; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async run() { db.prepare(sql).run(...args); return { success: true }; } };
    return st;
  } };
}
function req(u, ip) {
  const r = new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent(u), { headers: { 'cf-connecting-ip': ip, 'x-device-id': '11111111-2222-4333-8444-555555555555' } });
  Object.defineProperty(r, 'cf', { value: { country: 'CN' } });
  return r;
}
async function run(d1, data, ip) {
  const jobs = []; const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('/story/api/') ? new Response(JSON.stringify({ code: 2000, data })) : new Response('', { status: 404 });
  try {
    const r = await worker.fetch(req('https://youtu.be/dQw4w9WgXcQ?si=TOKEN', ip), { TURNSTILE_DISABLED: '1', PARSE_DB: d1, REDFOX_API_KEY: 'fake' }, ctx);
    while (jobs.length) await jobs.shift();
    return r;
  } finally { globalThis.fetch = orig; }
}
const RES = [{ url: 'https://rr1.googlevideo.com/videoplayback?id=1', type: 'video' }];

test('成功解析：标题 + 类型写进 D1；上游没封面 → i.ytimg.com/vi/<id>/hqdefault.jpg', async () => {
  const d1 = fakeD1(true);
  const r = await run(d1, { title: 'Never\nGonna', resources: RES }, '198.51.100.71');
  assert.equal(r.status, 200);
  const row = d1.db.prepare('SELECT ok, cover, title, media FROM parse_log').get();
  assert.deepEqual({ ...row }, { ok: 1, cover: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', title: 'Never Gonna', media: 'video' });
});

test('上游给了封面就用上游的（// 开头补 https:）', async () => {
  const d1 = fakeD1(true);
  await run(d1, { title: 't', cover: '//i.ytimg.com/vi/x/maxres.jpg', resources: RES }, '198.51.100.72');
  assert.equal(d1.db.prepare('SELECT cover FROM parse_log').get().cover, 'https://i.ytimg.com/vi/x/maxres.jpg');
});

test('线上库还没迁移：照样记一行（退回旧列），解析响应不受影响', async () => {
  const d1 = fakeD1(false);
  const r = await run(d1, { title: 't', resources: RES }, '198.51.100.73');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const rows = d1.db.prepare('SELECT ok FROM parse_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 1);
});
