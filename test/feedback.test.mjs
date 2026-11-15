// 反馈系统修复（2026-11-15）：附件先校验、存储失败回滚、kind/link 分开存、page 只收 http(s)、登录同源 + 按站点锁定、后台删除检查返回
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../_worker.js';
// 本地测试默认不配人机验证密钥：显式声明跳过（生产缺密钥会 fail-closed 503）
{ const _f = worker.fetch.bind(worker); worker.fetch = (r, e, c) => _f(r, { TURNSTILE_DISABLED: '1', ...(e || {}) }, c); }

const ok = () => {};
function mk() {
  const store = new Map(), r2 = new Map();
  const KV = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, String(v)); }, delete: async k => { store.delete(k); }, list: async ({ prefix } = {}) => ({ keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) }) };
  const B = { put: async (k, v, o) => { r2.set(k, o); }, delete: async k => { r2.delete(k); }, get: async () => null };
  return { store, r2, env: { FEEDBACK_KV: KV, FEEDBACK_BUCKET: B, FEEDBACK_ADMIN_KEY: 'adm-secret-123', ASSETS: { fetch: async () => new Response('asset') } } };
}
const H = 'https://site-a.pages.dev';
const call = (path, init, env, host = H) => worker.fetch(new Request(host + path, init), env);
const post = (fd, ip, env) => call('/api/feedback', { method: 'POST', body: fd, headers: { 'cf-connecting-ip': ip } }, env);
const recs = (store) => [...store.entries()].filter(([k]) => k.startsWith('fb_')).map(([, v]) => JSON.parse(v));
const png = (nm = 'a.png') => new File(['x'], nm, { type: 'image/png' });


test('feedback submit: validate all attachments first; storage failure rolls back and returns JSON 500', async () => {
  const of = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no net'); };
  try {
// --- 2. 附件先全部校验，存储失败回滚 ---
{ const t = mk(); const fd = new FormData(); fd.append('message', 'hi'); fd.append('files', png()); fd.append('files', new File(['<svg/>'], 'b.svg', { type: 'image/svg+xml' }));
  const r = await post(fd, '1.1.1.1', t.env); assert.equal(r.status, 400); assert.equal(t.r2.size, 0); assert.equal(recs(t.store).length, 0); ok('第二个附件类型不对：整单 400，一个都没上传'); }
{ const t = mk(); const fd = new FormData(); fd.append('message', 'hi'); for (let i = 0; i < 4; i++) fd.append('files', png('a' + i + '.png'));
  const r = await post(fd, '1.1.1.2', t.env); assert.equal(r.status, 400); assert.equal(t.r2.size, 0); ok('4 个附件：400，没上传'); }
{ const t = mk(); const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.mp4', { type: 'video/mp4' });
  const fd = new FormData(); fd.append('message', 'hi'); fd.append('files', png()); fd.append('files', big);
  const r = await post(fd, '1.1.1.3', t.env); assert.equal(r.status, 400); assert.equal(t.r2.size, 0); ok('第二个附件超 20MB：400，没上传'); }
{ const t = mk(); let c = 0; const realPut = t.env.FEEDBACK_BUCKET.put; t.env.FEEDBACK_BUCKET.put = async (...a) => { if (++c === 2) throw new Error('R2 down'); return realPut(...a); };
  const fd = new FormData(); fd.append('message', 'hi'); fd.append('files', png()); fd.append('files', png('b.png'));
  const r = await post(fd, '1.1.1.4', t.env); assert.equal(r.status, 500); const j = await r.json(); assert.equal(j.error, '存储失败，请稍后重试');
  assert.equal(t.r2.size, 0, '已上传的第一个被删掉'); assert.equal(recs(t.store).length, 0); assert.equal(t.store.has('cool_x'), false); ok('R2 第二个写失败：500 JSON，第一个已上传的被删除，没记录'); }
{ const t = mk(); const kvPut = t.env.FEEDBACK_KV.put; t.env.FEEDBACK_KV.put = async (k, v, o) => { if (k.startsWith('fb_')) throw new Error('KV put() limit exceeded'); return kvPut(k, v, o); };
  const fd = new FormData(); fd.append('message', 'hi'); fd.append('files', png());
  const r = await post(fd, '1.1.1.5', t.env); assert.equal(r.status, 500); assert.equal((await r.json()).code, 'STORAGE_FAILED'); assert.equal(t.r2.size, 0);
  assert.ok(![...t.store.keys()].some(k => k.startsWith('cool_')), '失败不记冷却'); ok('KV 写记录失败：500 JSON，附件回滚，不记冷却'); }
{ const t = mk(); t.env.FEEDBACK_KV.get = async () => { throw new Error('KV read fail'); };
  const fd = new FormData(); fd.append('message', 'hi'); const r = await post(fd, '1.1.1.6', t.env); assert.equal(r.status, 200); ok('KV 读冷却失败：不挡用户，照常提交'); }
{ const t = mk(); const fd = new FormData(); fd.append('message', 'hi'); fd.append('files', png());
  let r = await post(fd, '1.1.1.7', t.env); assert.equal(r.status, 200); assert.equal(t.r2.size, 1); assert.equal(recs(t.store)[0].attachments.length, 1);
  const fd2 = new FormData(); fd2.append('message', 'again'); r = await post(fd2, '1.1.1.7', t.env); assert.equal(r.status, 429); ok('正常提交带附件 200；冷却仍生效 429'); }

  } finally { globalThis.fetch = of; }
});

