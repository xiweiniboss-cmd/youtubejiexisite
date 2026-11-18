import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {resourceSpend,resourceLease,MERGE_READ_POLICY as P,FEEDBACK_BODY_MAX,_resetMergeReadCaches} from '../_worker.js';
import {sqliteD1} from './helpers/d1.mjs';
const req=(path,ip='203.0.113.8',headers={},init={})=>new Request('https://youtubejiexisite.pages.dev'+path,{...init,headers:{'cf-connecting-ip':ip,...headers}});
const env=()=>({PARSE_DB:sqliteD1(),YT_MERGE_TOKEN:'mock-only',YT_MERGE_BASE:'https://merge.invalid',TURNSTILE_SECRET_KEY:'secret',TURNSTILE_SITE_KEY:'public'});
const file='/api/yt1080-file?id=job-123456',status='/api/yt1080-status?id=job-123456';
async function mocked(f,fn){const old=globalThis.fetch;globalThis.fetch=f;_resetMergeReadCaches();try{return await fn();}finally{globalThis.fetch=old;_resetMergeReadCaches();}}
const text=()=>Response.json({ok:false,error:'missing'},{status:404});
const cancel=async r=>{if(r.body&&!r.bodyUsed)await r.body.cancel();};

test('D1 budgets are atomic across concurrent requests; missing, broken and timed-out storage fail closed',async t=>{
 const e=env();const out=await Promise.allSettled(Array.from({length:30},()=>resourceSpend(e,'test-budget',1,5,Date.now()+60000)));
 assert.equal(out.filter(x=>x.status==='fulfilled').length,5);assert.equal(e.PARSE_DB.db.prepare('SELECT n FROM rate_counter WHERE k=?').get('test-budget').n,5);
 for(const PARSE_DB of [null,{prepare(){throw Error('down')}}])await assert.rejects(resourceSpend({PARSE_DB},'x',1,5,1),e=>e.status===503);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=resourceSpend({PARSE_DB:{prepare(){return{bind(){return this},first(){return new Promise(()=>{})}}}}},'x',1,5,1);
 t.mock.timers.tick(2001);await assert.rejects(pending,e=>e.status===503);t.mock.timers.reset();
});

test('status: no cookie needed for history, but D1 is mandatory and repeated positive/negative lookups coalesce',async()=>{
 const e=env();let calls=0;
 await mocked(async()=>{calls++;await Promise.resolve();return text();},async()=>{
  const rs=await Promise.all(Array.from({length:8},()=>worker.fetch(req(status),e)));
  assert(rs.every(r=>r.status===404));assert.equal(calls,1);
  await worker.fetch(req(status),e);assert.equal(calls,1);
  for(const PARSE_DB of [null,{prepare(){throw Error('down')}}])assert.equal((await worker.fetch(req(status),{...e,PARSE_DB})).status,503);
  assert.equal(calls,1);
 });
});

test('status: global admission caps many IPs at source before forwarding; reject wrong methods and unsafe ids',async()=>{
 const e=env();let calls=0;
 const minute=Math.floor(Date.now()/60000);
 e.PARSE_DB.db.prepare('INSERT INTO rate_counter VALUES(?,?,?,?)').run(`res:status:m:${minute}:all`,600,Date.now(),Date.now()+60000);
 await mocked(async()=>{calls++;return text()},async()=>{
  for(const ip of ['192.0.2.1','192.0.2.2'])assert.equal((await worker.fetch(req(status,ip),e)).status,429);
  assert.equal((await worker.fetch(req(status,undefined,{}, {method:'POST'}),e)).status,405);
  assert.equal((await worker.fetch(req('/api/yt1080-status?id=../bad'),e)).status,400);assert.equal(calls,0);
 });
});

test('status: distinct instances share global and per-IP source concurrency leases',async()=>{
 const e=env(),a=(await import('../_worker.js?res-status-a')).default,b=(await import('../_worker.js?res-status-b')).default;
 let calls=0,unblock;
 const wait=new Promise(r=>unblock=r);
 await mocked(async()=>{calls++;await wait;return text()},async()=>{
  const pending=Array.from({length:5},(_,i)=>(i%2?a:b).fetch(req('/api/yt1080-status?id=job-'+String(i).padStart(8,'0')),e));
  // Wait until all admissions have run (real SQLite); no network involved.
  for(let i=0;i<200 && calls<4;i++)await new Promise(setImmediate);
  assert.equal(calls,4);unblock();const rs=await Promise.all(pending);assert.equal(rs.filter(r=>r.status===429).length,1);
 });
});

