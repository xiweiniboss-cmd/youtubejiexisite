import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { fetchServerStatus, sanitizeServerStatus, _resetServerStatusCache } from '../_worker.js';

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

test('server-status: unreachable / 530 / 500 / non-JSON -> online:false with HTTP 200', async () => {
  const cases = [
    [async () => { throw new TypeError('connect ECONNREFUSED ' + TOKEN); }, '无法连接服务器'],
    [async () => new Response('error code: 1016', { status: 530 }), '服务器不可达'],
    [async () => new Response('boom', { status: 500 }), '服务器异常（HTTP 500）'],
    [async () => new Response('<html>hi</html>', { status: 200 }), '服务器返回格式异常'],
    [async () => new Response('denied', { status: 403 }), '口令不匹配（HTTP 403）'],
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
  assert.equal(body.ok, true);
  assert.ok(body.t >= before);
});

test('index.html: server status card renders online, 404 and offline states', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /本站已解析 <b id="parseCount">-<\/b> 次<\/p>\n  <\/section>\n\n  <!-- 服务器状态/);
  const script = html.split('<script>').map((s) => s.split('</script>')[0]).find((s) => s.includes("$('srvCard')"));
  assert.ok(script);
  const ids = [...html.matchAll(/id="(srv[A-Za-z]+)"/g)].map((m) => m[1]);
  async function run(statusBody) {
    const els = {};
    for (const id of ids) els[id] = { textContent: '-', innerHTML: '-', className: '', style: { display: '', width: '' } };
    els.srvCard = { style: {} };
    const ctx = {
      document: { hidden: false, getElementById: (id) => els[id] || null, addEventListener() {} },
      window: {},
      Date, Math, Promise, isFinite, String,
      setInterval: () => 1, clearInterval() {},
      fetch: async (url) => ({ ok: true, json: async () => (String(url).startsWith('/api/ping') ? { ok: true, t: 1 } : statusBody) }),
    };
    vm.runInNewContext(script, ctx);
    await new Promise((r) => setTimeout(r, 20));
    return els;
  }
  let e = await run({ ok: true, online: true, statusSupported: true, latencyMs: 42, mem: { total: 4 * GB, used: GB, percent: 25 }, cpu: { load1: 0.5, cores: 2, percent: 25 }, disk: { total: 40 * GB, used: 10 * GB, percent: 25 }, jobs: { running: 1, queued: 0 } });
  assert.equal(e.srvOnline.textContent, '在线');
  assert.equal(e.srvDot.className, 'srv-dot on');
  assert.match(e.srvLat.innerHTML, /^42/);
  assert.match(e.srvPing.innerHTML, /ms/);
  assert.equal(e.srvMemBar.style.width, '25%');
  assert.match(e.srvMem.innerHTML, /25%.*1\.0\/4\.0 GB/);
  assert.equal(e.srvRun.textContent, '1');
  assert.equal(e.srvQueue.textContent, '0');
  e = await run({ ok: true, online: true, statusSupported: false, latencyMs: 30 });
  assert.equal(e.srvBars.style.display, 'none');
  assert.equal(e.srvNote.textContent, '服务器暂未提供详细状态');
  e = await run({ ok: true, online: false, latencyMs: null, error: '连接超时' });
  assert.equal(e.srvOnline.textContent, '离线');
  assert.equal(e.srvDot.className, 'srv-dot off');
  assert.equal(e.srvLat.textContent, '-');
  assert.equal(e.srvMem.textContent, '-');
});