test('feedback submit: kind/link stored separately, 2000 limit only for user text, legacy ≤3000', async () => {
  const of = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no net'); };
  try {
// --- 3. kind / link 单独存，2000 字只算正文 ---
{ const t = mk(); const fd = new FormData(); fd.append('message', 'x'.repeat(2000)); fd.append('kind', '解析失败'); fd.append('link', 'https://v.example.com/' + 'a'.repeat(900));
  const r = await post(fd, '2.2.2.1', t.env); assert.equal(r.status, 200); const rec = recs(t.store)[0];
  assert.equal(rec.message.length, 2000); assert.equal(rec.kind, '解析失败'); assert.equal(rec.link.length, 800); ok('正文 2000 字 + 类型 + 链接：200，类型 / 链接单独存（链接截到 800）'); }
{ const t = mk(); const fd = new FormData(); fd.append('message', 'x'.repeat(2001)); fd.append('kind', '其他');
  const r = await post(fd, '2.2.2.2', t.env); assert.equal(r.status, 400); ok('新前端正文 2001 字：400'); }
{ const t = mk(); const fd = new FormData(); fd.append('message', '【解析失败】\n' + 'x'.repeat(1990) + '\n\n当前输入：\n' + 'https://v.example.com/' + 'a'.repeat(700));
  const r = await post(fd, '2.2.2.3', t.env); assert.equal(r.status, 200); ok('旧前端拼接内容（约 2700 字）：兼容，200'); }
{ const t = mk(); const fd = new FormData(); fd.append('message', 'x'.repeat(3001));
  const r = await post(fd, '2.2.2.4', t.env); assert.equal(r.status, 400); ok('旧格式超过 3000 字：400'); }
{ const t = mk(); const fd = new FormData(); fd.append('kind', '下载失败');
  const r = await post(fd, '2.2.2.5', t.env); assert.equal(r.status, 200); assert.equal(recs(t.store)[0].message, '（未写具体描述）'); ok('只选类型不写内容：200'); }
{ const t = mk(); const r = await call('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '2.2.2.6' }, body: JSON.stringify({ message: 'json', kind: 'a\nb', link: 'https://x.example/1' }) }, t.env);
  assert.equal(r.status, 200); const rec = recs(t.store)[0]; assert.equal(rec.kind, 'a b'); assert.equal(rec.link, 'https://x.example/1'); ok('JSON 提交也支持 kind / link，类型里的换行被去掉'); }

  } finally { globalThis.fetch = of; }
});

test('feedback submit: page accepts only http/https', async () => {
  const of = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no net'); };
  try {
// --- 5. page 只收 http/https ---
for (const [p, want] of [['javascript:alert(1)', ''], ['data:text/html,x', ''], ['https://ok.example/a', 'https://ok.example/a'], ['http://ok.example/', 'http://ok.example/'], ['not a url', '']]) {
  const t = mk(); const fd = new FormData(); fd.append('message', 'hi'); fd.append('page', p);
  const r = await post(fd, '3.3.3.3', t.env); assert.equal(r.status, 200); assert.equal(recs(t.store)[0].page, want);
}
ok('page：javascript: / data: / 非网址被丢弃，http(s) 保留');

  } finally { globalThis.fetch = of; }
});

test('admin login: JSON only, same-origin only, per-site lockout; legacy ?key= cross-site ignored, ?err= hints', async () => {
  const of = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no net'); };
  try {
// --- 4. 登录：只收 JSON + 同源；失败计数按站点 ---
{ const t = mk(); const L = (init, host) => call('/api/admin/login', { method: 'POST', ...init }, t.env, host);
  let r = await L({ headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '4.4.4.4' }, body: 'key=adm-secret-123' }); assert.equal(r.status, 415);
  r = await L({ headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '4.4.4.4' }, body: '{"key":"adm-secret-123"}' }); assert.equal(r.status, 415);
  ok('登录：表单 / text/plain 一律 415（跨站表单发不了 JSON）');
  r = await L({ headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'cf-connecting-ip': '4.4.4.4' }, body: '{"key":"wrong"}' }); assert.equal(r.status, 403);
  r = await L({ headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'same-site', 'cf-connecting-ip': '4.4.4.4' }, body: '{"key":"wrong"}' }); assert.equal(r.status, 403);
  r = await L({ headers: { 'content-type': 'application/json', Origin: 'https://evil.example', 'cf-connecting-ip': '4.4.4.4' }, body: '{"key":"wrong"}' }); assert.equal(r.status, 403);
  assert.ok(![...t.store.keys()].some(k => k.startsWith('admfail_')), '跨站请求不计失败次数');
  ok('登录：Sec-Fetch-Site 非 same-origin、Origin 不是本站：403，且不计失败次数');
  r = await L({ headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: H, 'cf-connecting-ip': '4.4.4.4' }, body: '{"key":"adm-secret-123"}' }); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie') || '', /jx_admin=/);
  ok('登录：同源 JSON + 正确密码：200 下发 Cookie');
  for (let i = 0; i < 10; i++) { r = await L({ headers: { 'content-type': 'application/json', 'cf-connecting-ip': '4.4.4.5' }, body: '{"key":"wrong"}' }); assert.equal(r.status, 403); }
  r = await L({ headers: { 'content-type': 'application/json', 'cf-connecting-ip': '4.4.4.5' }, body: '{"key":"adm-secret-123"}' }); assert.equal(r.status, 429);
  assert.ok(t.store.has('admfail_site-a.pages.dev_4.4.4.5'));
  r = await L({ headers: { 'content-type': 'application/json', 'cf-connecting-ip': '4.4.4.5' }, body: '{"key":"adm-secret-123"}' }, 'https://site-b.pages.dev'); assert.equal(r.status, 200);
  ok('失败计数键带站点域名：A 站被锁 429，同一 IP 在 B 站照常登录');
  // 旧书签 ?key=
  const G = (q, hdr, host) => call('/admin' + q, { headers: { 'cf-connecting-ip': '4.4.4.6', ...hdr } }, t.env, host);
  r = await G('?key=wrong', { 'Sec-Fetch-Site': 'cross-site' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin?err=cross'); assert.equal(r.headers.get('set-cookie'), null);
  r = await G('?key=adm-secret-123', { 'Sec-Fetch-Site': 'cross-site' }); assert.equal(r.headers.get('location'), '/admin?err=cross'); assert.equal(r.headers.get('set-cookie'), null);
  assert.ok(!t.store.has('admfail_site-a.pages.dev_4.4.4.6')); ok('旧书签 ?key= 跨站带过来：不校验、不计数、不发 Cookie，跳到 ?err=cross');
  r = await G('?key=wrong', { 'Sec-Fetch-Site': 'none' }); assert.equal(r.headers.get('location'), '/admin?err=wrong');
  r = await G('?key=adm-secret-123', {}); assert.equal(r.headers.get('location'), '/admin'); assert.match(r.headers.get('set-cookie') || '', /jx_admin=/);
  for (let i = 0; i < 10; i++) await G('?key=wrong', {});
  r = await G('?key=adm-secret-123', {}); assert.equal(r.headers.get('location'), '/admin?err=locked');
  ok('旧书签 ?key=：直接打开照常换 Cookie；输错跳 ?err=wrong；锁定跳 ?err=locked');
  const env2 = { ...t.env, FEEDBACK_ADMIN_KEY: '' };
  r = await call('/admin?key=x', { headers: {} }, env2); assert.equal(r.headers.get('location'), '/admin?err=nokey'); ok('没配管理密码：?key= 跳 ?err=nokey');
  r = await call('/admin?err=wrong', { headers: {} }, t.env); assert.equal(r.status, 401); const html = await r.text();
  assert.match(html, /密码错误次数过多/); assert.match(html, /get\('err'\)/); ok('登录页会显示 ?err= 对应的提示'); }

  } finally { globalThis.fetch = of; }
});