test('file: hold six cross-instance leases through body lifetime; seventh denied; cancel returns capacity',async()=>{
 const e=env(),a=(await import('../_worker.js?res-file-a')).default,b=(await import('../_worker.js?res-file-b')).default;let calls=0,cancels=0;
 await mocked(async()=>{calls++;let first=true;return new Response(new ReadableStream({pull(c){if(first){first=false;c.enqueue(new Uint8Array(524288));}},cancel(){cancels++}}),{headers:{'Content-Type':'video/mp4','Content-Length':'1048576'}})},async()=>{
  const rs=await Promise.all(Array.from({length:6},(_,i)=>(i%2?a:b).fetch(req(file),e)));
  assert(rs.every(r=>r.status===200));assert.equal(calls,6);
  assert.equal((await b.fetch(req(file),e)).status,429);assert.equal(calls,6);
  await cancel(rs[0]);const next=await a.fetch(req(file),e);assert.equal(next.status,200);assert.equal(calls,7);
  await Promise.all([...rs.slice(1),next].map(cancel));assert(cancels>=7);
  assert.equal(e.PARSE_DB.db.prepare("SELECT COUNT(*) c FROM rate_counter WHERE k LIKE 'res:lease:merge-file:%'").get().c,0);
 });
});

test('file: global stream leases bound distributed IPs; ownership and expiry protect replacement leases',async()=>{
 const e=env(),leases=[];
 try{
  for(let i=0;i<12;i++)leases.push(await resourceLease(req(file,'192.0.2.'+(i+1)),e,'merge-file',6,12,600000));
  await assert.rejects(resourceLease(req(file,'198.51.100.1'),e,'merge-file',6,12,600000),e=>e.status===429);
 }finally{await Promise.all(leases.map(l=>l.release()));}
 const old=await resourceLease(req(file),e,'test-owner',1,1,100);
 e.PARSE_DB.db.prepare("UPDATE rate_counter SET exp=0 WHERE k LIKE 'res:lease:test-owner:%'").run();
 const current=await resourceLease(req(file),e,'test-owner',1,1,100);await old.release();
 assert.equal(e.PARSE_DB.db.prepare("SELECT COUNT(*) c FROM rate_counter WHERE k LIKE 'res:lease:test-owner:%'").get().c,2);await current.release();
});

test('file: byte admission includes prefix; versioned proof is shared across isolates and invalidates with ETag',async()=>{
 const e=env(),b=(await import('../_worker.js?res-proof')).default;let calls=0,prefixes=0,etag='"v1"';
 await mocked(async(url,init)=>{
  calls++;const prefix=init.headers.Range==='bytes=0-524287';if(prefix)prefixes++;
  return new Response(new Uint8Array(prefix?524288:1),{status:206,headers:{'Content-Type':'video/mp4','Content-Length':String(prefix?524288:1),'Content-Range':prefix?'bytes 0-524287/1048576':'bytes 1000000-1000000/1048576',ETag:etag}});
 },async()=>{
  for(const w of [worker,b]){const r=await w.fetch(req(file,undefined,{Range:'bytes=1000000-1000000'}),e);assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,1);}
  assert.equal(calls,3);assert.equal(prefixes,1);
  etag='"v2"';const r=await worker.fetch(req(file,undefined,{Range:'bytes=1000000-1000000'}),e);assert.equal(r.status,206);await r.arrayBuffer();assert.equal(prefixes,2);
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  assert.equal(e.PARSE_DB.db.prepare('SELECT n FROM rate_counter WHERE k=?').get(`res:file:bytes:${day}:all`).n,1048579);
 });
});

