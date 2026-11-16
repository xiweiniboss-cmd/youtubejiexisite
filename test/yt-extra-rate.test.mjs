import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../_worker.js';

// yt-hd / yt-direct：解析成功发的小票（绑视频 ID + IP，限次）不扣次数；没票扣单独计数（每天 20，无冷却）；D1 挂了 → 503 服务繁忙
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE rate_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL DEFAULT 0)");
  const api = { db, fail: false, prepare(sql) { let a = []; const chk = () => { if (api.fail) throw new Error('D1 down'); };
    const st = { bind(...x) { a = x; return st; }, async run() { chk(); db.prepare(sql).run(...a); return { success: true }; },
      async all() { chk(); return { results: db.prepare(sql).all(...a) }; }, async first() { chk(); return db.prepare(sql).get(...a) || null; } };
    return st; } };
  return api;
}
const VID = 'dQw4w9WgXcQ';
const call = (env, ip, path = '/api/yt-direct') => worker.fetch(new Request('https://youtubejiexisite.pages.dev' + path + '?url=' + encodeURIComponent('https://youtu.be/' + VID), { headers: { 'cf-connecting-ip': ip } }), env, { waitUntil() {} });
async function withFetch(fn) { const o = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); try { return await fn(); } finally { globalThis.fetch = o; } }
const n = (d1, k) => (d1.db.prepare('SELECT n FROM rate_counter WHERE k = ?').get(k) || {}).n || 0;

test('小票：yt-direct 带票 2 次不扣次数，第 3 次扣单独计数；换 IP 票无效', async () => {
  const d1 = fakeD1();
  const env = { TURNSTILE_DISABLED: '1', PARSE_DB: d1 };
  d1.db.prepare('INSERT INTO rate_counter (k, n, last, exp) VALUES (?, 0, 0, ?)').run('ytt:direct:198.51.100.9:' + VID, Date.now() + 600000);
  await withFetch(async () => {
    for (let i = 0; i < 2; i++) assert.notEqual((await call(env, '198.51.100.9')).status, 429);
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    assert.equal(n(d1, 'youtube_hd:198.51.100.9:' + day), 0, '带票不扣');
    await call(env, '198.51.100.9');
    assert.equal(n(d1, 'youtube_hd:198.51.100.9:' + day), 1, '票用完扣计数');
    await call(env, '198.51.100.10');
    assert.equal(n(d1, 'ytt:direct:198.51.100.9:' + VID), 2, '别的 IP 用不了这张票');
  });
});

test('没票：同 IP 并发 30 次只放 20 次，不设冷却', async () => {
  const d1 = fakeD1();
  const env = { TURNSTILE_DISABLED: '1', PARSE_DB: d1 };
  await withFetch(async () => {
    const rs = await Promise.all(Array.from({ length: 30 }, () => call(env, '203.0.113.5')));
    assert.equal(rs.filter((r) => r.status === 429).length, 10);
  });
});

test('D1 挂了：yt-direct / yt-hd 返回 503「服务繁忙，请稍后再试」', async () => {
  const d1 = fakeD1(); d1.fail = true;
  const env = { TURNSTILE_DISABLED: '1', PARSE_DB: d1 };
  await withFetch(async () => {
    for (const p of ['/api/yt-direct', '/api/yt-hd']) {
      const r = await call(env, '203.0.113.6', p);
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /服务繁忙/);
    }
  });
});
