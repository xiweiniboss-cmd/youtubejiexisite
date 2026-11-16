import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sqliteD1} from './helpers/d1.mjs';
import worker from '../_worker.js';
const source=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
const mod=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {rateTake,rateUsed};').toString('base64'));
const take=(env,ip)=>mod.rateTake(env,'youtube',ip);
const ip='2001:db8:1:2::1234';
test('strict storage: missing D1/IP, SQL errors and timeout fail closed without touching KV',async(t)=>{
 let kvCalls=0;const kv={get:async()=>{kvCalls++;return null},put:async()=>{kvCalls++}};
 assert.equal((await take({FEEDBACK_KV:kv},ip)).status,503);
 assert.equal((await take({PARSE_DB:sqliteD1()},'')).status,503);
 assert.equal((await take({PARSE_DB:{prepare(){throw Error('db down')}},FEEDBACK_KV:kv},ip)).status,503);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=take({PARSE_DB:{prepare(){return {bind(){return this},first(){return new Promise(()=>{})}}}},FEEDBACK_KV:kv},ip);
 t.mock.timers.tick(2100);
 assert.equal((await pending).status,503);t.mock.timers.reset();
 assert.equal(kvCalls,0,'never fall back to KV');
});
test('strict storage: 30 concurrent requests share one SQLite admission, daily quota remains atomic',async()=>{
 const db=sqliteD1(),env={PARSE_DB:db};
 const rs=await Promise.all(Array.from({length:30},(_,i)=>take(env,'2001:db8:1:2::'+(100+i).toString(16))));
 assert.equal(rs.filter(x=>x.ok).length,1);
 db.db.exec('UPDATE rate_counter SET n=20,last=0');
 assert.equal((await take(env,ip)).status,429);
});
test('strict storage: actual parse route returns 503 without calling upstream on missing/broken D1',async()=>{
 const old=globalThis.fetch;let upstream=0;globalThis.fetch=async()=>{upstream++;throw Error('must not fetch')};
 try{for(const storage of [{},{PARSE_DB:{prepare(){throw Error('db down')}}}]){
   const req=new Request('https://youtubejiexisite.pages.dev/api/parse?url='+encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'),{headers:{'cf-connecting-ip':'203.0.113.55'}});
   const response=await worker.fetch(req,{TURNSTILE_DISABLED:'1',REDFOX_API_KEY:'test',...storage},{waitUntil(){}});
   assert.equal(response.status,503,await response.text());
 }assert.equal(upstream,0);}finally{globalThis.fetch=old}
});

test('quota: missing/broken D1 returns unknown rather than reading legacy KV',async()=>{
 let calls=0;const kv={get:async()=>{calls++;return '0'}};
 assert.equal(await mod.rateUsed({FEEDBACK_KV:kv},'test','203.0.113.1'),null);
 assert.equal(await mod.rateUsed({PARSE_DB:{prepare(){throw Error('down')}},FEEDBACK_KV:kv},'test','203.0.113.1'),null);
 assert.equal(calls,0);
});
