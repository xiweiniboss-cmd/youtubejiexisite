import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../_worker.js';
// 本地测试默认不配人机验证密钥：显式声明跳过（生产缺密钥会 fail-closed 503）
{ const _f = worker.fetch.bind(worker); worker.fetch = (r, e, c) => _f(r, { TURNSTILE_DISABLED: '1', ...(e || {}) }, c); }


// 解析失败记录（接了 parse-log 之后失败就是 ok=0 的解析记录）：上游失败时往 D1 parse_log 插一行 ok=0，链接 / 原因去掉令牌参数；4xx 不记；不碰共用 KV；不影响响应
function memKV() {
  const m = new Map(), log = [];
  return { m, log, get: async (k) => { log.push(['get', k]); return m.get(k) ?? null; }, put: async (k, v, o) => { log.push(['put', k, o]); m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [] }) };
}
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE parse_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', fp TEXT NOT NULL DEFAULT '')");
  db.exec("CREATE TABLE rate_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL DEFAULT 0)");
  return { db, prepare(sql) { let a = []; const st = { bind(...x) { a = x; return st; }, async run() { db.prepare(sql).run(...a); return { success: true }; }, async all() { return { results: db.prepare(sql).all(...a) }; }, async first() { return db.prepare(sql).get(...a) || null; } }; return st; } };
}

test('parse 上游失败 → D1 parse_log 记一行 ok=0（链接不带 si 等参数），不写 pf_ KV，响应照旧 502', async () => {
  const kv = memKV();
  const d1 = fakeD1();
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('broken', { status: 500 });
  try {
    const env = { TURNSTILE_DISABLED: '1', FEEDBACK_KV: kv, PARSE_DB: d1, REDFOX_API_KEY: 'fake' };
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=SECRETTOKEN';
    const r = await worker.fetch(new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent(url), { headers: { 'cf-connecting-ip': '198.51.100.7' } }), env, ctx);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).ok, false);
    while (jobs.length) await jobs.shift();
    const rows = d1.db.prepare('SELECT * FROM parse_log').all();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].site, rows[0].ok, rows[0].status, rows[0].url, rows[0].ip], ['youtube', 0, 502, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '198.51.100.7']);
    assert.ok(!JSON.stringify(rows).includes('SECRETTOKEN'));
    assert.ok(!kv.log.some((x) => x[0] === 'put' && String(x[1]).startsWith('pf_')), '不写 pf_ KV');
    // 4xx（不是 YouTube 链接）不记
    const r2 = await worker.fetch(new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent('https://example.com/x'), { headers: { 'cf-connecting-ip': '198.51.100.8' } }), env, ctx);
    assert.equal(r2.status, 400);
    while (jobs.length) await jobs.shift();
    assert.equal(d1.db.prepare('SELECT count(*) c FROM parse_log').get().c, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('预览部署：解析 / 下载类接口一律 403，不打上游', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x', { status: 500 }); };
  try {
    for (const p of ['/api/parse?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ', '/api/ytdl?url=x', '/api/yt-direct?url=x', '/api/yt1080-start', '/api/yt-hd?url=x']) {
      const r = await worker.fetch(new Request('https://feat-parse-failure-log.youtubejiexisite.pages.dev' + p, { headers: { 'cf-connecting-ip': '198.51.100.9' } }), { REDFOX_API_KEY: 'fake' }, { waitUntil() {} });
      assert.equal(r.status, 403, p);
      assert.match((await r.json()).error, /预览环境/);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = orig; }
});
