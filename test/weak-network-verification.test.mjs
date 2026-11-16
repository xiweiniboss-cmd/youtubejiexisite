import test from 'node:test';
import assert from 'node:assert/strict';
import {humanUI} from './helpers/frontend-human.mjs';
const passCalls=x=>x.calls.filter(c=>c.url.startsWith('/api/human-pass'));

test('300010 ends current attempt; late callback cannot revive it; next explicit attempt recreates challenge',async()=>{
  const x=humanUI();await x.init();
  const old=x.callbacks;
  const failed=assert.rejects(x.ctx.ensureHumanPass(),/人机验证/);await x.flush();
  old['error-callback']('300010');
  assert.match(x.elements.tsParseState.textContent,/300010/);
  old.callback('late'); // even before next poll, failure must win
  await x.advance(300);await failed;
  assert.equal(passCalls(x).length,0);assert.equal(x.removes,1);
  const retry=x.ctx.ensureHumanPass();await x.flush();
  assert.equal(x.renders,2);
  old['error-callback']('300010');old.callback('late');
  assert.notEqual(x.ctx.tsState,'rejected','retired widget cannot poison fresh challenge');
  await x.solve('new-token');await retry;
  assert.equal(passCalls(x).length,1);assert.match(passCalls(x)[0].url,/new-token/);
});

test('hidden-tab timer delay cannot accept a token after the challenge deadline',async()=>{
  const x=humanUI();await x.init();
  const failed=assert.rejects(x.ctx.ensureHumanPass(),/已超时/);await x.flush();
  x.elapse(120001); // no timer ran while tab was suspended
  await x.solve('too-late');await failed;
  assert.equal(passCalls(x).length,0);assert.equal(x.removes,1);
  const retry=x.ctx.ensureHumanPass();await x.flush();await x.solve('fresh');await retry;
  assert.equal(passCalls(x).length,1);
});

test('rapid concurrent callers share one widget wait and one single-use token redemption',async()=>{
  const x=humanUI({used:true});await x.init();
  const a=x.ctx.ensureHumanPass(),b=x.ctx.ensureHumanPass();assert.equal(a,b);await x.flush();
  assert.equal(x.resets,1);await x.solve();await Promise.all([a,b]);
  assert.equal(passCalls(x).length,1);assert.equal(x.resets,2);
});

for(const phase of ['headers','body'])test(`human-pass ${phase} timeout aborts, releases waiter and ignores late success`,async()=>{
  let release,signal;
  const pending=new Promise(resolve=>{release=resolve;});
  const x=humanUI({fetch:async(url,init)=>{
    signal=init.signal;
    if(phase==='headers')return pending;
    return {ok:true,headers:new Headers({'X-Human-Token':'used'}),json:()=>pending};
  }});await x.init();
  const failed=assert.rejects(x.ctx.ensureHumanPass(),/通行证请求超时/);await x.flush();await x.solve();
  await x.advance(30000);await failed;
  assert.equal(signal.aborted,true);assert.equal(x.ctx.tsPassUntil,0);assert.equal(x.ctx._humanPassPending,null);
  release(phase==='headers'?Response.json({ok:true},{headers:{'X-Human-Token':'used'}}):{ok:true});
  await x.flush();assert.equal(x.ctx.tsPassUntil,0,'late response must not grant a local pass');
  assert.equal(passCalls(x).length,1,'no silent request replay');
});

test('response resolving after deadline is rejected even before delayed timeout timer runs',async()=>{
  let release;const x=humanUI({used:true,fetch:()=>new Promise(resolve=>{release=resolve;})});await x.init();
  const failed=assert.rejects(x.ctx.ensureHumanPass(),/通行证请求超时/);await x.flush();await x.solve();
  x.elapse(30001);release(Response.json({ok:true},{headers:{'X-Human-Token':'used'}}));
  await x.flush();await failed;assert.equal(x.ctx.tsPassUntil,0);
});

test('script timeout removes failed script and permits next explicit load without refresh',async()=>{
  const x=humanUI({noAPI:true});
  const fail=assert.rejects(x.ctx.humanReady(),/加载失败/);await x.flush();
  assert.equal(x.scripts.length,1);
  await x.advance(30000);await x.advance(300);await fail;
  assert.equal(x.scripts[0].removed,true);assert.equal(x.ctx._tsScriptPromise,null);
  const retry=assert.rejects(x.ctx.humanReady(),/加载失败/);await x.flush();assert.equal(x.scripts.length,2);
  await x.advance(30000);await x.advance(300);await retry;
  assert.equal(x.calls.filter(c=>c.url==='/api/turnstile-key').length,2);
});

test('site-key request failure is not cached forever and cannot bypass required verification',async()=>{
  let n=0;
  const x=humanUI({keyFetch:async()=>++n===1?new Response('',{status:503}):Response.json({ok:true,required:true,siteKey:'public'})});
  const failed=assert.rejects(x.ctx.ensureHumanPass(),/加载失败/);await x.flush();await x.advance(300);await failed;
  assert.equal(passCalls(x).length,0);
  const retry=x.ctx.ensureHumanPass();await x.flush();await x.solve();await retry;
  assert.equal(n,2);assert.equal(passCalls(x).length,1);
});

for(const event of ['expired-callback','timeout-callback'])test(`${event} never loops a background reset and retires stale callbacks`,async()=>{
  const x=humanUI();await x.init();const old=x.callbacks;
  old[event]();await x.advance(600000);assert.equal(x.resets,0);assert.equal(passCalls(x).length,0);
  const retry=x.ctx.ensureHumanPass();await x.flush();old.callback('late');await x.solve('fresh');await retry;
  assert.equal(x.renders,2);assert.equal(passCalls(x).length,1);
  assert.equal(x.callbacks.retry,'never');assert.equal(x.callbacks['refresh-expired'],'manual');
});
