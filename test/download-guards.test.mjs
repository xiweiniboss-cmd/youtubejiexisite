import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {sqliteD1} from './helpers/d1.mjs';
import worker,{ytdlReserve,ytdlLeasedResponse,mergeRateReserve,YTDL_CONCURRENCY,YTDL_TASK_LIMIT,YTDL_REQUEST_LIMIT} from '../_worker.js';
const src=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
const internal=await import('data:text/javascript;base64,'+Buffer.from(src+'\nexport {ytExtraTake,ytTicketIssue};').toString('base64'));
const origin='https://youtubejiexisite.pages.dev';
const req=(ip='203.0.113.44',path='/api/ytdl',extra={})=>new Request(origin+path,{...extra,headers:{'cf-connecting-ip':ip,...extra.headers}});
const slots=d=>d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'yds:%'").get().c;
const tasks=d=>d.db.prepare("SELECT COUNT(*) AS c,SUM(n) AS n FROM rate_counter WHERE k LIKE 'ydt:%'").get();
const env=d=>({PARSE_DB:d,TURNSTILE_DISABLED:'1'});
async function fakeFetch(fn,work){const old=globalThis.fetch;globalThis.fetch=fn;try{return await work()}finally{globalThis.fetch=old}}
test('download: real SQLite caps concurrent streams across isolates; headers alone do not release leases',async()=>{
 const d=sqliteD1(),e=env(d),a=(await import('../_worker.js?dl-a')),b=(await import('../_worker.js?dl-b'));
 const rs=await Promise.all(Array.from({length:30},(_,i)=>(i%2?a:b).ytdlReserve(req(),e,'v:test')));
 assert.equal(rs.filter(r=>!r.deny).length,YTDL_CONCURRENCY);assert.equal(rs.filter(r=>r.deny?.status===429).length,30-YTDL_CONCURRENCY);
 const accepted=rs.filter(r=>!r.deny);const controllers=[];
 const outputs=accepted.map(l=>ytdlLeasedResponse(new Response(new ReadableStream({start(c){controllers.push(c)}})),l,req()));
 assert.equal(slots(d),6);assert.equal((await ytdlReserve(req(),e,'v:test')).deny.status,429);
 const read=outputs[0].text();controllers[0].enqueue(new TextEncoder().encode('abc'));controllers[0].close();assert.equal(await read,'abc');assert.equal(slots(d),5);
 const next=await ytdlReserve(req(),e,'v:test');assert.ok(!next.deny);assert.equal(slots(d),6);await next.release();
 await Promise.all(outputs.slice(1).map(r=>r.body.cancel()));assert.equal(slots(d),0);
});
test('download: task count is independent of ranges/audio/parse; max 20 distinct tasks and bounded request budget',async()=>{
 const d=sqliteD1(),e=env(d);
 for(let i=0;i<10;i++){const l=await ytdlReserve(req(),e,'v:same');assert.ok(!l.deny);await l.release()}
 assert.equal(tasks(d).c,1);assert.equal(tasks(d).n,10);
 assert.equal(d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'youtube:%'").get().c,0);
 for(let i=1;i<YTDL_TASK_LIMIT;i++){const l=await ytdlReserve(req(),e,'v:'+i);assert.ok(!l.deny);await l.release()}
 assert.equal((await ytdlReserve(req(),e,'v:over')).deny.status,429);assert.equal(slots(d),0);
 let repeat=await ytdlReserve(req(),e,'v:same');assert.ok(!repeat.deny);await repeat.release();
 d.db.prepare("UPDATE rate_counter SET n=? WHERE k LIKE 'ydt:%'").run(YTDL_REQUEST_LIMIT);
 assert.equal((await ytdlReserve(req(),e,'v:same')).deny.status,429);assert.equal(slots(d),0);
});
test('download: concurrent distinct tasks cannot race past 20/day; IPv6 /64 shares slots',async()=>{
 const d=sqliteD1(),e=env(d);
 for(let i=0;i<19;i++){const l=await ytdlReserve(req(),e,'seed:'+i);await l.release();}
 const rs=await Promise.all(Array.from({length:50},(_,i)=>(async()=>{const l=await ytdlReserve(req(),e,'v:'+i);if(!l.deny)await l.release();return l})()));
 assert.equal(tasks(d).c,20);assert.equal(rs.filter(r=>!r.deny).length,1);assert.ok(rs.some(r=>r.deny));assert.equal(slots(d),0);
 const ls=[];for(let i=0;i<6;i++)ls.push(await ytdlReserve(req('2001:db8:1:2::'+(10+i)),e,'v:same'));
 assert.ok(ls.every(r=>!r.deny));assert.equal((await ytdlReserve(req('2001:db8:1:2::abcd'),e,'v:same')).deny.status,429);
 await Promise.all(ls.map(l=>l.release()));
});
test('download: expired lease reclaim is ownership checked; old release cannot delete new occupant',async()=>{
 const d=sqliteD1(),e=env(d),old=await ytdlReserve(req(),e,'v:a');
 d.db.exec("UPDATE rate_counter SET exp=0 WHERE k LIKE 'yds:%'");
 const fresh=await ytdlReserve(req(),e,'v:a');assert.ok(!fresh.deny);await old.release();assert.equal(slots(d),1);await fresh.release();assert.equal(slots(d),0);
});
test('download: body errors, request abort and hard deadline release stream reservations',async(t)=>{
 const d=sqliteD1(),e=env(d);
 let c;let l=await ytdlReserve(req(),e,'v:a');let r=ytdlLeasedResponse(new Response(new ReadableStream({start(x){c=x}})),l,req());
 const read=r.text();c.error(Error('upstream lost'));await assert.rejects(read,/upstream lost/);assert.equal(slots(d),0);
 const ac=new AbortController();l=await ytdlReserve(req(),e,'v:a');r=ytdlLeasedResponse(new Response(new ReadableStream()),l,req(undefined,'/api/ytdl',{signal:ac.signal}));
 ac.abort();await assert.rejects(r.text());await new Promise(resolve=>setImmediate(resolve));assert.equal(slots(d),0);
 l=await ytdlReserve(req(),e,'v:a');t.mock.timers.enable({apis:['setTimeout']});r=ytdlLeasedResponse(new Response(new ReadableStream()),{...l,expiry:Date.now()+2000},req());
 t.mock.timers.tick(1100);await assert.rejects(r.text());await new Promise(resolve=>setImmediate(resolve));t.mock.timers.reset();assert.equal(slots(d),0);
});
test('download: Range / If-Range and 206 validators survive actual proxy; failure/denial never leaks a slot',async()=>{
 const d=sqliteD1(),e=env(d),path='/api/ytdl?url='+encodeURIComponent('https://rr1.googlevideo.com/videoplayback?id=one');let calls=0;
 await fakeFetch(async(u,opts)=>{calls++;assert.equal(opts.headers.Range,'bytes=3-5');assert.equal(opts.headers['If-Range'],'"version1"');return new Response('def',{status:206,headers:{'content-range':'bytes 3-5/9','content-length':'3',etag:'"version1"','last-modified':'Mon, 16 Nov 2026 00:00:00 GMT'}})},async()=>{
  const r=await worker.fetch(req(undefined,path,{headers:{Range:'bytes=3-5','If-Range':'"version1"'}}),e);
  assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 3-5/9');assert.equal(r.headers.get('etag'),'"version1"');assert.equal(slots(d),1);assert.equal(await r.text(),'def');assert.equal(slots(d),0);
 });
 await fakeFetch(async()=>new Response('bad',{status:503}),async()=>{assert.equal((await worker.fetch(req(undefined,path),e)).status,502);assert.equal(slots(d),0)});
 await fakeFetch(async()=>{calls++;throw Error('must not fetch')},async()=>{
  const before=calls;for(const PARSE_DB of [null,{prepare(){throw Error('db down')}}])assert.equal((await worker.fetch(req(undefined,path),{...e,PARSE_DB})).status,503);assert.equal(calls,before);
 });
});
test('ticket: selective UPDATE errors/timeouts cannot fall through to a healthy no-ticket quota',async(t)=>{
 const d=sqliteD1();let inserts=0;
 const faulty={prepare(sql){if(sql.startsWith('UPDATE rate_counter SET n = n + 1'))return{bind(){return this},first(){throw Error('ticket down')}};inserts++;return d.prepare(sql)}};
 assert.equal((await internal.ytExtraTake(req(),{PARSE_DB:faulty},'hd','dQw4w9WgXcQ')).status,503);assert.equal(inserts,0);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=internal.ytExtraTake(req(),{PARSE_DB:{prepare(){return{bind(){return this},first(){return new Promise(()=>{})}}}}},'hd','dQw4w9WgXcQ');
 t.mock.timers.tick(2100);assert.equal((await pending).status,503);t.mock.timers.reset();
 assert.equal(d.db.prepare('SELECT COUNT(*) AS c FROM rate_counter').get().c,0);
 assert.equal(await internal.ytTicketIssue({PARSE_DB:{prepare(){throw Error('down')}}},'203.0.113.44','dQw4w9WgXcQ'),false);
});
test('merge: D1 timeouts reject, clock-hour/day boundaries and cross-midnight cooldown stay atomic',async(t)=>{
 const now=Date.now;let clock=Date.parse('2026-11-16T15:59:50Z');Date.now=()=>clock;
 try{const d=sqliteD1(),e=env(d);let r=await mergeRateReserve(req(),e);assert.ok(!r.deny);await r.settle(true);
 clock+=20000;assert.equal((await mergeRateReserve(req(),e)).deny.status,429,'cooldown spans midnight');
 clock+=41000;r=await mergeRateReserve(req(),e);assert.ok(!r.deny);await r.settle(true);
 }finally{Date.now=now}
 t.mock.timers.enable({apis:['setTimeout']});const pending=mergeRateReserve(req(),{PARSE_DB:{prepare(){return{bind(){return this},first(){return new Promise(()=>{})}}}}});
 t.mock.timers.tick(2100);assert.equal((await pending).deny.status,503);t.mock.timers.reset();
});
test('frontend: stale 25min grace is removed; download/merge reverify without parsing again',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/TS_PASS_MS\s*=\s*25|30 分钟/);
 assert.match(html,/TS_PASS_MS = 4 \* 60 \* 1000/);assert.match(html,/ensureHumanPass\(\)\.then/);assert.match(html,/fetch\('\/api\/human-pass'/);
 const code=html.match(/function humanQuery\(\)[\s\S]*?(?=  \/\/ HUMAN_)/)[0];
 const box={Date,tsParseWidgetId:1,tsToken:'',tsPassUntil:Date.now()-60000,tsMissing:false,tsUnavailable:false,tsLoadFailed:false,turnstile:{reset(){},getResponse(){return ''}},document:{getElementById(){return null}}};
 vm.createContext(box);vm.runInContext(code,box);assert.equal(box.humanQuery(),null,'idle 6min needs fresh verification');
});
test('frontend: successful re-verification renews pass without charging parse; rejected pass resets and surfaces prompt',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),code=html.match(/  function ensureHumanPass\(\)[\s\S]*?(?=  \/\/ HUMAN_)/)[0];
 let urls=[],done=0,deny=false;
 const box={Promise,Error,humanReady:async()=>{},humanQuery:()=> '&turnstile=new%20token',tsNeedMsg:()=> '请先验证',
  humanDone(q,j,used){done++;assert.equal(q,'&turnstile=new%20token');assert.equal(used,!deny);return !!j.code},humanMsg:()=> '验证已过期',
  fetch:async url=>{urls.push(url);return{ok:!deny,headers:{get:()=>deny?null:'used'},json:async()=>deny?{code:'HUMAN_REQUIRED'}:{ok:true}}}};
 vm.createContext(box);vm.runInContext(code,box);await box.ensureHumanPass();
 assert.deepEqual(urls,['/api/human-pass?turnstile=new%20token']);assert.equal(done,1);
 deny=true;await assert.rejects(box.ensureHumanPass(),/验证已过期/);assert.equal(done,2);assert.ok(urls.every(x=>!x.includes('/api/parse')));
});
test('human-pass endpoint: expired cookie requires fresh verification, refresh alone never consumes parser quota',async()=>{
 const e={TURNSTILE_SECRET_KEY:'test-secret',TURNSTILE_SITE_KEY:'pub',PARSE_DB:sqliteD1()};let verify=0;
 await fakeFetch(async(u)=>{assert.match(String(u),/turnstile\/v0\/siteverify/);verify++;return new Response('{"success":true}')},async()=>{
  let r=await worker.fetch(req(undefined,'/api/human-pass',{headers:{cookie:'yt_hp=expired'}}),e);assert.equal(r.status,403);
  r=await worker.fetch(req(undefined,'/api/human-pass?turnstile=fresh',{headers:{cookie:'yt_hp=expired'}}),e);assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=300/);assert.equal(verify,1);
  assert.equal(e.PARSE_DB.db.prepare('SELECT COUNT(*) AS c FROM rate_counter').get().c,0);
 });
});
