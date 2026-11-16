import test from 'node:test';
import assert from 'node:assert/strict';
import {humanUI} from './helpers/frontend-human.mjs';

test('expired offscreen widget is reset once, revealed, and redeemed only via human-pass',async()=>{
  const x=humanUI({used:true});await x.init();
  const p=x.ctx.ensureHumanPass();await x.flush();
  assert.equal(x.resets,1);assert.equal(x.scrolls,1);
  assert.match(x.elements.tsParseState.textContent,/自动继续/);
  assert.equal(x.calls.length,1,'no protected request before visitor solves');
  await x.solve();await p;
  assert.equal(x.calls[1].url,'/api/human-pass?turnstile=fresh-token');
  assert.equal(x.calls[1].init.credentials,'same-origin');
  assert.equal(x.resets,2,'only the expired widget and the consumed one-time token reset');
  assert.ok(x.run('tsPassUntil > Date.now()'));
});

test('valid local pass and fresh token do not reset or scroll a working widget',async()=>{
  for(const fresh of [false,true]){
    const x=humanUI();await x.init();
    if(fresh)x.setToken('unused');else x.run('tsPassUntil = Date.now() + 60000');
    await x.ctx.ensureHumanPass();assert.equal(x.resets,0);assert.equal(x.scrolls,0);
    assert.equal(x.calls.at(-1).url,fresh?'/api/human-pass?turnstile=unused':'/api/human-pass');
  }
});

test('first render is revealed without immediately resetting an in-flight initial challenge',async()=>{
  const x=humanUI(),p=x.ctx.ensureHumanPass();await x.flush();
  assert.deepEqual(x.events,['render','reveal']);assert.equal(x.resets,0);
  await x.solve();await p;
});

test('widget errors after previously being ready reject promptly; next click retries without refresh',async()=>{
  const x=humanUI();await x.init();let rejected=false;
  const p=assert.rejects(x.ctx.ensureHumanPass(),/人机验证/).then(()=>{rejected=true;});await x.flush();
  x.callbacks['error-callback']('200500');await x.advance(300);await p;assert.equal(rejected,true);
  const retry=x.ctx.ensureHumanPass();await x.flush();assert.equal(x.resets,2);
  await x.solve('retry');await retry;
  assert.equal(x.calls.filter(c=>c.url.startsWith('/api/human-pass')).length,1);
});

test('reset failure and challenge timeout keep protected requests blocked and permit retry',async()=>{
  const bad=humanUI({resetThrows:true});await bad.init();
  await assert.rejects(bad.ctx.ensureHumanPass(),/不要刷新/);assert.equal(bad.calls.length,1);
  const x=humanUI();await x.init();
  const rejected=assert.rejects(x.ctx.ensureHumanPass(),/请先完成人机验证/);await x.flush();
  await x.advance(120001);await rejected;assert.equal(x.calls.length,1);
  const retry=x.ctx.ensureHumanPass();await x.flush();await x.solve();await retry;
});

test('backend rejection does not grant a pass, parse again, or silently retry protected actions',async()=>{
  const x=humanUI({fetch:async()=>Response.json({code:'HUMAN_FAILED',error:'verification denied'},{status:403})});await x.init();
  const p=assert.rejects(x.ctx.ensureHumanPass(),/verification denied/);await x.flush();await x.solve();await p;
  assert.equal(x.ctx.tsPassUntil,0);assert.equal(x.calls.length,2);
});

test('explicit server opt-out does not initialize or force a widget',async()=>{
  const x=humanUI();x.ctx.tsState='off';await x.ctx.humanReady();assert.equal(x.calls.length,0);assert.equal(x.scrolls,0);
});
