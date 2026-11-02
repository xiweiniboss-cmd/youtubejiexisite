import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { fetchServerStatus, sanitizeServerStatus, _resetServerStatusCache, SERVER_STATUS_MAX_BODY } from '../_worker.js';

const TOKEN = 'merge-token-SECRET-123';
const GB = 1073741824;
const FULL = {
  ok: true,
  mem: { total: 4 * GB, used: 1 * GB },
  cpu: { load1: 1.5, load5: 0.8, load15: 0.5, cores: 2 },
  disk: { total: 40 * GB, used: 10 * GB },
  uptimeSec: 3600.7,
  jobs: { running: 1, queued: 3 },
  secretEcho: TOKEN,
};

async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  _resetServerStatusCache();
  try { return await fn(); } finally { globalThis.fetch = orig; _resetServerStatusCache(); }
}
async function callRoute(env, path = '/api/server-status') {
  const resp = await worker.fetch(new Request('https://yt.example.com' + path), env, { waitUntil() {} });
  const text = await resp.text();
  return { resp, text, body: JSON.parse(text) };
}

test('server-status: online with full data, token sent as X-Merge-Token, percents computed', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init && init.headers) });
    return new Response(JSON.stringify(FULL), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async () => {
    const { resp, text, body } = await callRoute({ YT_MERGE_TOKEN: ' ' + TOKEN + ' ', YT_MERGE_BASE: 'http://ec2.example:30002/' });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('Cache-Control'), /max-age=15/);
    assert.equal(resp.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ec2.example:30002/status');
    assert.equal(calls[0].headers.get('X-Merge-Token'), TOKEN);
    assert.equal(body.ok, true);
    assert.equal(body.online, true);
    assert.equal(body.statusSupported, true);
    assert.equal(typeof body.latencyMs, 'number');
    assert.deepEqual(body.mem, { total: 4 * GB, used: GB, percent: 25 });
    assert.deepEqual(body.cpu, { load1: 1.5, load5: 0.8, load15: 0.5, cores: 2, percent: 75 });
    assert.deepEqual(body.disk, { total: 40 * GB, used: 10 * GB, percent: 25 });
    assert.equal(body.uptimeSec, 3600);
    assert.deepEqual(body.jobs, { running: 1, queued: 3 });
    assert.equal(typeof body.checkedAt, 'number');
    assert.equal(body.secretEcho, undefined);
    assert.ok(!text.includes(TOKEN));
    // 15 秒内第二次请求走缓存，不再打 EC2
    await callRoute({ YT_MERGE_TOKEN: TOKEN, YT_MERGE_BASE: 'http://ec2.example:30002/' });
    assert.equal(calls.length, 1);
  });
});

test('server-status: sanitize caps cpu at 100 and drops non-numbers', () => {
  const s = sanitizeServerStatus({ mem: { total: 'abc', used: -1 }, cpu: { load1: 9, cores: 2 }, disk: { total: '100', used: '50' }, jobs: { running: '2', queued: null } });
  assert.equal(s.cpu.percent, 100);
  assert.deepEqual(s.mem, { total: null, used: null, percent: null });
  assert.equal(s.disk.percent, 50);
  assert.deepEqual(s.jobs, { running: 2, queued: null });
  assert.equal(s.uptimeSec, null);
});

test('server-status: EC2 404 (old server) -> online, statusSupported:false', async () => {
  await withFetch(async () => new Response('Not Found', { status: 404 }), async () => {
    const { resp, body, text } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(resp.status, 200);
    assert.equal(body.online, true);
    assert.equal(body.statusSupported, false);
    assert.equal(typeof body.latencyMs, 'number');
    assert.equal(body.mem, undefined);
    assert.ok(!text.includes(TOKEN));
  });
});

test('server-status: timeout -> online:false, latencyMs:null, Chinese error', async () => {
  await withFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  }), async () => {
    const t0 = Date.now();
    const body = await fetchServerStatus({ YT_MERGE_TOKEN: TOKEN }, { timeoutMs: 50 });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(body.ok, true);
    assert.equal(body.online, false);
    assert.equal(body.latencyMs, null);
    assert.equal(body.error, '连接超时');
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  });
});

