import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { MERGE_LIMIT_HOUR, MERGE_LIMIT_DAY } from '../_worker.js';

function memKV() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix } = {}) => ({ keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }) };
}
async function withFetch(fn, body) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = orig; }
}
const call = (path, init, env) => worker.fetch(new Request('https://youtubejiexisite.pages.dev' + path, init), env);
const START = '/api/yt1080-start?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ');

test('merge start: per-IP hourly limit (IPv6 /64), only successful starts count, 429 in Chinese', async () => {
  const kv = memKV();
  const env = { YT_MERGE_TOKEN: 't', FEEDBACK_KV: kv };
  let ec2 = 0, ec2Status = 200;
  await withFetch(async () => { ec2++; return new Response(JSON.stringify(ec2Status === 200 ? { ok: true, job_id: 'job' + ec2 } : { ok: false, error: 'queue full' }), { status: ec2Status, headers: { 'Content-Type': 'application/json' } }); }, async () => {
    ec2Status = 503;
    const full = await call(START, { method: 'POST', headers: { 'cf-connecting-ip': '2001:db8:aa:bb::1' } }, env);
    assert.equal(full.status, 503);
    ec2Status = 200;
    for (let i = 0; i < MERGE_LIMIT_HOUR; i++) {
      const r = await call(START, { method: 'POST', headers: { 'cf-connecting-ip': '2001:db8:aa:bb::' + (i + 10).toString(16) } }, env);
      assert.equal(r.status, 200, 'start #' + (i + 1));
    }
    const before = ec2;
    const r = await call(START, { method: 'POST', headers: { 'cf-connecting-ip': '2001:db8:aa:bb:ffff::1' } }, env);
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.code, 'MERGE_RATE_LIMIT');
    assert.match(j.error, /每小时最多 5 次/);
    assert.equal(ec2, before, 'limited request must not reach EC2');
    const other = await call(START, { method: 'POST', headers: { 'cf-connecting-ip': '2001:db8:aa:bc::1' } }, env);
    assert.equal(other.status, 200, 'a different /64 is not affected');
  });
});

test('merge start: daily cap', async () => {
  const kv = memKV();
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  kv.m.set('mrl_d_5.6.7.8_' + day, String(MERGE_LIMIT_DAY));
  await withFetch(async () => { throw new Error('must not reach EC2'); }, async () => {
    const r = await call(START, { method: 'POST', headers: { 'cf-connecting-ip': '5.6.7.8' } }, { YT_MERGE_TOKEN: 't', FEEDBACK_KV: kv });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /每天 15 次/);
  });
});

test('CORS: allowlist echo + Vary, foreign origin gets no ACAO, no-Origin same-origin still works', async () => {
  const env = { FEEDBACK_KV: memKV() };
  let r = await call('/api/stats', { headers: { Origin: 'https://evil.example' } }, env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  assert.match(r.headers.get('Vary') || '', /Origin/);
  r = await call('/api/stats', { headers: { Origin: 'https://youtubejiexisite.pages.dev' } }, env);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://youtubejiexisite.pages.dev');
  r = await call('/api/stats', {}, env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('admin: cookie login flow replaces ?key=, attachments served via cookie', async () => {
  const kv = memKV();
  const r2 = new Map([['fb/a/1.jpg', 'image/jpeg']]);
  const env = { FEEDBACK_KV: kv, FEEDBACK_ADMIN_KEY: 'secret-key', FEEDBACK_BUCKET: { get: async (k) => (r2.has(k) ? { body: 'JPG', writeHttpMetadata: (h) => h.set('Content-Type', r2.get(k)) } : null) } };
  const file = '/api/fb-file/' + encodeURIComponent('fb/a/1.jpg');
  assert.equal((await call(file + '?key=secret-key', {}, env)).status, 403);
  assert.equal((await call('/admin', {}, env)).status, 401);
  const login = await call('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.1.1.1' }, body: JSON.stringify({ key: 'secret-key' }) }, env);
  assert.equal(login.status, 200);
  const sc = login.headers.get('Set-Cookie');
  assert.match(sc, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = sc.split(';')[0];
  const f = await call(file, { headers: { Cookie: cookie } }, env);
  assert.equal(f.status, 200);
  assert.equal(await f.text(), 'JPG');
  const page = await (await call('/admin', { headers: { Cookie: cookie } }, env)).text();
  assert.doesNotMatch(page, /\?key=/);
  const legacy = await call('/dashboard?key=secret-key', { headers: { 'cf-connecting-ip': '1.1.1.1' } }, env);
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('Location'), '/dashboard');
});

test('ytdl: redirect to a non-allowlisted host is refused without fetching it', async () => {
  const seen = [];
  await withFetch(async (u, init) => {
    seen.push(String(u));
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest/meta-data/' } });
  }, async () => {
    const r = await call('/api/ytdl?url=' + encodeURIComponent('https://rr1---sn.googlevideo.com/videoplayback?id=1'), {}, {});
    assert.equal(r.status, 400);
    assert.deepEqual(seen, ['https://rr1---sn.googlevideo.com/videoplayback?id=1']);
  });
});

test('admin: Authorization: Bearer is no longer accepted; lockout applies before compare (11th attempt even with right password is 429)', async () => {
  const env = { FEEDBACK_KV: memKV(), FEEDBACK_ADMIN_KEY: 'secret-key' };
  for (const p of ['/api/stats-all', '/api/feedback/list', '/api/geo-stats', '/api/parse-history']) {
    const r = await call(p, { headers: { Authorization: 'Bearer secret-key' } }, env);
    assert.equal(r.status, 403, p);
  }
  const login = (key, ip) => call('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ key }) }, env);
  for (let i = 0; i < 10; i++) assert.equal((await login('bad' + i, '2001:db8:5:5::' + (i + 1))).status, 403);
  const locked = await login('secret-key', '2001:db8:5:5::ff');
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('Set-Cookie'), null);
  const legacy = await call('/admin?key=secret-key', { headers: { 'cf-connecting-ip': '2001:db8:5:5::fe' } }, env);
  assert.equal(legacy.headers.get('Set-Cookie'), null);
  assert.equal((await login('secret-key', '2001:db8:5:6::1')).status, 200, 'other /64 unaffected');
});
