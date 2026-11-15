import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../_worker.js';
// 本地测试默认不配人机验证密钥：显式声明跳过（生产缺密钥会 fail-closed 503）
{ const _f = worker.fetch.bind(worker); worker.fetch = (r, e, c) => _f(r, { TURNSTILE_DISABLED: '1', ...(e || {}) }, c); }


// 解析记录 + 拉黑（D1 PARSE_DB）：每次解析记一行（IP/归属地/设备/去令牌链接）；黑名单 IP、设备直接 403「访问受限」；D1 挂了照常解析
const SCHEMA = `CREATE TABLE parse_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', fp TEXT NOT NULL DEFAULT '');
CREATE TABLE blocklist (type TEXT NOT NULL CHECK (type IN ('ip','device','fp')), value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (type, value));`;
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const api = { db, fail: false, prepare(sql) {
    let args = [];
    const chk = () => { if (api.fail) throw new Error('D1 down'); };
    const st = { bind(...a) { args = a; return st; },
      async all() { chk(); return { results: db.prepare(sql).all(...args) }; },
      async first() { chk(); return db.prepare(sql).get(...args) || null; },
      async run() { chk(); db.prepare(sql).run(...args); return { success: true }; } };
    return st;
  } };
  return api;
}
const DEV = '11111111-2222-4333-8444-555555555555';
const BAD_DEV = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FP = '0123456789abcdef0123456789abcdef';
const BAD_FP = 'fedcba9876543210fedcba9876543210';
function req(u, ip, dev, fp = FP) {
  const h = { 'cf-connecting-ip': ip };
  if (dev) h['x-device-id'] = dev;
  if (fp) h['x-device-fp'] = fp;
  const r = new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent(u), { headers: h });
  Object.defineProperty(r, 'cf', { value: { country: 'CN', region: 'Guangdong', city: 'Shenzhen' } });
  return r;
}

test('解析记一行 D1；拉黑的 IP（含 IPv6 同 /64）和设备 → 403 访问受限且不打上游', async () => {
  const d1 = fakeD1();
  d1.db.prepare("INSERT INTO blocklist(type,value,note,created_at) VALUES ('ip','203.0.113.66','',1),('ip','2001:db8:1:2::/64','',1),('device',?,'',1),('fp',?,'',1)").run(BAD_DEV, BAD_FP);
  const jobs = []; const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async () => { upstream++; return new Response('broken', { status: 500 }); };
  try {
    const env = { TURNSTILE_DISABLED: '1', PARSE_DB: d1, REDFOX_API_KEY: 'fake' };
    const r = await worker.fetch(req('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=SECRETTOKEN', '198.51.100.7', DEV), env, ctx);
    assert.equal(r.status, 502);
    while (jobs.length) await jobs.shift();
    const rows = d1.db.prepare('SELECT * FROM parse_log').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].site, 'youtube');
    assert.equal(rows[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(rows[0].ip, '198.51.100.7');
    assert.equal(rows[0].device_id, DEV);
    assert.equal(rows[0].fp, FP);
    assert.equal(rows[0].ok, 0);
    assert.equal(rows[0].city, 'Shenzhen');

    for (const [ip, dev, fp] of [['203.0.113.66', DEV, FP], ['2001:db8:1:2:aaaa::9', DEV, FP], ['198.51.100.8', BAD_DEV, FP], ['198.51.100.9', DEV, BAD_FP]]) {
      const before = upstream;
      const rb = await worker.fetch(req('https://www.youtube.com/watch?v=dQw4w9WgXcQ', ip, dev, fp), env, ctx);
      assert.equal(rb.status, 403, ip + ' 应被拦');
      const j = await rb.json();
      assert.equal(j.ok, false);
      assert.equal(j.error, '访问受限');
      assert.equal(upstream, before, '拦下来就不该打上游');
    }
    while (jobs.length) await jobs.shift();
    // 同 /64 之外的 IPv6 不拦
    const r6 = await worker.fetch(req('https://example.com/x', '2001:db8:1:3::9', DEV), env, ctx);
    assert.equal(r6.status, 400);
    // 无效链接（不是 YouTube / 空）不记
    const n0 = d1.db.prepare('SELECT count(*) c FROM parse_log').get().c;
    for (const u of ['https://example.com/y', '']) assert.equal((await worker.fetch(req(u, '198.51.100.30', DEV), env, ctx)).status, 400);
    while (jobs.length) await jobs.shift();
    assert.equal(d1.db.prepare('SELECT count(*) c FROM parse_log').get().c, n0, '无效链接不该记');
  } finally { globalThis.fetch = orig; }
});

test('没绑 PARSE_DB：行为和以前一样', async () => {
  const r = await worker.fetch(req('https://example.com/x', '198.51.100.20', DEV), { REDFOX_API_KEY: 'fake' }, { waitUntil() {} });
  assert.equal(r.status, 400);
});

test('没过人机验证 / 被冷却拦下的请求不写 D1；被拉黑的人下载接口也 403', async () => {
  const d1 = fakeD1();
  d1.db.prepare("INSERT INTO blocklist(type,value,note,created_at) VALUES ('ip','203.0.113.66','',1)").run();
  const jobs = []; const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async (u) => {
    if (String(u).includes('challenges.cloudflare.com')) return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { headers: { 'content-type': 'application/json' } });
    upstream++; return new Response('broken', { status: 500 });
  };
  try {
    const env = { PARSE_DB: d1, REDFOX_API_KEY: 'fake', TURNSTILE_SECRET_KEY: 'secret-not-real' };
    for (let i = 0; i < 20; i++) {
      const r = await worker.fetch(req('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '198.51.100.' + (40 + i), DEV), env, ctx);
      assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    }
    while (jobs.length) await jobs.shift();
    assert.equal(d1.db.prepare('SELECT count(*) c FROM parse_log').get().c, 0, '没过人机验证不该写');
    assert.equal(upstream, 0);
    for (const p of ['/api/ytdl?url=x', '/api/yt-direct?url=x', '/api/yt1080-file?id=x']) {
      const h = { 'cf-connecting-ip': '203.0.113.66' };
      const r = await worker.fetch(new Request('https://youtubejiexisite.pages.dev' + p, { headers: h }), { PARSE_DB: d1 }, ctx);
      if (p.startsWith('/api/yt1080-file')) assert.equal(r.status, 403, p);
      else assert.ok(r.status === 403 || r.status === 400, p + ' ' + r.status);
    }
  } finally { globalThis.fetch = orig; }
});