test('server-status: unreachable / 530 / non-JSON / other status -> online:false with HTTP 200', async () => {
  const cases = [
    [async () => { throw new TypeError('connect ECONNREFUSED ' + TOKEN); }, '无法连接服务器'],
    [async () => new Response('error code: 1016', { status: 530 }), '服务器不可达'],
    [async () => new Response('<html>hi</html>', { status: 200 }), '服务器返回格式异常'],
    [async () => new Response('moved', { status: 302, headers: { Location: '/x' } }), '服务器异常（HTTP 302）'],
  ];
  for (const [fake, msg] of cases) {
    await withFetch(fake, async () => {
      const { resp, body, text } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
      assert.equal(resp.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.online, false);
      assert.equal(body.latencyMs, null);
      assert.equal(body.error, msg);
      assert.ok(!text.includes(TOKEN));
    });
  }
});

test('server-status: no YT_MERGE_TOKEN -> online:false 未配置合并服务, EC2 never called', async () => {
  let called = 0;
  await withFetch(async () => { called++; return new Response('{}'); }, async () => {
    const { resp, body } = await callRoute({ YT_MERGE_TOKEN: '   ' });
    assert.equal(resp.status, 200);
    assert.equal(body.online, false);
    assert.equal(body.latencyMs, null);
    assert.equal(body.error, '未配置合并服务');
    assert.equal(called, 0);
  });
});

test('api/ping returns ok + timestamp with no-store', async () => {
  const before = Date.now();
  const { resp, body } = await callRoute({}, '/api/ping');
  assert.equal(resp.headers.get('Cache-Control'), 'no-store');
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(body.ok, true);
  assert.ok(body.t >= before);
});

test('server-status: EC2 401/403 -> online:true, authFailed:true, no stats', async () => {
  for (const st of [401, 403]) {
    await withFetch(async () => new Response('denied ' + TOKEN, { status: st }), async () => {
      const { resp, body, text } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
      assert.equal(resp.status, 200);
      assert.equal(body.online, true);
      assert.equal(body.authFailed, true);
      assert.equal(typeof body.latencyMs, 'number');
      assert.equal(body.mem, undefined);
      assert.equal(body.jobs, undefined);
      assert.equal(body.error, '状态鉴权失败（HTTP ' + st + '）');
      assert.ok(!text.includes(TOKEN));
    });
  }
});

test('server-status: non-gateway 5xx (500/501/503/505/519/531/599) -> online:true, degraded:true', async () => {
  for (const st of [500, 501, 503, 505, 519, 531, 599]) {
    await withFetch(async () => new Response('boom ' + TOKEN, { status: st, headers: { server: 'nginx' } }), async () => {
      const { body, text } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
      assert.equal(body.online, true, 'HTTP ' + st);
      assert.equal(body.degraded, true, 'HTTP ' + st);
      assert.equal(body.error, '服务器异常（HTTP ' + st + '）');
      assert.equal(body.cpu, undefined);
      assert.ok(!text.includes(TOKEN));
    });
  }
});

test('server-status: gateway 5xx (502/504/520-530) -> online:false 服务器不可达', async () => {
  const codes = [502, 504];
  for (let c = 520; c <= 530; c++) codes.push(c);
  for (const st of codes) {
    await withFetch(async () => new Response('gateway ' + TOKEN, { status: st }), async () => {
      const { body, text } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
      assert.equal(body.online, false, 'HTTP ' + st);
      assert.equal(body.degraded, undefined, 'HTTP ' + st);
      assert.equal(body.error, '服务器不可达');
      assert.ok(!text.includes(TOKEN));
    });
  }
  // 1016 错误页不管状态码都算离线
  await withFetch(async () => new Response('<h1>Error 1016</h1> Origin DNS error', { status: 500 }), async () => {
    const { body } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(body.online, false);
    assert.equal(body.error, '服务器不可达');
  });
});

