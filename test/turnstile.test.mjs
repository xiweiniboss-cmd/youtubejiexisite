import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, {
  HUMAN_PASS_COOKIE, HUMAN_PASS_TTL_SECS, HUMAN_PASS_MAX_AGE_SECS, HUMAN_PATHS,
  HUMAN_PASS_REFRESH_NEAR_CAP_SECS, MERGE_JOB_ID_RE,
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
      if (opts.timeoutOnVerify) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (opts.verifyStatus) return new Response('upstream error', { status: opts.verifyStatus });
      const tok = body.get('response');
      const ok = body.get('secret') === SECRET && left.delete(tok);
      return new Response(JSON.stringify(ok ? { success: true, hostname: 'youtubejiexisite.pages.dev' } : { success: false, 'error-codes': ['timeout-or-duplicate'] }), { headers: { 'Content-Type': 'application/json' } });
    }
    calls.other.push(u);
    if (opts.other) return opts.other(u, init);
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

test('turnstile: siteverify failure -> 403 HUMAN_FAILED; unreachable/timeout/non-2xx -> 503 HUMAN_UNAVAILABLE', async () => {
  const bad = fakeFetch([]);
  await withFetch(bad.fn, async () => {
    const r = await call(PARSE + '&turnstile=wrong');
    assert.equal(r.resp.status, 403);
    assert.equal(r.body.error, '人机验证未通过，请重试');
    assert.equal(r.setCookie, '');
  });
  // siteverify 连不上 / 超时 / 非 2xx：不是用户的错 → 503 HUMAN_UNAVAILABLE（前端提示稍后再试并重置组件）
  for (const opts of [{ throwOnVerify: true }, { timeoutOnVerify: true }, { verifyStatus: 502 }, { verifyStatus: 429 }]) {
    const down = fakeFetch(['tok'], opts);
    await withFetch(down.fn, async () => {
      const r = await call(PARSE + '&turnstile=tok');
      assert.equal(r.resp.status, 503, JSON.stringify(opts));
      assert.equal(r.body.code, 'HUMAN_UNAVAILABLE');
      assert.equal(r.body.error, '验证服务暂时连不上，请稍后再试');
      assert.equal(r.setCookie, '');
      assert.equal(down.calls.other.length, 0, 'handler not reached');
    });
  }
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
    assert.deepEqual((await call('/api/turnstile-key', env)).body, { ok: true, siteKey: '0x4AAAA-public', required: true, attach: false });
    assert.deepEqual((await call('/api/turnstile-key', {})).body, { ok: true, siteKey: '', required: false, attach: false });
    assert.notEqual((await call('/api/server-status', env)).resp.status, 403);
    assert.notEqual((await call('/api/queue', env)).resp.status, 403);
    const st = await call('/api/yt1080-status?id=job-0001', env);
    assert.equal(st.resp.status, 500); // 没配 YT_MERGE_TOKEN，但不是 403
    assert.equal((await call('/api/yt1080-file?id=job-0001', env)).resp.status, 500);
    assert.equal(f.calls.siteverify.length, 0);
  });
});

// ---- 前端：通行证有效期内不要新 token；用过的 token 一律重置；HUMAN_* 拒绝后清零 ----
function frontendHuman() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const i = html.indexOf('  var TS_PASS_MS');
  // 解析区组件改成点「开始解析」才加载：渲染代码包在 initParseTs() 里
  const j = html.indexOf('  var _tsInitP = null;');
  assert.ok(i > 0 && j > i);
  const k = html.indexOf('  var TS_MSG_LOADING');
  const l = html.indexOf('  function tsSetState');
  assert.ok(k > 0 && l > k);
  const ctx = { resets: 0, token: '', now: 1000, Date: { now: () => ctx.now } };
  ctx.turnstile = { reset() { ctx.resets++; ctx.token = ''; }, getResponse() { return ctx.token; } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(k, l) + '\nvar tsParseWidgetId = null;\n' + html.slice(i, j), ctx);
  return { html, ctx, run: (c) => vm.runInContext(c, ctx) };
}

