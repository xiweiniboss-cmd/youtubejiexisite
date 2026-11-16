import {humanUI} from './helpers/frontend-human.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../ytmerge.js',import.meta.url),'utf8');
const frontend=source.slice(source.indexOf('window.YTFetch =')).replace('var CH = 8 * 1024 * 1024, PAR = 3;', 'var CH = 16, PAR = 3;');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){ for(let i=0;i<1000;i++){ if(fn()) return; await tick(); } assert.fail('condition never reached'); }
function load(fetch){ const context={window:{},fetch,Blob,AbortController,Set}; vm.runInNewContext(frontend,context); return context.window.YTFetch; }
function origin(options={}){
  const bytes=Uint8Array.from({length:options.length ?? 96},(_,i)=>i%251);
  const calls=[]; let live=0,max=0,cancels=0;
  async function fetch(url,init={}){
    const h=new Headers(init.headers), range=h.get('Range');
    const call={url,range,ifRange:h.get('If-Range'),aborted:false}; calls.push(call);
    if(options.before){ const out=await options.before(call,calls.length); if(out) return out; }
    if(init.signal?.aborted) throw new DOMException('Aborted','AbortError');
    let [,a,b]=range.match(/^bytes=(\d+)-(\d*)$/),start=+a,end=b?Math.min(+b,bytes.length-1):bytes.length-1;
    let status=options.ignore?.(call,calls.length) ? 200 : 206;
    if(status===200){ start=0;end=bytes.length-1; }
    let pos=start,closed=false,ctl;
    live++; max=Math.max(max,live);
    const release=()=>{ if(closed) return; closed=true;live--;init.signal?.removeEventListener('abort',abort); };
    const abort=()=>{ if(closed)return;call.aborted=true;cancels++;release();ctl.error(new DOMException('Aborted','AbortError')); };
    const body=new ReadableStream({
      start(c){ ctl=c;init.signal?.addEventListener('abort',abort,{once:true}); },
      async pull(c){
        await tick(); if(closed) return;
        if(options.breakAt && pos>=options.breakAt && calls.length===1){ release();c.error(new Error('network gone'));return; }
        if(pos>end){ release();c.close();return; }
        const stop=Math.min(end+1,pos+3); c.enqueue(bytes.slice(pos,stop));pos=stop;
      },
      cancel(){ if(!closed)cancels++;release(); }
    });
    const headers={'Content-Length':String(end-start+1),'Content-Type':'video/mp4'};
    if(!options.noValidator){
      if(options.lastModified) headers['Last-Modified']='Mon, 16 Nov 2026 00:00:00 GMT';
      else headers.ETag=options.etag?.(call,calls.length) || '"same-file"';
    }
    if(status===206) headers['Content-Range']=options.contentRange?.(call,calls.length) || `bytes ${start}-${end}/${bytes.length}`;
    return new Response(body,{status,headers});
  }
  return {fetch,calls,bytes,get live(){return live;},get max(){return max;},get cancels(){return cancels;}};
}
async function matches(blob,bytes){ assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes); }

test('normal parallel ranges reconstruct the exact file, at most three requests per stream',async()=>{
  const o=origin(),api=load(o.fetch); let high=0;
  const blob=await api.getProxy('/file',null,(n)=>{assert.ok(n>=high);high=n;});
  await matches(blob,o.bytes); assert.equal(o.live,0);assert.ok(o.max<=3);assert.equal(high,o.bytes.length);
});

test('pause retains partial bytes, releases every stream, resumes at the missing offset with If-Range',async()=>{
  const o=origin(),api=load(o.fetch);let paused=false,verified=0;
  const c=api.createControl({beforeResume:async()=>{verified++;}});
  const result=api.getProxy('/file',null,(n)=>{if(n>=6&&!paused){paused=true;c.pause();}},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);
  const before=o.calls.length;for(let i=0;i<10;i++)await tick();assert.equal(o.calls.length,before);
  await c.resume();await matches(await result,o.bytes);
  assert.equal(verified,1);assert.equal(o.calls[1].range,'bytes=6-15');assert.equal(o.calls[1].ifRange,'"same-file"');assert.ok(o.cancels>0);
});