test('server-status: any 5xx with `server: cloudflare` -> offline; non-5xx with that header unaffected', async () => {
  for (const st of [500, 503, 505, 599]) {
    await withFetch(async () => new Response('cf error page', { status: st, headers: { Server: 'cloudflare' } }), async () => {
      const { body } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
      assert.equal(body.online, false, 'HTTP ' + st);
      assert.equal(body.error, '服务器不可达');
    });
  }
  await withFetch(async () => new Response('nope', { status: 403, headers: { server: 'cloudflare' } }), async () => {
    const { body } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(body.online, true);
    assert.equal(body.authFailed, true);
  });
  await withFetch(async () => new Response(JSON.stringify(FULL), { status: 200, headers: { server: 'cloudflare' } }), async () => {
    const { body } = await callRoute({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(body.online, true);
    assert.equal(body.statusSupported, true);
  });
});

test('server-status: single-flight — 50 concurrent requests share one EC2 fetch (EC2 delayed 300ms)', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 300));
    return new Response(JSON.stringify(FULL), { status: 200 });
  }, async () => {
    const env = { YT_MERGE_TOKEN: TOKEN, YT_MERGE_BASE: 'http://ec2.single:30002' };
    const results = await Promise.all(Array.from({ length: 50 }, () => callRoute(env)));
    assert.equal(calls, 1);
    for (const r of results) {
      assert.equal(r.resp.status, 200);
      assert.equal(r.body.online, true);
      assert.equal(r.body.cpu.percent, 75);
      assert.ok(!r.text.includes(TOKEN));
    }
    // 缓存窗口内再来一批也不打 EC2
    await Promise.all(Array.from({ length: 10 }, () => callRoute(env)));
    assert.equal(calls, 1);
  });
});