test('index.html: widget sits right under 开始解析 and both parse and server-merge send the token', () => {
  const { html } = frontendHuman();
  assert.match(html, /id="parseBtn">开始解析<\/button>\n\s*<!--[^\n]*-->\n\s*<div id="tsParseWidget"/);
  assert.equal((html.match(/id="tsParseWidget"/g) || []).length, 1);
  assert.match(html, /var hq = humanQuery\(\);\n\s*if \(hq === null\) \{ showError\(tsNeedMsg\(\)\); return; \}/);
  assert.match(html, /if \(hq === null\) \{ status\(tsNeedMsg\(\)\); return; \}/);
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
  // 服务器有通行证、没用这个 token（无 X-Human-Token: used）→ 不 reset，token 留着下次再带
  assert.equal(run('humanDone("&turnstile=abc", { ok: true }, false)'), false);
  assert.equal(ctx.resets, 0, 'unused token is kept');
  assert.equal(run('humanQuery()'), '&turnstile=abc', 'token is always sent while the widget has one');
  assert.equal(run('humanDone("&turnstile=abc", { ok: true }, true)'), false);
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

test('index.html: tsNeedMsg — rejected / load failed / plain need-verify', () => {
  const { run } = frontendHuman();
  run('tsState = "rejected"');
  assert.equal(run('tsNeedMsg()'), '人机验证未通过，请刷新页面重试');
  run('tsState = "failed"');
  assert.equal(run('tsNeedMsg()'), '人机验证组件加载失败，请检查网络或 VPN 后刷新');
  run('tsState = "ready"');
  assert.equal(run('tsNeedMsg()'), '请先完成人机验证');
  run('tsState = "rejected"');
  assert.equal(run('humanMsg({ code: "HUMAN_REQUIRED" })'), '人机验证未通过，请刷新页面重试');
});

test('index.html: humanMsg distinguishes load failure / still loading / expired pass / server text', () => {
  const { run } = frontendHuman();
  const LOAD_FAIL = '人机验证组件加载失败，请检查网络或 VPN 后刷新';
  // 组件没出来（脚本挂了 / site key 缺失 / 8 秒没渲染）
  run('tsState = "failed"; tsParseWidgetId = null');
  assert.equal(run('humanMsg({ code: "HUMAN_REQUIRED", error: "请先完成人机验证" })'), LOAD_FAIL);
  run('tsState = "idle"');
  assert.equal(run('humanMsg({ code: "HUMAN_REQUIRED" })'), LOAD_FAIL);
  run('tsState = "loading"');
  assert.match(run('humanMsg({ code: "HUMAN_REQUIRED" })'), /^人机验证加载中…/);
  // 组件好好的：旧结果的下载 / 合并因为通行证过期被拦
  run('tsState = "ready"; tsParseWidgetId = 1');
  assert.equal(run('humanMsg({ code: "HUMAN_REQUIRED" })'), '验证已过期，请重新点开始解析');
  assert.equal(run('humanMsg({ code: "HUMAN_UNAVAILABLE", error: "验证服务暂时连不上，请稍后再试" })'), '验证服务暂时连不上，请稍后再试');
  assert.equal(run('humanMsg({ code: "HUMAN_FAILED", error: "人机验证未通过，请重试" })'), '人机验证未通过，请重试');
  // HUMAN_UNAVAILABLE 也算拒绝 → 重置组件
  run('resets = 0');
  assert.equal(run('humanDone("&turnstile=x", { ok: false, code: "HUMAN_UNAVAILABLE" }, false)'), true);
  assert.equal(run('resets'), 1);
});

test('index.html: load-state UI strings, 8s timeout, compact widget centered, download errors use humanMsg', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="tsParseWidget" class="ts-parse"><\/div>\n\s*<div id="tsParseState"/);
  assert.match(html, /var TS_RENDER_TIMEOUT_MS = 8000;/);
  assert.match(html, /\.ts-parse\.ts-compact\{ display:flex; justify-content:center; \}/);
  assert.match(html, /if \(compact\) box\.className \+= ' ts-compact';/);
  assert.ok(!/\}\)\.catch\(function\(\)\{\}\);\n\n\s*\/\* 反馈表单/.test(html), 'widget load failure is no longer swallowed');
  assert.match(html, /if \(humanDone\('', e\)\) \{ showError\('下载失败：' \+ humanMsg\(e\)\); return; \}/);
  assert.match(html, /if \(humanDone\('', e\)\) \{ showError\('合并下载失败：' \+ humanMsg\(e\)\); return; \}/);
  assert.match(html, /status\(humanMsg\(j\)\)/);
  const ym = readFileSync(new URL('../ytmerge.js', import.meta.url), 'utf8');
  assert.match(ym, /if \(code\) e2\.code = code;/, 'chunked downloads keep the HUMAN_* code');
});

