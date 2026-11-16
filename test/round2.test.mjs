import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteD1,testRequest} from './helpers/d1.mjs';
import worker, {MERGE_LIMIT_HOUR,MERGE_LIMIT_DAY} from '../_worker.js';
{const f=worker.fetch.bind(worker);worker.fetch=(r,e,c)=>f(testRequest(r),{TURNSTILE_DISABLED:'1',PARSE_DB:sqliteD1(),...(e||{})},c);}
function memKV(){const m=new Map();return{m,get:async k=>m.get(k)??null,put:async(k,v)=>m.set(k,String(v)),delete:async k=>m.delete(k),list:async({prefix}={})=>({keys:[...m.keys()].filter(k=>!prefix||k.startsWith(prefix)).map(name=>({name}))})}}
async function withFetch(fn,body){const old=globalThis.fetch;globalThis.fetch=fn;try{return await body()}finally{globalThis.fetch=old}}
const call=(path,init,env)=>worker.fetch(new Request('https://youtubejiexisite.pages.dev'+path,init),env);
const START='/api/yt1080-start?url='+encodeURIComponent('https://youtu.be/dQw4w9WgXcQ');
const ec2Ok=n=>new Response(JSON.stringify({ok:true,job_id:'job'+n}),{headers:{'content-type':'application/json'}});
test('merge start: SQLite reserve precedes upstream; 60s lock and IPv6 /64 hourly cap',async()=>{
 const d=sqliteD1(),env={PARSE_DB:d,YT_MERGE_TOKEN:'t'};let ec2=0;
 const realNow=Date.now;let now=Math.floor(realNow()/3600000)*3600000+1000;Date.now=()=>now;
 try{await withFetch(async()=>{ec2++;assert.equal(d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'ymr:2001:db8:aa:bb::/64:%'").get().c,Math.min(ec2,5));return ec2Ok(ec2)},async()=>{
 for(let i=0;i<MERGE_LIMIT_HOUR;i++){
  assert.equal((await call(START,{method:'POST',headers:{'cf-connecting-ip':'2001:db8:aa:bb::'+(10+i)}},env)).status,200);
  assert.equal((await call(START,{method:'POST',headers:{'cf-connecting-ip':'2001:db8:aa:bb::abcd'}},env)).status,429);
  now+=61000;
 }
 assert.equal((await call(START,{method:'POST',headers:{'cf-connecting-ip':'2001:db8:aa:bb::ffff'}},env)).status,429);
 assert.equal(ec2,5);
 assert.equal((await call(START,{method:'POST',headers:{'cf-connecting-ip':'2001:db8:aa:bc::1'}},env)).status,200);
 });}finally{Date.now=realNow}
});
test('merge start: rejected EC2 refunds only its own reservation; ambiguous network failure retains quota',async()=>{
 const d=sqliteD1(),env={PARSE_DB:d,YT_MERGE_TOKEN:'t'};
 for(const status of [503,400,0])await withFetch(async()=>{if(!status)throw Error('unreachable');return new Response('{}',{status})},async()=>{
  const r=await call(START,{method:'POST'},env);assert.notEqual(r.status,200);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'ymr:%'").get().c,status?0:1);
 });
});
test('merge start: concurrent requests through distinct module instances use one shared SQLite gate',async()=>{
 const d=sqliteD1(),env={PARSE_DB:d,YT_MERGE_TOKEN:'t',TURNSTILE_DISABLED:'1'};let calls=0;
 // Separate module globals, not merely two functions in one isolate.
 const a=(await import('../_worker.js?instance=a')).default,b=(await import('../_worker.js?instance=b')).default;
 await withFetch(async()=>{calls++;return ec2Ok(calls)},async()=>{
  const rs=await Promise.all(Array.from({length:30},(_,i)=>(i%2?a:b).fetch(new Request('https://youtubejiexisite.pages.dev'+START,{method:'POST',headers:{'cf-connecting-ip':'2001:db8:bb:cc::'+(10+i)}}),env)));
  assert.equal(rs.filter(r=>r.status===200).length,1);assert.equal(rs.filter(r=>r.status===429).length,29);assert.equal(calls,1);
 });
});
test('merge start: daily cap and missing/broken storage reject before upstream',async()=>{
 const d=sqliteD1(),now=Date.now();
 for(let i=0;i<MERGE_LIMIT_DAY;i++)d.db.prepare('INSERT INTO rate_counter VALUES(?,1,?,?)').run('ymr:203.0.113.11:'+i,now-3600001,now+86400000);
 await withFetch(async()=>{throw Error('must not fetch')},async()=>{
  assert.equal((await call(START,{method:'POST'},{PARSE_DB:d,YT_MERGE_TOKEN:'t'})).status,429);
  for(const PARSE_DB of [null,{prepare(){throw Error('down')}}])assert.equal((await call(START,{method:'POST'},{PARSE_DB,YT_MERGE_TOKEN:'t'})).status,503);
 });
});

test('CORS: allowlist echo + Vary, foreign origin gets no ACAO, no-Origin same-origin still works', async () => {
  const env = { TURNSTILE_DISABLED: '1', FEEDBACK_KV: memKV() };
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
  const env = { TURNSTILE_DISABLED: '1', FEEDBACK_KV: kv, FEEDBACK_ADMIN_KEY: 'secret-key', FEEDBACK_BUCKET: { get: async (k) => (r2.has(k) ? { body: 'JPG', writeHttpMetadata: (h) => h.set('Content-Type', r2.get(k)) } : null) } };
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
  const env = { TURNSTILE_DISABLED: '1', FEEDBACK_KV: memKV(), FEEDBACK_ADMIN_KEY: 'secret-key' };
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