test('completed ranges are not fetched again; parallel in-flight ranges resume their own offsets',async()=>{
  const o=origin({length:160}),api=load(o.fetch);let paused=false;
  const c=api.createControl();
  const result=api.getProxy('/file',null,n=>{if(n>=35&&!paused){paused=true;c.pause();}},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);
  const mark=o.calls.length;await c.resume();await matches(await result,o.bytes);
  assert.ok(o.calls.slice(mark).every(x=>!x.range.startsWith('bytes=0-')));
  assert.equal(o.calls.filter(x=>x.range==='bytes=0-15').length,1);
});

test('shared video/audio controller pauses and cancels all six permitted requests',async()=>{
  const o=origin({length:240}),api=load(o.fetch);let paused=false,verified=0;
  const c=api.createControl({beforeResume:async()=>{verified++;}});
  const p1=api.getProxy('/video',null,n=>{if(n>=60&&!paused){paused=true;c.pause();}},c);
  const p2=api.getProxy('/audio',null,()=>{},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);
  assert.ok(o.max<=6);assert.ok(o.max>3);
  await c.resume();await Promise.all([p1,p2]).then(bs=>Promise.all(bs.map(b=>matches(b,o.bytes))));
  assert.equal(verified,1);assert.equal(o.live,0);
});

test('pause before headers arrives aborts request, keeps the promise pending, and can resume',async()=>{
  let first=true,entered=false,aborted=false;
  const o=origin(),api=load((url,init)=>{
    if(first){first=false;entered=true;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));}));}
    return o.fetch(url,init);
  });
  const c=api.createControl(),p=api.getProxy('/file',null,()=>{},c);
  await until(()=>entered);c.pause();await until(()=>aborted);await c.resume();await matches(await p,o.bytes);
});

test('double continue clicks do not duplicate verification or requests',async()=>{
  const o=origin(),api=load(o.fetch);let resolve,count=0;
  const c=api.createControl({beforeResume:()=>{count++;return new Promise(r=>{resolve=r;});}});
  c.pause();const p=api.getProxy('/file',null,()=>{},c);
  const a=c.resume(),b=c.resume();assert.equal(count,1);assert.equal(o.calls.length,0);
  resolve();await Promise.all([a,b]);await matches(await p,o.bytes);assert.equal(count,1);
});

test('failed re-verification retains chunks and stays paused; success does not parse or create a new task',async()=>{
  const o=origin(),api=load(o.fetch);let attempts=0,paused=false;
  const c=api.createControl({beforeResume:async()=>{if(++attempts===1)throw new Error('please verify');}});
  const p=api.get('https://media.example/file','video/mp4',n=>{if(n>=6&&!paused){paused=true;c.pause();}},'IOS',{v:'dQw4w9WgXcQ',itag:'137',client:'IOS'},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);const mark=o.calls.length;
  await c.resume();assert.equal(c.state,'paused');assert.equal(o.calls.length,mark);
  await c.resume();await matches(await p,o.bytes);
  assert.ok(o.calls.every(x=>x.url===o.calls[0].url));assert.ok(o.calls.every(x=>x.url.startsWith('/api/ytdl?')));
});

test('HUMAN_REQUIRED pauses automatically, resets verification, preserves prior ranges and retries the same request',async()=>{
  let denied=false,notified=0;
  const o=origin({before:(call,n)=>{if(n===2&&!denied){denied=true;return Response.json({error:'expired',code:'HUMAN_REQUIRED'},{status:403});}}});
  const api=load(o.fetch),c=api.createControl({onHumanExpired:e=>{assert.equal(e.code,'HUMAN_REQUIRED');notified++;}});
  const p=api.getProxy('/file',null,()=>{},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);await c.resume();await matches(await p,o.bytes);
  assert.equal(notified,1);assert.equal(o.calls.filter(x=>x.range==='bytes=0-15').length,1);
});

