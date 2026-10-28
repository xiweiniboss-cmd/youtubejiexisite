// 浏览器内合并：ffmpeg.wasm 只做 -c copy 封装，不重新编码
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
  // video, audio: Blob；返回合并后的 mp4 Blob
  async function merge(video, audio, onStage){
    var ff = await getFF(onStage);
    onStage && onStage('正在合并音视频…');
    var vExt = /webm/i.test(video.type) ? 'webm' : 'mp4', aExt = /webm|opus/i.test(audio.type) ? 'webm' : 'm4a';
    await ff.writeFile('v.' + vExt, new Uint8Array(await video.arrayBuffer()));
    await ff.writeFile('a.' + aExt, new Uint8Array(await audio.arrayBuffer()));
    var prog = function(e){ onStage && onStage('正在合并音视频… ' + Math.max(0, Math.min(100, Math.round(e.progress * 100))) + '%'); };
    ff.on('progress', prog);
    var code = await ff.exec(['-i', 'v.' + vExt, '-i', 'a.' + aExt, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', 'out.mp4']);
    ff.off('progress', prog);
    try { await ff.deleteFile('v.' + vExt); await ff.deleteFile('a.' + aExt); } catch (e) {}
    if (code !== 0) throw new Error('合并失败（ffmpeg ' + code + '）');
    var data = await ff.readFile('out.mp4');
    try { await ff.deleteFile('out.mp4'); } catch (e) {}
    return new Blob([data.buffer], { type: 'video/mp4' });
  }
  return { merge: merge, preload: getFF };
})();

// 分段下载（经 /api/ytdl 代理 + Range）：googlevideo 对无声 1080P 整段下载会限速，分段并发快很多。
// spec = {v, itag, client} 时每次 Range 都让 Worker 在同一次请求里重新签发直链，避免 ip= 和出口对不上。
window.YTFetch = (function(){
  var CH = 8 * 1024 * 1024, PAR = 3;
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
  async function getRange(proxyUrl, s, e){
    var res = await fetch(proxyUrl, { headers: { Range: 'bytes=' + s + '-' + e } });
    if (!(res.status === 206 || res.status === 200)) {
      var msg = 'HTTP ' + res.status;
      try {
        var t = await res.text();
        var j = JSON.parse(t);
        if (j && j.error) msg = String(j.error);
      } catch (err) {}
      throw new Error(msg);
    }
    return res;
  }
  async function readAll(res, onChunk){
    var rd = res.body.getReader(), parts = [];
    for(;;){ var r = await rd.read(); if (r.done) break; parts.push(r.value); onChunk(r.value.length); }
    return parts;
  }
  // 返回 Blob；onProg(本文件已收字节, 本文件总字节)
  // spec 跟这一路流绑定，视频和音频并行时不能共用一个全局参数。
  async function get(u, type, onProg, ua, spec){
    var proxyUrl = proxyFor(u, ua || '', spec || null);
    var got = 0, total = 0;
    var first = await getRange(proxyUrl, 0, CH - 1);
    var cr = first.headers.get('Content-Range') || '';
    var m = cr.match(/\/(\d+)\s*$/);
    if (first.status === 200 || !m) {           // 不支持 Range：整段读
      total = +first.headers.get('Content-Length') || 0;
      var all = await readAll(first, function(n){ got += n; onProg(got, total); });
      return new Blob(all, { type: type });
    }
    total = +m[1];
    var slots = [];
    slots[0] = await readAll(first, function(n){ got += n; onProg(got, total); });
    var jobs = [];
    for (var s = CH, k = 1; s < total; s += CH, k++) jobs.push({ k: k, s: s, e: Math.min(total, s + CH) - 1 });
    async function worker(){
      while (jobs.length) {
        var j = jobs.shift(), tries = 0;
        for(;;){
          var mine = 0;
          try { var res = await getRange(proxyUrl, j.s, j.e); slots[j.k] = await readAll(res, function(n){ mine += n; got += n; onProg(got, total); }); break; }
          catch (err) { got -= mine; if (++tries >= 3) throw err; await new Promise(function(r){ setTimeout(r, 800 * tries); }); }
        }
      }
    }
    var ws = []; for (var i = 0; i < PAR; i++) ws.push(worker());
    await Promise.all(ws);
    var flat = []; slots.forEach(function(p){ flat = flat.concat(p); });
    return new Blob(flat, { type: type });
  }
  return { get: get };
})();
