import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, {
  HUMAN_PASS_COOKIE, HUMAN_PASS_TTL_SECS, HUMAN_PASS_MAX_AGE_SECS, HUMAN_PATHS,
  signHumanPass, verifyHumanPass, _resetHumanWarn,
} from '../_worker.js';

const SECRET = 'test-turnstile-secret-DO-NOT-ECHO';
const SV = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ENV = { TURNSTILE_SECRET_KEY: ' ' + SECRET + ' ' };

// siteverify 假服务：goodTokens 里的 token 只能用一次（模拟 Turnstile 的单次有效）
function fakeFetch(goodTokens = [], opts = {}) {
  const calls = { siteverify: [], other: [] };
  const left = new Set(goodTokens);
  const fn = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u === SV) {
      const body = new URLSearchParams(String(init.body));
      calls.siteverify.push(Object.fromEntries(body));
      if (opts.throwOnVerify) throw new Error('network down');
      const tok = body.get('response');
      const ok = body.get('secret') === SECRET && left.delete(tok);
      return new Response(JSON.stringify(ok ? { success: true, hostname: 'youtubejiexisite.pages.dev' } : { success: false, 'error-codes': ['timeout-or-duplicate'] }), { headers: { 'Content-Type': 'application/json' } });
    }
    calls.other.push(u);
    return new Response('{}', { status: 599 });
  };
  return { fn, calls };
}
async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
async function call(path, env = ENV, { cookie, ip = '203.0.113.7', method = 'GET' } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (cookie) headers.cookie = cookie;
  const resp = await worker.fetch(new Request('https://youtubejiexisite.pages.dev' + path, { method, headers }), env, { waitUntil() {} });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { resp, text, body, setCookie: resp.headers.get('set-cookie') || '' };
}
const passOf = (setCookie) => (new RegExp(HUMAN_PASS_COOKIE + '=([^;]+)').exec(setCookie) || [])[1] || '';
const PARSE = '/api/parse?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ');
// 不配 REDFOX_API_KEY 时 parse 会回「未配置 RedFoxHub API Key」500 —— 用它判断「已经过了门禁、进了解析逻辑」
const reachedParse = (r) => r.resp.status === 500 && /RedFoxHub/.test(r.body.error);

test('turnstile: gated path list is exactly the parse entry points', () => {
  assert.deepEqual([...HUMAN_PATHS].sort(), ['/api/parse', '/api/yt-direct', '/api/yt-hd', '/api/yt1080-start', '/api/ytdl']);
});

test('turnstile: missing token -> 403 with Chinese error, siteverify not called, handler not reached', async () => {
  const f = fakeFetch();
  await withFetch(f.fn, async () => {
    const r = await call(PARSE);
    assert.equal(r.resp.status, 403);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'HUMAN_REQUIRED');
    assert.equal(r.body.error, '请先完成人机验证');
    assert.equal(r.setCookie, '');
    assert.equal(f.calls.siteverify.length, 0);
    assert.ok(!r.text.includes(SECRET));
  });
});

test('turnstile: siteverify success -> allowed, signed pass cookie issued, remoteip forwarded, secret not echoed', async () => {
  const f = fakeFetch(['tok-1']);
  await withFetch(f.fn, async () => {
    const r = await call(PARSE + '&turnstile=tok-1');
    assert.ok(reachedParse(r), r.text);
    assert.equal(f.calls.siteverify.length, 1);
    assert.deepEqual(f.calls.siteverify[0], { secret: SECRET, response: 'tok-1', remoteip: '203.0.113.7' });
    assert.match(r.setCookie, new RegExp('^' + HUMAN_PASS_COOKIE + '=v1\\.'));
    assert.match(r.setCookie, /Path=\/api\//);
    assert.match(r.setCookie, new RegExp('Max-Age=' + HUMAN_PASS_TTL_SECS + '\\b'));
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /Secure/);
    assert.match(r.setCookie, /SameSite=Lax/);
    assert.ok(!r.setCookie.includes(SECRET) && !r.text.includes(SECRET));
    assert.ok(await verifyHumanPass(passOf(r.setCookie), SECRET));
  });
});

test('turnstile: pass reuse -> second parse, yt-hd, ytdl, yt1080-start all allowed without a new token or siteverify', async () => {
  const f = fakeFetch(['tok-1']);
  await withFetch(f.fn, async () => {
    const first = await call(PARSE + '&turnstile=tok-1');
    const cookie = HUMAN_PASS_COOKIE + '=' + passOf(first.setCookie);
    // 第二次解析：token 已经用过（单次有效），但凭通行证放行
    const second = await call(PARSE, ENV, { cookie: 'other=1; ' + cookie });
    assert.ok(reachedParse(second), second.text);
    assert.equal(second.setCookie, '', 'fresh pass is not re-issued on every call');
    // 后续接口：都过了门禁（报的是各自的参数 / 配置错误，不是 403）
    const dl = await call('/api/ytdl?url=notaurl', ENV, { cookie });
    assert.equal(dl.resp.status, 400);
    assert.equal(dl.body.error, '无效的下载地址');
    const merge = await call('/api/yt1080-start?url=https%3A%2F%2Fyoutu.be%2Fabc', ENV, { cookie, method: 'POST' });
    assert.equal(merge.resp.status, 500);
    assert.match(merge.body.error, /YT_MERGE_TOKEN/);
    const hd = await call('/api/yt-hd?url=nope', ENV, { cookie });
    assert.notEqual(hd.resp.status, 403);
    assert.equal(f.calls.siteverify.length, 1);
  });
});