// ---- 合并任务 id 白名单 ----
test('yt1080-status / yt1080-file: bad job ids -> 400 Chinese error, EC2 never contacted', async () => {
  const f = fakeFetch([], { other: () => new Response(JSON.stringify({ ok: true, status: 'running' }), { headers: { 'content-type': 'application/json' } }) });
  const env = { ...ENV, YT_MERGE_TOKEN: 'merge-token-not-echoed', YT_MERGE_BASE: 'https://merge.example.com' };
  const bad = ['', '.', '..', '%2e', '%2e%2e', '%252e%252e', 'abc', 'abcde', 'a'.repeat(65), 'job/../x', 'job%2F..%2Fx', 'job.0001', 'job 0001', 'jöb-0001', 'job-0001%00'];
  await withFetch(f.fn, async () => {
    for (const p of ['/api/yt1080-status', '/api/yt1080-file']) {
      for (const id of bad) {
        const r = await call(p + '?id=' + id, env);
        assert.equal(r.resp.status, 400, p + ' id=' + JSON.stringify(id));
        assert.equal(r.body.ok, false);
        assert.equal(r.body.code, 'BAD_JOB_ID');
        assert.match(r.body.error, /任务编号/);
        assert.ok(!r.text.includes('merge-token-not-echoed'));
      }
      const noParam = await call(p, env);
      assert.equal(noParam.resp.status, 400);
    }
    assert.equal(f.calls.other.length, 0, 'EC2 not contacted for any bad id');
    // 合法 id（6 位、64 位、带 _ -）照常转发
    for (const id of ['abc123', 'a'.repeat(64), 'Job_ID-0001']) {
      const r = await call('/api/yt1080-status?id=' + id, env);
      assert.equal(r.resp.status, 200, id);
    }
    assert.equal(f.calls.other.length, 3);
    assert.ok(f.calls.other.every((u) => u.startsWith('https://merge.example.com/yt1080-jobs/')));
  });
  assert.ok(MERGE_JOB_ID_RE.test('abc123') && !MERGE_JOB_ID_RE.test('..'));
});

// ---- secret 配了但 site key 缺失：每个路径只 console.error 一次，不泄露值 ----
test('turnstile: secret set but site key missing -> console.error once per path, no key values logged', async () => {
  const f = fakeFetch();
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  _resetHumanWarn();
  try {
    await withFetch(f.fn, async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await call(PARSE)).body.code, 'HUMAN_REQUIRED');
        assert.equal((await call('/api/ytdl?url=x')).body.code, 'HUMAN_REQUIRED');
      }
      // 配了 site key 就不报
      await call('/api/yt-hd?url=x', { ...ENV, TURNSTILE_SITE_KEY: '0x4AAAA-public' });
    });
  } finally { console.error = origErr; _resetHumanWarn(); }
  assert.equal(errs.length, 2, errs.join('\n'));
  assert.match(errs[0], /TURNSTILE_SITE_KEY/);
  assert.match(errs[0], /\/api\/parse/);
  assert.match(errs[1], /\/api\/ytdl/);
  assert.ok(errs.every((e) => !e.includes(SECRET)));
});