test('file: no validator never grants cached proof, oversized streams and missing storage cannot bypass budgets',async()=>{
 const e=env();let prefixes=0,calls=0;
 await mocked(async(url,init)=>{calls++;const prefix=init.headers.Range==='bytes=0-524287';if(prefix)prefixes++;return new Response(new Uint8Array(prefix?524288:1),{status:206,headers:{'Content-Type':'video/mp4','Content-Length':String(prefix?524288:1),'Content-Range':prefix?'bytes 0-524287/1048576':'bytes 1000000-1000000/1048576'}})},async()=>{
  for(let i=0;i<2;i++){const r=await worker.fetch(req(file,undefined,{Range:'bytes=1000000-1000000'}),e);assert.equal(r.status,206);await r.arrayBuffer();}assert.equal(prefixes,2);
  const n=calls;for(const PARSE_DB of [null,{prepare(){throw Error('down')}}])assert.equal((await worker.fetch(req(file),{...e,PARSE_DB})).status,503);assert.equal(calls,n);
 });
 await mocked(async()=>new Response(new Uint8Array(1),{headers:{'Content-Type':'video/mp4','Content-Length':String(P.maxFileBytes+1)}}),async()=>assert.equal((await worker.fetch(req(file),env())).status,413));
});

test('file: fixed hard deadline aborts an idle body and releases source slots',async t=>{
 const e=env();let canceled=0;
 await mocked(async()=>{let first=true;return new Response(new ReadableStream({pull(c){if(first){first=false;c.enqueue(new Uint8Array(524288));}},cancel(){canceled++}}),{headers:{'Content-Type':'video/mp4','Content-Length':'1048576'}})},async()=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=await worker.fetch(req(file),e);assert.equal(r.status,200);
  t.mock.timers.tick(P.streamMs+1);await new Promise(setImmediate);
  await assert.rejects(r.arrayBuffer());assert.equal(canceled,1);
  assert.equal(e.PARSE_DB.db.prepare("SELECT COUNT(*) c FROM rate_counter WHERE k LIKE 'res:lease:merge-file:%'").get().c,0);t.mock.timers.reset();
 });
});

function feedbackEnv(){const e=env(),records=new Map();e.FEEDBACK_KV={get:async k=>records.get(k)||null,put:async(k,v)=>records.set(k,v)};return {e,records};}
const feedback=(body='{"message":"test","tsToken":"distinct-mocked-valid"}',ip='203.0.113.8')=>req('/api/feedback',ip,{'Content-Type':'application/json'},{method:'POST',body});
test('feedback: concurrent valid submissions create one record, sequential retry is atomically cooled down',async()=>{
 const {e,records}=feedbackEnv();
 await mocked(async()=>Response.json({success:true}),async()=>{
  const rs=await Promise.all(Array.from({length:12},()=>worker.fetch(feedback(),e)));
  assert.equal(rs.filter(r=>r.status===200).length,1);assert.equal(rs.filter(r=>r.status===429).length,11);
  assert.equal([...records.keys()].filter(k=>k.startsWith('fb_')).length,1);
  assert.equal((await worker.fetch(feedback(),e)).status,429);
 });
});

test('feedback: content-length and streamed body caps enforce before token verification/storage, absent IP/D1 fail closed',async()=>{
 const {e,records}=feedbackEnv();let verifies=0;
 await mocked(async()=>{verifies++;return Response.json({success:true})},async()=>{
  assert.equal((await worker.fetch(req('/api/feedback',undefined,{'Content-Type':'multipart/form-data; boundary=x','Content-Length':String(FEEDBACK_BODY_MAX+1)},{method:'POST',body:'x'}),e)).status,413);
  const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));c.close();}});
  const r=req('/api/feedback','203.0.113.9',{'Content-Type':'application/json'},{method:'POST',body,duplex:'half'});
  assert.equal((await worker.fetch(r,e)).status,413);assert.equal(verifies,0);assert.equal(records.size,0);
  for(const PARSE_DB of [null,{prepare(){throw Error('down')}}])assert.equal((await worker.fetch(feedback(),{...e,PARSE_DB})).status,503);
  const noIp=new Request('https://youtubejiexisite.pages.dev/api/feedback',{method:'POST',body:'{}'});assert.equal((await worker.fetch(noIp,e)).status,503);assert.equal(verifies,0);
 });
});

test('feedback: missing secret denies instead of silently disabling verification; storage error retains cooldown',async()=>{
 const {e}=feedbackEnv();let calls=0;
 await mocked(async()=>{calls++;return Response.json({success:true})},async()=>{
  assert.equal((await worker.fetch(feedback(),{...e,TURNSTILE_SECRET_KEY:''})).status,503);
  const down={...e,FEEDBACK_KV:{put:async()=>{throw Error('down')}}};assert.equal((await worker.fetch(feedback(),down)).status,500);
  assert.equal((await worker.fetch(feedback(),down)).status,429);assert.equal(calls,2);
 });
});