test('turnstile: second parse replaying the single-use token without a pass is rejected (widget must be reset)', async () => {
  const f = fakeFetch(['tok-1', 'tok-2']);
  await withFetch(f.fn, async () => {
    assert.ok(reachedParse(await call(PARSE + '&turnstile=tok-1')));
    const replay = await call(PARSE + '&turnstile=tok-1');
    assert.equal(replay.resp.status, 403);
    assert.equal(replay.body.code, 'HUMAN_FAILED');
    assert.equal(replay.body.error, '人机验证未通过，请重试');
    // 重置组件后拿到的新 token 可以
    assert.ok(reachedParse(await call(PARSE + '&turnstile=tok-2')));
  });
});

test('turnstile: yt-hd / ytdl / yt1080-start / yt-direct without a pass -> 403, nothing upstream is called', async () => {
  const f = fakeFetch();
  await withFetch(f.fn, async () => {
    for (const p of ['/api/yt-hd?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ', '/api/ytdl?v=dQw4w9WgXcQ&itag=137',
      '/api/ytdl?url=https%3A%2F%2Frr1---sn.googlevideo.com%2Fvideoplayback', '/api/yt1080-start?url=https%3A%2F%2Fyoutu.be%2Fabc',
      '/api/yt-direct?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ']) {
      const r = await call(p, { ...ENV, YT_MERGE_TOKEN: 'm', REDFOX_API_KEY: 'k' }, { method: p.includes('1080') ? 'POST' : 'GET' });
      assert.equal(r.resp.status, 403, p);
      assert.equal(r.body.code, 'HUMAN_REQUIRED', p);
      assert.equal(r.body.error, '请先完成人机验证');
    }
    assert.equal(f.calls.other.length, 0);
    assert.equal(f.calls.siteverify.length, 0);
  });
});

test('turnstile: expired, forged, foreign-secret and over-cap passes are rejected', async () => {
  const f = fakeFetch();
  const now = Math.floor(Date.now() / 1000);
  const expired = await signHumanPass(SECRET, now - HUMAN_PASS_TTL_SECS - 5);
  const foreign = await signHumanPass('another-secret', now);
  const good = await signHumanPass(SECRET, now);
  const [v, exp, first, nonce, sig] = good.value.split('.');
  const bumped = [v, String(+exp + 86400), first, nonce, sig].join('.');
  const flipped = [v, exp, first, nonce, (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)].join('.');
  assert.equal(await verifyHumanPass(expired.value, SECRET), null);
  assert.equal(await verifyHumanPass(foreign.value, SECRET), null);
  assert.equal(await verifyHumanPass(bumped, SECRET), null);
  assert.equal(await verifyHumanPass(flipped, SECRET), null);
  assert.equal(await verifyHumanPass('v1.9999999999.1.x.' + sig, SECRET), null);
  assert.equal(await verifyHumanPass('garbage', SECRET), null);
  assert.equal(await verifyHumanPass('', SECRET), null);
  assert.ok(await verifyHumanPass(good.value, SECRET));
  // 续期封顶：首次验证 2 小时后再签也不会超过上限
  const capped = await signHumanPass(SECRET, now, now - HUMAN_PASS_MAX_AGE_SECS + 60);
  assert.ok(capped.exp - (now - HUMAN_PASS_MAX_AGE_SECS + 60) <= HUMAN_PASS_MAX_AGE_SECS);
  await withFetch(f.fn, async () => {
    for (const bad of [expired.value, foreign.value, bumped, flipped]) {
      const r = await call(PARSE, ENV, { cookie: HUMAN_PASS_COOKIE + '=' + bad });
      assert.equal(r.resp.status, 403);
      assert.equal(r.body.code, 'HUMAN_REQUIRED');
    }
  });
});

test('turnstile: pass close to expiry is renewed (sliding) but keeps the original verify time', async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = await signHumanPass(SECRET, now - HUMAN_PASS_TTL_SECS + 120); // 只剩 2 分钟
  const f = fakeFetch();
  await withFetch(f.fn, async () => {
    const r = await call('/api/ytdl?url=notaurl', ENV, { cookie: HUMAN_PASS_COOKIE + '=' + old.value });
    assert.equal(r.resp.status, 400);
    const renewed = await verifyHumanPass(passOf(r.setCookie), SECRET);
    assert.ok(renewed);
    assert.ok(renewed.exp > old.exp);
    assert.equal(renewed.first, (await verifyHumanPass(old.value, SECRET)).first);
  });
});