test('server-status: 200 body over 16KB -> online:true degraded (服务器返回内容过大), stream not fully read', async () => {
  let pulled = 0;
  await withFetch(async () => {
    const chunk = new TextEncoder().encode('{"ok":true,"pad":"' + 'x'.repeat(4096));
    const stream = new ReadableStream({
      pull(ctrl) { pulled++; if (pulled > 1000) ctrl.close(); else ctrl.enqueue(chunk); },
    });
    return new Response(stream, { status: 200 });
  }, async () => {
    const body = await fetchServerStatus({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(body.online, true);
    assert.equal(body.degraded, true);
    assert.equal(body.error, '服务器返回内容过大');
    assert.equal(body.mem, undefined);
    assert.ok(pulled < 20, 'pulled ' + pulled);
  });
  // 刚好 16KB 以内的正常 JSON 不受影响
  const padded = JSON.stringify(Object.assign({}, FULL, { pad: 'y'.repeat(SERVER_STATUS_MAX_BODY - 400) }));
  assert.ok(padded.length <= SERVER_STATUS_MAX_BODY);
  await withFetch(async () => new Response(padded, { status: 200 }), async () => {
    const body = await fetchServerStatus({ YT_MERGE_TOKEN: TOKEN });
    assert.equal(body.online, true);
    assert.equal(body.mem.percent, 25);
  });
});

test('index.html: card is collapsed by default; online / auth / 5xx / 404 / offline states; toggle; ping median', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /本站已解析 <b id="parseCount">-<\/b> 次<\/p>\n  <\/section>\n\n  <!-- 服务器状态/);
  assert.match(html, /id="srvDetail" style="display:none"/);
  assert.match(html, /详情 ▾/);
  const script = html.split('<script>').map((x) => x.split('</script>')[0]).find((x) => x.includes("$('srvCard')"));
  assert.ok(script);
  const ids = [...html.matchAll(/id="(srv[A-Za-z0-9]+)"/g)].map((m) => m[1]);
  async function run(statusBody, pingFails = 0) {
    const els = {};
    for (const id of ids) els[id] = { textContent: '-', innerHTML: '-', className: '', style: { display: '', width: '' }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    els.srvDetail.style.display = 'none';
    let pings = 0, clock = 0;
    const ctx = {
      document: { hidden: false, getElementById: (id) => els[id] || null, addEventListener() {} },
      window: { performance: { now: () => clock } },
      performance: { now: () => clock },
      Date, Math, Promise, isFinite, String,
      setInterval: () => 1, clearInterval() {},
      fetch: async (url) => {
        if (String(url).startsWith('/api/ping')) {
          pings++;
          clock += [0, 10, 100, 30][pings] || 0; // 每次 ping 的耗时：10 / 100 / 30
          if (pings <= pingFails) throw new Error('net');
          return { ok: true, json: async () => ({ ok: true, t: 1 }) };
        }
        return { ok: true, json: async () => statusBody };
      },
    };
    vm.runInNewContext(script, ctx);
    await new Promise((r) => setTimeout(r, 20));
    return els;
  }
  const ONLINE = { ok: true, online: true, statusSupported: true, latencyMs: 42, mem: { total: 4 * GB, used: GB, percent: 25 }, cpu: { load1: 0.5, cores: 2, percent: 25 }, disk: { total: 40 * GB, used: 10 * GB, percent: 25 }, jobs: { running: 1, queued: 0 } };
  let e = await run(ONLINE);
  assert.equal(e.srvOnline.textContent, '在线');
  assert.equal(e.srvDot.className, 'srv-dot on');
  assert.equal(e.srvLat.textContent, '42ms');
  assert.equal(e.srvPing.textContent, '30ms'); // 10/100/30 的中位数
  assert.equal(e.srvDetail.style.display, 'none');
  assert.equal(e.srvMemBar.style.width, '25%');
  assert.match(e.srvMem.innerHTML, /25%.*1\.0\/4\.0 GB/);
  assert.equal(e.srvRun.textContent, '1');
  assert.equal(e.srvQueue.textContent, '0');
  e.srvToggle.onclick();
  assert.equal(e.srvDetail.style.display, '');
  assert.equal(e.srvToggle.textContent, '收起 ▴');
  assert.equal(e.srvToggle.attrs['aria-expanded'], 'true');
  e.srvToggle.onclick();
  assert.equal(e.srvDetail.style.display, 'none');
  assert.equal(e.srvToggle.textContent, '详情 ▾');

  // 第 1 次 ping 失败：取剩下两次（100、30）的中位数 65；全失败才是 "-"
  e = await run(ONLINE, 1);
  assert.equal(e.srvPing.textContent, '65ms');
  e = await run(ONLINE, 3);
  assert.equal(e.srvPing.textContent, '-');

  e = await run({ ok: true, online: true, latencyMs: 41, authFailed: true, error: '状态鉴权失败（HTTP 403）' });
  assert.equal(e.srvOnline.textContent, '在线 · 状态鉴权失败');
  assert.equal(e.srvDot.className, 'srv-dot warn');
  assert.equal(e.srvLine.className, 'srv-line long');
  assert.equal(e.srvLat.textContent, '41ms');
  assert.equal(e.srvBars.style.display, 'none');
  assert.equal(e.srvJobs.style.display, 'none');

  e = await run({ ok: true, online: true, latencyMs: 44, degraded: true, error: '服务器异常（HTTP 500）' });
  assert.equal(e.srvOnline.textContent, '在线 · 异常');
  assert.equal(e.srvDot.className, 'srv-dot warn');

  e = await run({ ok: true, online: true, statusSupported: false, latencyMs: 30 });
  assert.equal(e.srvOnline.textContent, '在线 · 无详情');
  assert.equal(e.srvDot.className, 'srv-dot na');
  assert.equal(e.srvBars.style.display, 'none');
  assert.equal(e.srvNote.textContent, '服务器暂未提供详细状态');

  e = await run({ ok: true, online: false, latencyMs: null, error: '连接超时' });
  assert.equal(e.srvOnline.textContent, '离线');
  assert.equal(e.srvDot.className, 'srv-dot off');
  assert.equal(e.srvLat.textContent, '-');
  assert.equal(e.srvMem.textContent, '-');
  assert.equal(e.srvLine.className, 'srv-line');
});