// ---- 通行证接近 2 小时封顶 + 带了新 token：真验一次并换全新通行证；平常路径不调 siteverify ----
test('turnstile: valid pass + token, far from cap -> siteverify NOT called, token not consumed', async () => {
  const now = Math.floor(Date.now() / 1000);
  const pass = await signHumanPass(SECRET, now, now - 60 * 60); // 首次验证 1 小时前，离封顶还有 1 小时
  const f = fakeFetch(['tok-keep']);
  await withFetch(f.fn, async () => {
    const r = await call(PARSE + '&turnstile=tok-keep', ENV, { cookie: HUMAN_PASS_COOKIE + '=' + pass.value });
    assert.ok(reachedParse(r), r.text);
    assert.equal(f.calls.siteverify.length, 0);
    assert.equal(r.setCookie, '');
    assert.equal(r.resp.headers.get('x-human-token'), null);
    // 没有 token 的常规请求也一样
    const r2 = await call('/api/ytdl?url=notaurl', ENV, { cookie: HUMAN_PASS_COOKIE + '=' + pass.value });
    assert.equal(r2.resp.status, 400);
    assert.equal(f.calls.siteverify.length, 0);
  });
});

test('turnstile: valid pass near 2h cap + fresh token -> siteverify once, brand-new pass with new first-verify time', async () => {
  const now = Math.floor(Date.now() / 1000);
  const first = now - HUMAN_PASS_MAX_AGE_SECS + 10 * 60; // 离封顶只剩 10 分钟（< 15 分钟）
  const pass = await signHumanPass(SECRET, now - 5 * 60, first);
  const before = await verifyHumanPass(pass.value, SECRET, now);
  assert.ok(before && before.first === first);
  assert.ok(HUMAN_PASS_REFRESH_NEAR_CAP_SECS >= 10 * 60);
  const f = fakeFetch(['tok-new']);
  await withFetch(f.fn, async () => {
    // 没 token：照常凭旧通行证放行，不调 siteverify
    const plain = await call(PARSE, ENV, { cookie: HUMAN_PASS_COOKIE + '=' + pass.value });
    assert.ok(reachedParse(plain));
    assert.equal(f.calls.siteverify.length, 0);
    // 带 token：真验一次，换全新通行证
    const r = await call(PARSE + '&turnstile=tok-new', ENV, { cookie: HUMAN_PASS_COOKIE + '=' + pass.value });
    assert.ok(reachedParse(r), r.text);
    assert.equal(f.calls.siteverify.length, 1);
    assert.equal(r.resp.headers.get('x-human-token'), 'used');
    const fresh = await verifyHumanPass(passOf(r.setCookie), SECRET);
    assert.ok(fresh);
    assert.ok(fresh.first >= now, 'first-verify time restarted');
    assert.ok(fresh.exp > before.exp);
    assert.match(r.setCookie, new RegExp('Max-Age=' + HUMAN_PASS_TTL_SECS + '\\b'));
  });
});

test('turnstile: near cap with a bad token or siteverify down -> old pass still honoured, no new first-verify time', async () => {
  const now = Math.floor(Date.now() / 1000);
  const first = now - HUMAN_PASS_MAX_AGE_SECS + 10 * 60;
  const pass = await signHumanPass(SECRET, now - 25 * 60, first); // 剩 5 分钟 → 也会滑动续期（但不超过封顶）
  for (const opts of [{}, { throwOnVerify: true }]) {
    const f = fakeFetch([], opts);
    await withFetch(f.fn, async () => {
      const r = await call(PARSE + '&turnstile=bad', ENV, { cookie: HUMAN_PASS_COOKIE + '=' + pass.value });
      assert.ok(reachedParse(r), r.text);
      assert.equal(f.calls.siteverify.length, 1);
      assert.equal(r.resp.headers.get('x-human-token'), 'used');
      const renewed = await verifyHumanPass(passOf(r.setCookie), SECRET);
      assert.ok(renewed);
      assert.equal(renewed.first, first, 'cap unchanged');
      assert.ok(renewed.exp <= first + HUMAN_PASS_MAX_AGE_SECS);
    });
  }
});