test('admin page: kind/link escaped, delete checks response, site names', async () => {
  const of = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no net'); };
  try {
// --- 后台页面：kind / link 渲染、删除检查返回、站点名 ---
{ const t = mk(); const L = await call('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '5.5.5.5' }, body: '{"key":"adm-secret-123"}' }, t.env);
  const cookie = (L.headers.get('set-cookie') || '').split(';')[0];
  const r = await call('/admin', { headers: { Cookie: cookie } }, t.env); assert.equal(r.status, 200); const html = await r.text();
  assert.match(html, /esc\(it\.kind\)/); assert.match(html, /esc\(it\.link\)/);
  assert.match(html, /r\.status === 401 \|\| r\.status === 403/); assert.match(html, /删除失败：/);
  assert.match(html, /includes\('youtube'\)\) return 'YouTube站'/); assert.match(html, /includes\('deepseek'\)/); assert.match(html, /hostname\.toLowerCase\(\)/);
  ok('后台页：类型 / 链接经 esc 渲染；删除检查返回（401/403 跳登录，失败提示）；站点名含 YouTube，DeepSeek 小写匹配');
  // 后台页面脚本里的 esc 真能挡 XSS：在 node 里跑一遍渲染逻辑的 esc
  const escSrc = html.match(/const esc = \(s\) => [^\n]+/)[0];
  const esc = eval('(' + escSrc.replace('const esc = ', '').replace(/;\s*$/, '') + ')');
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;'); ok('esc 转义 < > " \' &'); }

  } finally { globalThis.fetch = of; }
});