test('turnstile: siteverify failure or network error -> 403, no pass', async () => {
  const bad = fakeFetch([]);
  await withFetch(bad.fn, async () => {
    const r = await call(PARSE + '&turnstile=wrong');
    assert.equal(r.resp.status, 403);
    assert.equal(r.body.error, '人机验证未通过，请重试');
    assert.equal(r.setCookie, '');
  });
  const down = fakeFetch(['tok'], { throwOnVerify: true });
  await withFetch(down.fn, async () => {
    const r = await call(PARSE + '&turnstile=tok');
    assert.equal(r.resp.status, 403);
    assert.equal(r.body.code, 'HUMAN_FAILED');
  });
  const huge = fakeFetch();
  await withFetch(huge.fn, async () => {
    const r = await call(PARSE + '&turnstile=' + 'x'.repeat(3000));
    assert.equal(r.resp.status, 403);
    assert.equal(huge.calls.siteverify.length, 0);
  });
});

test('turnstile: secret unset -> fail-open with one console warning, no cookie, pass cookies ignored', async () => {
  const f = fakeFetch();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  _resetHumanWarn();
  try {
    await withFetch(f.fn, async () => {
      for (const env of [{}, { TURNSTILE_SECRET_KEY: '   ' }]) {
        const r = await call(PARSE, env);
        assert.ok(reachedParse(r), r.text);
        assert.equal(r.setCookie, '');
        const dl = await call('/api/ytdl?url=notaurl', env);
        assert.equal(dl.resp.status, 400);
      }
    });
  } finally { console.warn = origWarn; }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /TURNSTILE_SECRET_KEY/);
  assert.equal(f.calls.siteverify.length, 0);
});

test('turnstile: status / ping / stats / key / merge status+file are not gated', async () => {
  const f = fakeFetch();
  await withFetch(f.fn, async () => {
    const env = { ...ENV, TURNSTILE_SITE_KEY: ' 0x4AAAA-public ' };
    assert.equal((await call('/api/ping', env)).resp.status, 200);
    assert.equal((await call('/api/stats', env)).body.ok, true);
    assert.deepEqual((await call('/api/turnstile-key', env)).body, { ok: true, siteKey: '0x4AAAA-public' });
    assert.notEqual((await call('/api/server-status', env)).resp.status, 403);
    const st = await call('/api/yt1080-status?id=x', env);
    assert.equal(st.resp.status, 500); // 没配 YT_MERGE_TOKEN，但不是 403
    assert.equal((await call('/api/yt1080-file?id=x', env)).resp.status, 500);
    assert.equal(f.calls.siteverify.length, 0);
  });
});

// ---- 前端：通行证有效期内不要新 token；用过的 token 一律重置；HUMAN_* 拒绝后清零 ----
function frontendHuman() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const i = html.indexOf('  var TS_PASS_MS');
  const j = html.indexOf('  ensureTurnstileScript().then(function(siteKey){\n    try {\n      var box');
  assert.ok(i > 0 && j > i);
  const ctx = { resets: 0, token: '', now: 1000, Date: { now: () => ctx.now } };
  ctx.turnstile = { reset() { ctx.resets++; ctx.token = ''; }, getResponse() { return ctx.token; } };
  vm.createContext(ctx);
  vm.runInContext('var tsParseWidgetId = null;\n' + html.slice(i, j), ctx);
  return { html, ctx, run: (c) => vm.runInContext(c, ctx) };
}

test('index.html: widget sits right under 开始解析 and both parse and server-merge send the token', () => {
  const { html } = frontendHuman();
  assert.match(html, /id="parseBtn">开始解析<\/button>\n\s*<!--[^\n]*-->\n\s*<div id="tsParseWidget"/);
  assert.equal((html.match(/id="tsParseWidget"/g) || []).length, 1);
  assert.match(html, /var hq = humanQuery\(\);\n\s*if \(hq === null\) \{ showError\('请先完成人机验证'\); return; \}/);
  assert.match(html, /'\/api\/yt1080-start\?url=[^\n]+\+ hq, \{ method: 'POST' \}/);
  assert.match(html, /'expired-callback'/);
  assert.match(html, /language: 'zh-cn'/);
});

test('index.html: humanQuery / humanDone lifecycle (second parse works, rejection resets)', () => {
  const { ctx, run } = frontendHuman();
  assert.equal(run('humanQuery()'), '', 'no site key -> no token needed');
  run('tsParseWidgetId = 1');
  assert.equal(run('humanQuery()'), null, 'widget not solved yet');
  ctx.token = 'abc';
  const q = run('humanQuery()');
  assert.equal(q, '&turnstile=abc');
  assert.equal(run('humanDone("&turnstile=abc", { ok: true })'), false);
  assert.equal(ctx.resets, 1, 'used token is reset');
  assert.equal(run('humanQuery()'), '', 'second parse rides on the pass');
  ctx.now += 26 * 60 * 1000;
  assert.equal(run('humanQuery()'), null, 'local pass expired -> needs widget again');
  ctx.now = 2000;
  run('tsPassUntil = 10 ** 12');
  assert.equal(run('humanDone("", { ok: false, code: "HUMAN_REQUIRED" })'), true);
  assert.equal(ctx.resets, 2);
  assert.equal(run('humanQuery()'), null);
});