test('cancel while paused settles all waiting audio/video promises and releases sources',async()=>{
  const o=origin(),api=load(o.fetch),c=api.createControl();c.pause();
  const a=api.getProxy('/v',null,()=>{},c),b=api.getProxy('/a',null,()=>{},c);
  const checks=Promise.all([assert.rejects(a,{code:'DOWNLOAD_CANCELLED'}),assert.rejects(b,{code:'DOWNLOAD_CANCELLED'})]);
  c.cancel();await checks;assert.equal(o.calls.length,0);assert.equal(o.live,0);
});

test('cancel during re-verification cannot restart a cancelled download',async()=>{
  const o=origin(),api=load(o.fetch);let resolve;
  const c=api.createControl({beforeResume:()=>new Promise(r=>{resolve=r;})});c.pause();
  const p=api.getProxy('/file',null,()=>{},c),check=assert.rejects(p,{code:'DOWNLOAD_CANCELLED'});
  const resume=c.resume();c.cancel();resolve();await resume;await check;assert.equal(o.calls.length,0);
});

for(const [name,options,code] of [
  ['ignored range on resume',{ignore:(_,n)=>n>1},'RANGE_UNSUPPORTED'],
  ['changed ETag',{etag:(_,n)=>n>1?'"changed"':'"same-file"'},'FILE_CHANGED'],
  ['wrong range start',{contentRange:(_,n)=>n>1?'bytes 0-15/96':undefined},'RANGE_INVALID'],
  ['changed total',{contentRange:(c,n)=>n>1?`bytes ${c.range.match(/=(\d+)/)[1]}-15/99`:undefined},'FILE_CHANGED'],
  ['no validators',{noValidator:true},'RESUME_UNSAFE']
]) test(`${name} fails closed rather than appending a corrupt file`,async()=>{
  const o=origin(options),api=load(o.fetch);let paused=false;
  const c=api.createControl(),p=api.getProxy('/file',null,n=>{if(n>=6&&!paused){paused=true;c.pause();}},c);
  const check=assert.rejects(p,{code});
  await until(()=>c.state==='paused');await until(()=>o.live===0);await c.resume();await check;await until(()=>o.live===0);
});

test('transient dropped connection resumes bytes without duplication',async()=>{
  const o=origin({breakAt:6}),api=load(o.fetch);
  await matches(await api.getProxy('/file',null,()=>{}),o.bytes);assert.equal(o.calls[1].range,'bytes=6-15');
});

test('Last-Modified is an allowed If-Range fallback; weak ETags alone are not',async()=>{
  const o=origin({lastModified:true}),api=load(o.fetch);let paused=false;
  const c=api.createControl(),p=api.getProxy('/file',null,n=>{if(n>=6&&!paused){paused=true;c.pause();}},c);
  await until(()=>c.state==='paused');await until(()=>o.live===0);await c.resume();await matches(await p,o.bytes);
  assert.equal(o.calls[1].ifRange,'Mon, 16 Nov 2026 00:00:00 GMT');
  const weak=origin({etag:()=> 'W/"weak"'}),api2=load(weak.fetch);let paused2=false;
  const c2=api2.createControl(),p2=api2.getProxy('/file',null,n=>{if(n>=6&&!paused2){paused2=true;c2.pause();}},c2);
  const check=assert.rejects(p2,{code:'RESUME_UNSAFE'});
  await until(()=>c2.state==='paused');await c2.resume();await check;
});

test('servers that ignore initial Range still support ordinary one-shot download',async()=>{
  const o=origin({ignore:()=>true}),api=load(o.fetch);await matches(await api.getProxy('/file',null,()=>{}),o.bytes);assert.equal(o.calls.length,1);
});

test('permanent failure in one stream aborts its sibling and leaves no active source',async()=>{
  const o=origin({before:call=>call.url==='/bad'?Response.json({error:'database down',code:'STORAGE_UNAVAILABLE'},{status:503}):null});
  const api=load(o.fetch),c=api.createControl();
  const p=Promise.allSettled([api.getProxy('/good',null,()=>{},c),api.getProxy('/bad',null,()=>{},c)]);
  const results=await p;assert.ok(results.every(x=>x.status==='rejected'));assert.ok(results.every(x=>x.reason.code==='STORAGE_UNAVAILABLE'));await until(()=>o.live===0);
});