test('file: exhausted byte budget cancels source before reading; per-job budget rejects before fetch',async()=>{
 const e=env(),day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);let read=0,canceled=0,calls=0;
 e.PARSE_DB.db.prepare('INSERT INTO rate_counter VALUES(?,?,?,?)').run(`res:file:bytes:${day}:ip:203.0.113.8`,P.bytesPerIpDay,Date.now(),Date.now()+86400000);
 await mocked(async()=>{calls++;return new Response(new ReadableStream({pull(c){read++;c.enqueue(new Uint8Array(8));},cancel(){canceled++;}},{highWaterMark:0}),{headers:{'Content-Type':'video/mp4','Content-Length':'8'}})},async()=>{
  assert.equal((await worker.fetch(req(file),e)).status,429);assert.equal(read,0);assert.equal(canceled,1);
  e.PARSE_DB.db.prepare('INSERT OR REPLACE INTO rate_counter VALUES(?,?,?,?)').run(`res:file:d:${day}:job:job-123456`,P.filePerJobDay,Date.now(),Date.now()+86400000);
  assert.equal((await worker.fetch(req(file),e)).status,429);assert.equal(calls,1);
 });
});

test('feedback: exhausted raw-input budget never reads body; stalled read stops at deadline',async t=>{
 const {e}=feedbackEnv(),day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);let read=0,canceled=0;
 e.PARSE_DB.db.prepare('INSERT INTO rate_counter VALUES(?,?,?,?)').run(`res:feedback:input:${day}:ip:203.0.113.8`,64*1024*1024,Date.now(),Date.now()+86400000);
 await mocked(async()=>assert.fail('must not verify'),async()=>{
  const blocked=req('/api/feedback',undefined,{'Content-Type':'application/json'},{method:'POST',body:new ReadableStream({pull(c){read++;c.enqueue(new Uint8Array(16));},cancel(){canceled++;}},{highWaterMark:0}),duplex:'half'});
  assert.equal((await worker.fetch(blocked,e)).status,429);assert.equal(read,0);assert.equal(canceled,1);
  const slow=req('/api/feedback','203.0.113.9',{'Content-Type':'application/json'},{method:'POST',body:new ReadableStream({pull(){},cancel(){canceled++;}},{highWaterMark:0}),duplex:'half'});
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=worker.fetch(slow,e);
  for(let i=0;i<30;i++)await new Promise(setImmediate);
  t.mock.timers.tick(30001);assert.equal((await pending).status,408);assert.equal(canceled,2);t.mock.timers.reset();
 });
});

test('feedback: independent isolates share atomic cooldown even after releasing upload leases',async()=>{
 const {e,records}=feedbackEnv(),other=(await import('../_worker.js?feedback-cross-instance')).default;
 await mocked(async()=>Response.json({success:true}),async()=>{
  assert.equal((await worker.fetch(feedback(),e)).status,200);
  assert.equal((await other.fetch(feedback(),e)).status,429);
  assert.equal([...records.keys()].filter(k=>k.startsWith('fb_')).length,1);
 });
});

test('feedback: combined attachments capped and frontend text/selection agree',async()=>{
 const {e}=feedbackEnv(),fd=new FormData();fd.append('message','large');fd.append('tsToken','mock');
 fd.append('files',new File([new Uint8Array(11*1024*1024)],'one.mp4',{type:'video/mp4'}));
 fd.append('files',new File([new Uint8Array(10*1024*1024)],'two.mp4',{type:'video/mp4'}));
 const encoded=new Response(fd),bytes=await encoded.arrayBuffer();
 await mocked(async()=>assert.fail('oversized body must not verify'),async()=>{
  assert.equal((await worker.fetch(req('/api/feedback',undefined,{'Content-Type':encoded.headers.get('Content-Type')}, {method:'POST',body:bytes}),e)).status,413);
 });
 const {readFileSync}=await import('node:fs');const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert(html.includes('最多 3 个 · 合计不超过 20MB'));assert(html.includes('fbPicked.reduce(function(n,item)'));
});
