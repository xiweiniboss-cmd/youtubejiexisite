// 浏览器内合并：画面始终 -c copy；音频是 AAC 就 copy，不是（Opus/Vorbis 等）就只把音频转成 AAC。
// iPhone 相册不认 MP4 里的 Opus，只转音频很快（3 分钟歌大约几秒）。
window.YTMerge = (function(){
  var CORE_VER = '0.12.10', FF_BASE = window.YT_FF_BASE || '/ffmpeg/';
  var CDNS = window.YT_FF_CDNS || ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];
  var _ff = null;
  async function blobURL(url, type, onProg){
    var res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    var total = +res.headers.get('Content-Length') || 0, got = 0, chunks = [], rd = res.body.getReader();
    for(;;){ var r = await rd.read(); if (r.done) break; chunks.push(r.value); got += r.value.length; onProg && onProg(got, total); }
    return URL.createObjectURL(new Blob(chunks, { type: type }));
  }
  async function getFF(onStage){
    if (_ff) return _ff;
    onStage && onStage('加载合并组件…');
    var mod = await import(FF_BASE + 'index.js');       // @ffmpeg/ffmpeg ESM，同源托管（module worker 不能跨域）
    var lastErr;
    for (var i = 0; i < CDNS.length; i++) {
      try {
        var base = CDNS[i] + '@ffmpeg/core@' + CORE_VER + '/dist/esm/';
        var coreURL = await blobURL(base + 'ffmpeg-core.js', 'text/javascript');
        var wasmURL = await blobURL(base + 'ffmpeg-core.wasm', 'application/wasm', function(g, t){
          onStage && onStage('首次使用，下载合并组件 ' + (t ? Math.round(g / t * 100) + '%' : (g / 1048576).toFixed(1) + 'MB') + '（约 31MB）');
        });
        var ff = new mod.FFmpeg();
        await ff.load({ coreURL: coreURL, wasmURL: wasmURL });
        _ff = ff; return ff;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('合并组件加载失败');
  }
  // 看文件头判断音频是不是 AAC：调用方传进来的 type 不可信（YTFetch 一律标 audio/mp4）。
  // WebM/Matroska（EBML 头）、Ogg、或 MP4 里出现 Opus/fLaC/ac-3/ec-3 样本描述，都当非 AAC。
  async function sniffAudio(blob){
    var head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return { ext: 'webm', aac: false };
    if (head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return { ext: 'ogg', aac: false };
    var txt = ''; for (var i = 0; i < head.length; i++) txt += String.fromCharCode(head[i]);
    if (/Opus|fLaC|ac-3|ec-3/.test(txt)) return { ext: 'm4a', aac: false };
    return { ext: 'm4a', aac: true };
  }
  async function sniffVideoExt(blob){
    var head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) ? 'webm' : 'mp4';
  }
  // video, audio: Blob；返回合并后的 mp4 Blob
  async function merge(video, audio, onStage){
    var ff = await getFF(onStage);
    var ai = await sniffAudio(audio);
    onStage && onStage(ai.aac ? '正在合并音视频…' : '正在合并音视频（声音转成 AAC）…');
    var vExt = await sniffVideoExt(video), aExt = ai.ext;
    await ff.writeFile('v.' + vExt, new Uint8Array(await video.arrayBuffer()));
    await ff.writeFile('a.' + aExt, new Uint8Array(await audio.arrayBuffer()));
    var prog = function(e){ onStage && onStage('正在合并音视频… ' + Math.max(0, Math.min(100, Math.round(e.progress * 100))) + '%'); };
    ff.on('progress', prog);
    var aArgs = ai.aac ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
    var code, data;
    try {
      code = await ff.exec(['-i', 'v.' + vExt, '-i', 'a.' + aExt, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy'].concat(aArgs, ['-movflags', '+faststart', 'out.mp4']));
      if (code !== 0) throw new Error('合并失败（ffmpeg ' + code + '）');
      data = await ff.readFile('out.mp4');
    } finally {
      // exec 抛异常（内存不够、被中断）时也要解绑进度回调、删掉临时文件，否则下一次合并会串进度、占内存。
      ff.off('progress', prog);
      var tmp = ['v.' + vExt, 'a.' + aExt, 'out.mp4'];
      for (var k = 0; k < tmp.length; k++) { try { await ff.deleteFile(tmp[k]); } catch (e) {} }
    }
    return new Blob([data.buffer], { type: 'video/mp4' });
  }
  return { merge: merge, preload: getFF };
})();

// 可暂停的内存分段下载：仅当前页面有效；已收字节保留，暂停会中断所有活动请求。
// 不把忽略 Range 的 200 或变化的表示拼接到旧文件上。
window.YTFetch = (function(){
  var CH = 8 * 1024 * 1024, PAR = 3;
  function error(message, code){ var e = new Error(message); if(code) e.code = code; return e; }
  function createControl(options){
    options = options || {};
    var revision=0, resumable=true, rejectCancelled;
    var cancelled=new Promise(function(_,reject){ rejectCancelled=reject; });
    cancelled.catch(function(){});
    var state = 'running', reason = null, active = new Set(), readers = new Set(), waiters = [], resuming = false;
    function emit(message){ if(options.onState) options.onState(state, message || ''); }
    function wake(){ var ws=waiters.splice(0); ws.forEach(function(w){ w(); }); }
    function abort(){ active.forEach(function(c){ c.abort(); }); readers.forEach(function(r){ r.cancel().catch(function(){}); }); }
    var control = {
      get state(){ return state; },
      get reason(){ return reason; },
      get revision(){ return revision; },
      get resumable(){ return resumable; },
      noResume: function(message){ resumable=false; if(options.onCapability) options.onCapability(message); },
      pause: function(message){ if(state !== 'running') return; state='paused'; revision++; abort(); emit(message); },
      resume: async function(){
        if(state !== 'paused' || resuming) return;
        resuming=true; state='verifying'; emit();
        try {
          if(options.beforeResume) await control.guard(options.beforeResume());
          if(state !== 'verifying') return;
          state='running'; emit(); wake();
        } catch(e){ if(state === 'verifying'){ state='paused'; emit(e.message || '请完成验证后再点继续'); } }
        finally { resuming=false; }
      },
      expired: function(e){ if(options.onHumanExpired) options.onHumanExpired(e); control.pause('验证已过期，请完成验证后点继续'); },
      guard: function(promise){ return Promise.race([promise,cancelled]); },
      cancel: function(){ control.fail(error('下载已取消', 'DOWNLOAD_CANCELLED')); },
      fail: function(e){ if(state==='done' || state==='failed') return; reason=e; state='failed'; rejectCancelled(e); abort(); wake(); emit(e.message); },
      finish: function(){ if(state==='failed') return; state='done'; wake(); emit(); },
      ready: async function(){
        while(state==='paused' || state==='verifying') await new Promise(function(resolve){ waiters.push(resolve); });
        if(reason) throw reason;
        if(state==='done') throw error('下载已经结束');
      },
      add: function(c){ active.add(c); if(state!=='running') c.abort(); },
      remove: function(c){ active.delete(c); },
      reader: function(r){ readers.add(r); if(state!=='running') r.cancel().catch(function(){}); },
      unreader: function(r){ readers.delete(r); }
    };
    return control;
  }
  function proxyFor(u, ua, spec){
    if (spec && spec.v && spec.itag) {
      var q = '/api/ytdl?v=' + encodeURIComponent(spec.v) + '&itag=' + encodeURIComponent(spec.itag);
      if (spec.client || ua) q += '&client=' + encodeURIComponent(spec.client || ua);
      q += '&filename=part.bin';
      if (ua) q += '&ua=' + encodeURIComponent(ua);
      if (u) q += '&url=' + encodeURIComponent(u);
      return q;
    }
    return '/api/ytdl?url=' + encodeURIComponent(u) + '&filename=part.bin' + (ua ? '&ua=' + encodeURIComponent(ua) : '');
  }
  async function responseError(res){
    var msg='HTTP '+res.status, code=res.status===416 ? 'RANGE_NOT_SATISFIABLE' : '';
    try { var j=JSON.parse(await res.text()); if(j.error) msg=String(j.error); if(j.code) code=String(j.code); } catch(e){}
    return error(msg,code);
  }
  function validator(res){
    var tag=res.headers.get('ETag');
    if(tag && !/^W\//i.test(tag)) return {name:'ETag',value:tag};
    var date=res.headers.get('Last-Modified');
    return date ? {name:'Last-Modified',value:date} : null;
  }
  async function getProxy(proxyUrl, type, onProg, control){
    control=control || createControl(); onProg=onProg || function(){};
    var got=0, total=null, identity=null, known=false, ranged=false, slots=[];
    function progress(){ onProg(got,total || 0); }
    async function part(job){
      var failures=0;
      while(job.end===null || job.start+job.bytes<=job.end){
        await control.ready();
        var offset=job.start+job.bytes;
        if(known && (job.bytes>0 || (control.revision>0 && got>0)) && !identity) throw error('上游未提供文件校验信息，无法安全续传，请取消后重新下载', 'RESUME_UNSAFE');
        var controller=new AbortController(), reader=null, res=null;
        control.add(controller);
        try {
          var headers={Range:'bytes='+offset+'-'+(job.end===null?'':job.end)};
          if(identity) headers['If-Range']=identity.value;
          res=await fetch(proxyUrl,{headers:headers,signal:controller.signal,credentials:'same-origin'});
          if(!res.ok) throw await responseError(res);
          var cr=(res.headers.get('Content-Range') || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          var v=validator(res);
          if(res.status===206){
            if(!cr || ![+cr[1],+cr[2],+cr[3]].every(Number.isSafeInteger) || +cr[1]!==offset || +cr[2]<offset || +cr[2]>=+cr[3] || (job.end!==null && +cr[2]>job.end)) throw error('下载分段范围不一致，已停止以防文件损坏','RANGE_INVALID');
            if(known && total!==+cr[3]) throw error('下载文件已变化，请取消后重新下载','FILE_CHANGED');
            if(!known){ total=+cr[3]; if(total>CH*512) throw error('文件超过单任务分段上限','DOWNLOAD_TOO_LARGE'); ranged=true; job.end=Math.min(job.end,total-1); }
            else if(+cr[2]!==job.end) throw error('下载分段不完整，已停止以防文件损坏','RANGE_INVALID');
          } else if(res.status===200 && offset===0 && !known){
            total=Number(res.headers.get('Content-Length')) || null;
            ranged=false; job.end=total===null ? null : total-1;
          } else { throw error('服务器未按断点返回文件，无法安全续传，请取消后重新下载','RANGE_UNSUPPORTED'); }
          if(known && identity && res.headers.get(identity.name)!==identity.value) throw error('下载文件校验已变化，请取消后重新下载','FILE_CHANGED');
          if(!known){ identity=v; known=true; if(!identity || !ranged) control.noResume('此下载源未提供安全续传所需的范围或校验信息，只能下载完成或取消。'); if(!type) type=res.headers.get('Content-Type') || 'video/mp4'; }
          progress();
          reader=res.body && res.body.getReader ? res.body.getReader() : null;
          if(!reader) throw error('浏览器不支持流式下载');
          control.reader(reader);
          for(;;){
            var r=await reader.read();
            if(controller.signal.aborted || control.state!=='running') throw error('已暂停','PAUSED');
            if(r.done) break;
            var n=r.value.byteLength;
            if(job.end!==null && job.start+job.bytes+n>job.end+1) throw error('下载分段长度错误','RANGE_INVALID');
            job.chunks.push(r.value); job.bytes+=n; got+=n; progress();
          }
          if(job.end===null){ job.end=job.start+job.bytes-1; total=job.bytes; progress(); return; }
          if(job.start+job.bytes!==job.end+1) throw error('下载连接提前结束');
          return;
        } catch(e){
          if(control.reason) throw control.reason;
          if(controller.signal.aborted || control.state==='paused' || control.state==='verifying') continue;
          if(/^HUMAN_/.test(e.code || '')){ control.expired(e); continue; }
          if(e.code || ++failures>=3) throw e;
        } finally {
          if(reader){ control.unreader(reader); try{ await reader.cancel(); }catch(e){} try{ reader.releaseLock(); }catch(e){} }
          else if(res && res.body){ try{ await res.body.cancel(); }catch(e){} }
          controller.abort(); control.remove(controller);
        }
      }
    }
    try {
      var first={start:0,end:CH-1,bytes:0,chunks:[]}; slots.push(first);
      await part(first);
      if(ranged && total>CH){
        var jobs=[];
        for(var start=CH;start<total;start+=CH){ var j={start:start,end:Math.min(total,start+CH)-1,bytes:0,chunks:[]}; slots.push(j); jobs.push(j); }
        async function worker(){ while(jobs.length){ var job=jobs.shift(); await part(job); } }
        var ws=[], parallel=Math.min(PAR,jobs.length); for(var i=0;i<parallel;i++) ws.push(worker());
        await Promise.all(ws);
      }
      var flat=[]; slots.forEach(function(j){ flat=flat.concat(j.chunks); j.chunks=[]; });
      if(total!==null && got!==total) throw error('下载文件长度不完整','RANGE_INVALID');
      return new Blob(flat,{type:type || 'video/mp4'});
    } catch(e){ control.fail(e); slots.forEach(function(j){ j.chunks=[]; }); throw e; }
  }
  async function get(u,type,onProg,ua,spec,control){ return getProxy(proxyFor(u,ua || '',spec || null),type,onProg,control); }
  return {get:get,getProxy:getProxy,createControl:createControl};
})();