test('no-validator and no-range sources explicitly report that pause is unavailable',async()=>{
  for(const options of [{noValidator:true},{ignore:()=>true}]){
    const o=origin(options),api=load(o.fetch);let note='';
    const c=api.createControl({onCapability:message=>{note=message;}});
    await matches(await api.getProxy('/file',null,()=>{},c),o.bytes);
    assert.equal(c.resumable,false);assert.match(note,/无法|只能/);
  }
});

test('cancellation settles initial verification guards immediately, even if verification never returns',async()=>{
  const api=load(()=>assert.fail('no network expected')),c=api.createControl();
  const p=c.guard(new Promise(()=>{})),check=assert.rejects(p,{code:'DOWNLOAD_CANCELLED'});
  c.cancel();await check;
});

function ui(fetch,extra={}){
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),elements={},errors=[],saved=[];
  const context={window:{YTFetch:load(fetch),addEventListener:()=>{}},document:{getElementById:id=>elements[id] ||= {style:{},textContent:'',disabled:false}},
    ensureHumanPass:async()=>{},humanDone:()=>false,showError:m=>errors.push(m),humanMsg:e=>e.message,
    ytdlProxyUrl:()=>'/file',setParseBtn:()=>{},__hkHideBtn:()=>{},resetDlProg:()=>{},hideDlProg:()=>{},resetParseBtn:()=>{},
    __hkSave:(b,n)=>saved.push({blob:b,name:n}),setDlProg:()=>{},isDirectLimited:()=>false,formatDlError:e=>e.message,...extra};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('  var activeDownload = null;'),html.indexOf('  // 下载完成后保存')),context);
  vm.runInContext(html.slice(html.indexOf('  function downloadResource('),html.indexOf('  // 直链里带 itag')),context);
  return {context,elements,errors,saved};
}

test('real single-download UI buttons pause, resume after verification, and save identical bytes',async()=>{
  const o=origin();let paused=false,verified=0,x;
  x=ui(o.fetch,{ensureHumanPass:async()=>{verified++;},setDlProg:n=>{if(n>=6&&!paused){paused=true;x.elements.dlPause.onclick();}}});
  x.context.downloadResource('https://media.example/file','test.mp4');
  await until(()=>x.context.activeDownload?.state==='paused');await until(()=>o.live===0);
  assert.equal(x.elements.dlPause.textContent,'继续下载');assert.match(x.elements.dlProgTxt.textContent,/已暂停/);
  x.elements.dlPause.onclick();await until(()=>x.saved.length===1);
  await matches(x.saved[0].blob,o.bytes);assert.equal(verified,2);assert.equal(x.context.activeDownload,null);assert.equal(x.elements.dlControls.style.display,'none');
});

test('UI prevents a second download from replacing a paused one and cancel unlocks it',async()=>{
  const o=origin(),x=ui(o.fetch);const c=x.context.beginDownload();c.pause();
  assert.equal(x.context.beginDownload(),null);assert.equal(x.context.activeDownload,c);assert.equal(x.errors.length,1);
  x.elements.dlCancel.onclick();assert.equal(c.state,'failed');x.context.finishDownload(c);
  assert.ok(x.context.beginDownload());
});

test('initial verification cancellation immediately unlocks UI without starting media',async()=>{
  const x=ui(()=>assert.fail('media must not start'),{ensureHumanPass:()=>new Promise(()=>{})});
  x.context.downloadResource('url','test.mp4');x.elements.dlCancel.onclick();
  await until(()=>x.context.activeDownload===null);assert.equal(x.saved.length,0);
});

