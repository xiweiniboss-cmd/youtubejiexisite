import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../_worker.js';

// 解析失败记录（pf-recorder）：上游失败时写 pf_youtube_<北京日期>，链接去掉令牌参数；4xx 不记；不影响响应
function memKV() {
  const m = new Map(), log = [];
  return { m, log, get: async (k) => { log.push(['get', k]); return m.get(k) ?? null; }, put: async (k, v, o) => { log.push(['put', k, o]); m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [] }) };
}
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

test('parse 上游失败 → 记一条 pf_youtube_<日期>（35 天过期，链接不带 si 等参数），响应照旧 502', async () => {
  const kv = memKV();
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p) };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('broken', { status: 500 });
  try {
    const env = { FEEDBACK_KV: kv, REDFOX_API_KEY: 'fake' };
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=SECRETTOKEN';
    const r = await worker.fetch(new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent(url), { headers: { 'cf-connecting-ip': '198.51.100.7' } }), env, ctx);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).ok, false);
    while (jobs.length) await jobs.shift();
    const raw = kv.m.get('pf_youtube_' + today());
    assert.ok(raw, '写了 pf_ 键');
    const rec = JSON.parse(raw);
    assert.equal(rec.n, 1);
    assert.equal(rec.last[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.ok(!raw.includes('SECRETTOKEN'));
    const put = kv.log.find((x) => x[0] === 'put' && x[1].startsWith('pf_'));
    assert.equal(put[2].expirationTtl, 35 * 86400);
    // 4xx（不是 YouTube 链接）不记
    const r2 = await worker.fetch(new Request('https://youtubejiexisite.pages.dev/api/parse?url=' + encodeURIComponent('https://example.com/x'), { headers: { 'cf-connecting-ip': '198.51.100.8' } }), env, ctx);
    assert.equal(r2.status, 400);
    while (jobs.length) await jobs.shift();
    assert.equal(JSON.parse(kv.m.get('pf_youtube_' + today())).n, 1);
  } finally {
    globalThis.fetch = orig;
  }
});
