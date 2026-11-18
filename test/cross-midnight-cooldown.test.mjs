import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sqliteD1} from './helpers/d1.mjs';
import worker from '../_worker.js';
const source=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
const load=tag=>import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {rateTake,rateUsed};\n// '+tag).toString('base64'));
const a=await load('a'),b=await load('b');
const ip='203.0.113.8',before=Date.parse('2026-11-18T23:59:59+08:00');
const day='2026-11-18',next='2026-11-19';
async function clock(fn){const real=Date.now;let now=before;Date.now=()=>now;try{await fn(t=>now=t);}finally{Date.now=real;}}
for(const [site,seconds] of [['youtube',60],['youtube_feedback',600]]){
 test(site+': legacy row blocks cross-midnight retries without spending next day count; exact boundary admits only one',async()=>clock(async set=>{
  const d=sqliteD1(),e={PARSE_DB:d};
  d.db.prepare('INSERT INTO rate_counter VALUES(?,?,?,?)').run(site+':'+ip+':'+day,20,before,before+172800000);
  set(before+2000);
  const denied=await b.rateTake(e,site,ip,20,seconds);assert.equal(denied.status,429);assert.match(denied.msg,new RegExp('请 '+(seconds-2)+' 秒'));
  assert.equal(await a.rateUsed(e,site,ip),0);
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM rate_counter WHERE k=?').get(site+':'+ip+':'+next).n,0);
  set(before+seconds*1000-1);assert.equal((await a.rateTake(e,site,ip,20,seconds)).status,429);
  set(before+seconds*1000);
  const results=await Promise.all(Array.from({length:30},(_,i)=>(i%2?a:b).rateTake(e,site,ip,20,seconds)));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.status===429).length,29);
  assert.equal(await a.rateUsed(e,site,ip),1);
  assert.equal(d.db.prepare('SELECT n FROM rate_counter WHERE k=?').get(site+':'+ip+':'+day).n,20);
 }));
}
test('zero cooldown still permits atomic daily allowance and resets at midnight',async()=>clock(async set=>{
 const e={PARSE_DB:sqliteD1()};
 for(let i=0;i<20;i++)assert.equal((await a.rateTake(e,'youtube_hd',ip,20,0)).ok,true);
 assert.equal((await b.rateTake(e,'youtube_hd',ip,20,0)).status,429);
 set(before+2000);
 const rs=await Promise.all(Array.from({length:30},(_,i)=>(i%2?a:b).rateTake(e,'youtube_hd',ip,20,0)));
 assert.equal(rs.filter(r=>r.ok).length,20);assert.equal(await a.rateUsed(e,'youtube_hd',ip),20);
}));
test('cooldown keys isolate site, IPv4 and IPv6 /64; old-day limit does not leak',async()=>clock(async set=>{
 const e={PARSE_DB:sqliteD1()};
 assert.equal((await a.rateTake(e,'youtube',ip)).ok,true);set(before+2000);
 assert.equal((await b.rateTake(e,'youtube_feedback',ip,20,600)).ok,true);
 assert.equal((await b.rateTake(e,'youtube','203.0.113.9')).ok,true);
 assert.equal((await a.rateTake(e,'youtube','2001:db8:1:2::1')).ok,true);
 assert.equal((await b.rateTake(e,'youtube','2001:db8:1:2::ffff')).status,429);
 assert.equal((await b.rateTake(e,'youtube','2001:db8:1:3::1')).ok,true);
}));
test('actual feedback route refuses cross-midnight write until 600 seconds',async()=>clock(async set=>{
 const e={PARSE_DB:sqliteD1(),TURNSTILE_SECRET_KEY:'mock'},records=new Map();e.FEEDBACK_KV={put:async(k,v)=>records.set(k,v)};
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({success:true});
 const request=()=>new Request('https://youtubejiexisite.pages.dev/api/feedback',{method:'POST',headers:{'cf-connecting-ip':ip,'Content-Type':'application/json'},body:JSON.stringify({message:'midnight regression',tsToken:'mock'})});
 try{
  assert.equal((await worker.fetch(request(),e)).status,200);set(before+2000);
  assert.equal((await b.default.fetch(request(),e)).status,429);assert.equal(records.size,1);
  set(before+600000);assert.equal((await b.default.fetch(request(),e)).status,200);assert.equal(records.size,2);
 }finally{globalThis.fetch=old;}
}));
test('youtube parse uses no interval cooldown: back-to-back parses pass, daily 20 still holds',async()=>clock(async set=>{
 assert.match(source,/rateTake\(env, 'youtube', parseIp, RL_DAILY_LIMIT, PARSE_COOLDOWN_SECS\)/);
 assert.match(source,/const PARSE_COOLDOWN_SECS = 0;/);
 const e={PARSE_DB:sqliteD1()};
 for(let i=0;i<20;i++)assert.equal((await a.rateTake(e,'youtube',ip,20,0)).ok,true);
 const r=await b.rateTake(e,'youtube',ip,20,0);assert.equal(r.status,429);assert.match(r.msg,/今日解析次数已用完/);
}));