test('direct-limit fallback runs only after clearing the failed download session',async()=>{
  let fallback=0,x;
  x=ui(async()=>Response.json({code:'DIRECT_LIMITED',error:'limited'},{status:502}),{
    isDirectLimited:e=>e.code==='DIRECT_LIMITED',autoServerMerge:()=>{assert.equal(x.context.activeDownload,null);fallback++;return true;}
  });
  x.context.downloadResource('url','test.mp4','IOS',{v:'dQw4w9WgXcQ',height:1080});
  await until(()=>fallback===1);assert.equal(x.saved.length,0);
});

test('rapid pause/resume cycles do not duplicate bytes or orphan an aborted request',async()=>{
  const o=origin({length:160}),api=load(o.fetch);let cycles=0;
  const c=api.createControl(),p=api.getProxy('/file',null,n=>{
    if(cycles<4&&n>=6+cycles*15){ cycles++;c.pause();void c.resume(); }
  },c);
  await matches(await p,o.bytes);assert.equal(cycles,4);assert.equal(o.live,0);
});

test('416 is terminal instead of retrying the same impossible range',async()=>{
  const o=origin({before:()=>new Response('',{status:416})}),api=load(o.fetch);
  await assert.rejects(api.getProxy('/file',null,()=>{}),{code:'RANGE_NOT_SATISFIABLE'});assert.equal(o.calls.length,1);
});

test('actual D1 stream leases are released on pause and resumed ranges reuse one counted task',async()=>{
  const {sqliteD1}=await import('./helpers/d1.mjs');
  const {ytdlReserve,ytdlLeasedResponse}=await import('../_worker.js');
  const d=sqliteD1(),o=origin({length:160}),slots=()=>d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'yds:%'").get().c;
  let paused=false,maxSlots=0;
  const api=load(async(url,init)=>{
    const request=new Request('https://youtubejiexisite.pages.dev/api/ytdl',{headers:{...init.headers,'CF-Connecting-IP':'203.0.113.77'},signal:init.signal});
    const lease=await ytdlReserve(request,{PARSE_DB:d},'v:resume-test');assert.ok(!lease.deny);
    maxSlots=Math.max(maxSlots,slots());
    return ytdlLeasedResponse(await o.fetch(url,init),lease,request);
  });
  const c=api.createControl(),p=api.getProxy('/file',null,n=>{if(n>=40&&!paused){paused=true;c.pause();}},c);
  await until(()=>c.state==='paused');await until(()=>slots()===0);await until(()=>o.live===0);
  assert.ok(maxSlots>1&&maxSlots<=3);await c.resume();await matches(await p,o.bytes);await until(()=>slots()===0);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'ydt:%'").get().c,1);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS c FROM rate_counter WHERE k LIKE 'youtube:%' OR k LIKE 'ytx:%'").get().c,0);
});

// This joins the real download controls and actual humanReady/ensureHumanPass, not a no-op verification mock.
test('real resume UI reveals expired verification, preserves partials, then saves the exact file',async()=>{
  const h=humanUI({used:true});await h.init();h.run('tsPassUntil = Date.now() + 60000');
  const o=origin();let paused=false,x;
  x=ui(o.fetch,{ensureHumanPass:h.ctx.ensureHumanPass,setDlProg:n=>{if(n>=6&&!paused){paused=true;x.elements.dlPause.onclick();}}});
  x.context.downloadResource('https://media.example/file','test.mp4');
  await until(()=>x.context.activeDownload?.state==='paused');await until(()=>o.live===0);
  h.run('tsPassUntil = Date.now() - 1');const oldCalls=o.calls.length;
  x.elements.dlPause.onclick();await h.flush();
  assert.equal(x.context.activeDownload.state,'verifying');assert.equal(h.scrolls,1);
  assert.equal(o.calls.length,oldCalls,'no resumed media before verification');
  await h.solve();await until(()=>x.saved.length===1);
  await matches(x.saved[0].blob,o.bytes);
  assert.ok(o.calls.slice(oldCalls).some(c=>/^bytes=[1-9]/.test(c.range)&&c.ifRange==='"same-file"'));
  assert.equal(h.calls.filter(c=>c.url.startsWith('/api/human-pass')).length,2);
  assert.equal(h.calls.some(c=>/api\/parse|yt1080-start/.test(c.url)),false);
});
