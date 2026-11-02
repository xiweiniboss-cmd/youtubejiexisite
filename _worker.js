// YouTube 解析下载站（Cloudflare Pages 单文件 Worker）
// 根目录放 _worker.js：/api/* 走这里，其余走 env.ASSETS 静态资源
// 解析通道：RedFoxHub /story/api/parseWork/videoDownload/youtube
// 需要环境变量 REDFOX_API_KEY（与小红书/抖音站同一个 key，直接复用）
// 反馈系统：KV 绑定 FEEDBACK_KV、R2 绑定 FEEDBACK_BUCKET、环境变量 FEEDBACK_ADMIN_KEY
//   （与小红书站/TikTok站/抖音站共用同一套 KV/R2/管理密码）
// 人机验证：TURNSTILE_SITE_KEY（公开）+ TURNSTILE_SECRET_KEY（保密），各站共用同一套
// 高清直连 /api/yt-hd（都不写进仓库，只在 Pages → Settings → Environment variables 配加密变量）：
//   YT_COOKIES   已登录 youtube.com 的 Cookie（请求头 "a=b; c=d"，或 Netscape cookies.txt，或 [{name,value}] JSON）。别名 YT_COOKIE
//   YT_PO_TOKEN  可选。InnerTube player 的 PO Token，放进 serviceIntegrityDimensions.poToken。别名 YT_POT
//                这是 player token，不会写进 googlevideo 的 pot 参数，也绝不能在代码里伪造。
//                数据中心 IP 上，部分视频（例如音乐/现场）会间歇性返回「Sign in to confirm you're not a bot」，
//                或者匿名客户端最多只给到 720P。要稳定拿到 1080P，把真实 player PO Token 配进 YT_PO_TOKEN 后重新部署。
//                生成方式见 yt-dlp PO Token 指南里的 player token（https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide）。
//                /api/diag 的 hasYtPoToken 只在该变量去空白后非空时为 true，不会回显内容。
// 服务器合并 /api/yt1080-*（前端不持有口令，由 Worker 转发）：
//   YT_MERGE_TOKEN  与 EC2 合并服务口令一致；不配则接口直接说明未配置
//   YT_MERGE_BASE   EC2 根地址，默认 http://3-129-45-49.sslip.io:30002
// 服务器状态 /api/server-status（前端「服务器状态」卡片）：Worker 请求 EC2 的
//   GET {YT_MERGE_BASE}/status   请求头 X-Merge-Token: <YT_MERGE_TOKEN>（与 /yt1080-jobs 相同鉴权），超时 5 秒
//   期望返回 200 JSON：
//   {"ok":true,"mem":{"total":字节,"used":字节},"cpu":{"load1":f,"load5":f,"load15":f,"cores":n},
//    "disk":{"total":字节,"used":字节},"uptimeSec":n,"jobs":{"running":n,"queued":n}}
//   Worker 只取这些字段并转成数字，自己算百分比（CPU = load1/cores*100，封顶 100），口令不会回传。
//   旧版 EC2 没有 /status 返回 404 时视为「在线但未提供详细状态」（statusSupported:false）。
//   结果在边缘缓存约 15 秒。/api/ping 只给浏览器测「你→本站」延迟。
// 年龄限制看 playabilityStatus.reason，不要只看 status：LOGIN_REQUIRED 也会是「Sign in to confirm you're not a bot」。

const REDFOX_BASE = 'https://redfox.hk';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// Cloudflare Turnstile 人机验证：secret 配了才校验，不配则跳过（向后兼容）
async function verifyTurnstile(token, secret, ip) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    const j = await resp.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}

// ---------- RedFoxHub ----------
async function redfoxPost(path, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(REDFOX_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        REDFOX_API_KEY: apiKey,
        'X-API-KEY': apiKey,
        'User-Agent': UA_PC,
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...body, source: 'youtube-dl-pages' }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('RedFoxHub 返回了非 JSON 数据（HTTP ' + resp.status + '）');
    }
    if (resp.status === 401)
      throw new Error('RedFoxHub API Key 无效，请检查环境变量 REDFOX_API_KEY 是否正确');
    if (resp.status === 429) throw new Error('请求太频繁，请稍后重试');
    const code = j.code;
    const msg = String(j.msg || j.message || '');
    // 成功码以 2 开头（如 200、2000），其余为错误
    if (code !== undefined && code !== null && !String(code).startsWith('2')) {
      if (code === 401 || code === 4001 || code === 3106 || code === 3107)
        throw new Error('RedFoxHub 鉴权失败：' + (msg || '请检查 REDFOX_API_KEY'));
      if (/余额|balance|insufficient|欠费/i.test(msg))
        throw new Error('RedFoxHub 余额不足，请前往 redfox.hk 控制台充值后再试');
      throw new Error('RedFoxHub：' + (msg || 'code=' + code));
    }
    if (!resp.ok) throw new Error('RedFoxHub 请求失败（HTTP ' + resp.status + '）' + (msg ? '：' + msg : ''));
    return j.data !== undefined ? j.data : j;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 链接处理 ----------
function extractYoutubeUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[.,;!?\]]+$/, '') : null;
}

// 提取 video id，支持 watch?v=、youtu.be/、shorts/、embed/、music.youtube.com 等
function extractVideoId(url) {
  const s = String(url || '');
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = s.match(/youtube\.com\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

// ---------- 结果提取 ----------
// YouTube 返回 resources: [{type, durationSeconds, downloadUrl, coverUrl}]
// 保留 type/duration 信息供前端展示清晰度
function ensureHttps(u) {
  if (typeof u !== 'string') return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}
function extractResources(data) {
  const out = [];
  const seen = new Set();
  const list = data.resources || data.resource || data.medias || [];
  if (Array.isArray(list)) {
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const url = ensureHttps(r.downloadUrl || r.download_url || r.url || '');
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        type: String(r.type || 'video'),
        duration: typeof r.durationSeconds === 'number' ? r.durationSeconds : null,
        cover: ensureHttps(r.coverUrl || r.cover_url || ''),
      });
    }
  }
  // 兼容：没有 resources 数组时从顶层字段兜底
  if (!out.length) {
    for (const k of ['videoUrl', 'video_url', 'downloadUrl', 'download_url', 'url']) {
      const url = ensureHttps(data[k] || '');
      if (typeof url === 'string' && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ url, type: 'video', duration: null, cover: '' });
      }
    }
  }
  return out;
}

async function parseYoutubeViaRedFox(shareText, apiKey, debug) {
  const rawUrl = extractYoutubeUrl(shareText);
  if (!rawUrl) throw new Error('没找到有效的链接，请粘贴 YouTube 分享链接');
  if (!/youtu\.?be/i.test(rawUrl)) throw new Error('这不是 YouTube 链接，请检查后重试');

  const videoId = extractVideoId(rawUrl);
  const canonical = videoId ? 'https://www.youtube.com/watch?v=' + videoId : null;
  const routes = [];
  if (canonical) routes.push({ name: 'canonical', url: canonical });
  if (rawUrl !== canonical) routes.push({ name: 'raw', url: rawUrl });

  const dbg = debug ? { routes: [] } : null;
  let lastErr = null;
  for (const r of routes) {
    try {
      const data = await redfoxPost('/story/api/parseWork/videoDownload/youtube', apiKey, { url: r.url });
      const resources = extractResources(data || {});
      const title = data.desc || data.title || '';
      const cover = ensureHttps(data.cover || data.coverUrl || data.cover_url || '');
      if (dbg)
        dbg.routes.push({
          name: r.name,
          keys: data ? Object.keys(data) : [],
          resources: resources.length,
        });
      if (resources.length) {
        return {
          title: String(title).slice(0, 200),
          cover,
          videoId: videoId || '',
          resources,
          ...(debug ? { debug: dbg } : {}),
        };
      }
      lastErr = new Error('解析到了内容，但没找到可下载的地址（可能视频已删除或有地区限制）');
      if (dbg) dbg.routes[dbg.routes.length - 1].empty = true;
    } catch (e) {
      lastErr = e;
      if (dbg) dbg.routes.push({ name: r.name, error: String(e.message || e).slice(0, 120) });
    }
  }
  const err = new Error(lastErr ? lastErr.message : '解析失败，请稍后重试');
  if (debug) err.debug = dbg;
  throw err;
}

// ---------- 解析 ----------
async function handleParse(request, env) {
  const apiKey = (env.REDFOX_API_KEY || '').trim();
  if (!apiKey)
    return json(
      {
        ok: false,
        error:
          '未配置 RedFoxHub API Key：请去 redfox.hk 注册并在控制台「API密钥」创建一个 key（可与小红书/TikTok/抖音站复用同一个），然后在 Cloudflare Pages → Settings → Environment variables 添加 REDFOX_API_KEY（重新部署后生效）',
      },
      500
    );
  const reqUrl = new URL(request.url);
  const shareText = reqUrl.searchParams.get('url') || '';
  if (!shareText.trim()) return json({ ok: false, error: '请先粘贴 YouTube 分享链接' }, 400);
  const debug = reqUrl.searchParams.get('debug') === '1';

  // 解析接口人机验证（配了 TURNSTILE_SECRET_KEY 才生效）
  const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    const tsToken = reqUrl.searchParams.get('turnstile') || '';
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  // 解析冷却：同一 IP 60 秒内只能解析一次（防刷 API 烧积分）
  const PARSE_COOLDOWN_SECS = 60;
  const parseIp = request.headers.get('cf-connecting-ip') || '';
  if (parseIp && env.FEEDBACK_KV) {
    const lastTs = await env.FEEDBACK_KV.get('pcool_' + parseIp);
    if (lastTs) {
      const remain = PARSE_COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0) return json({ ok: false, error: `解析太频繁，请 ${remain} 秒后再试` }, 429);
    }
  }

  // 每日解析限额：同一设备每天最多 20 次（防换 IP 刷 API 烧积分），按北京时间算天
  const DAILY_LIMIT = 20;
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const parseUrl = new URL(request.url);
  const deviceId = parseUrl.searchParams.get('deviceId') || '';
  const quotaId = deviceId || parseIp;
  const quotaKey = 'dlimit_' + quotaId + '_' + bjDate;
  let usedToday = 0;
  if (parseIp && env.FEEDBACK_KV) {
    try { usedToday = Number((await env.FEEDBACK_KV.get(quotaKey)) || 0); } catch {}
    if (usedToday >= DAILY_LIMIT)
      return json({ ok: false, error: '今日解析次数已用完（20 次），明天再来吧' }, 429);
  }

  try {
    const result = await parseYoutubeViaRedFox(shareText, apiKey, debug);
    if (parseIp && env.FEEDBACK_KV)
      await env.FEEDBACK_KV.put('pcool_' + parseIp, String(Date.now()), {
        expirationTtl: PARSE_COOLDOWN_SECS,
      });
    // 本站解析次数统计（仅成功计数）
    if (env.FEEDBACK_KV) {
      try {
        const cur = Number((await env.FEEDBACK_KV.get('stats_parse_youtube')) || 0);
        await env.FEEDBACK_KV.put('stats_parse_youtube', String(cur + 1));
      } catch {}
    }
    // 每日限额计数（仅成功计数，48小时过期）
    if (parseIp && env.FEEDBACK_KV) {
      try {
        await env.FEEDBACK_KV.put(quotaKey, String(usedToday + 1), { expirationTtl: 172800 });
      } catch {}
    }
    // 解析者归属地分布（按站点+国家聚合）
    if (env.FEEDBACK_KV) {
      try {
        const cf = request.cf || {};
        const cc = String(cf.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
        const gk = 'geoparse_youtube_' + cc;
        const gc = Number((await env.FEEDBACK_KV.get(gk)) || 0);
        await env.FEEDBACK_KV.put(gk, String(gc + 1));
      } catch {}
    }
    // 最近解析记录（每站保留最近 20 条）
    if (env.FEEDBACK_KV) {
      try {
        const cf2 = request.cf || {};
        const hk = 'parsehist_youtube';
        let hist = [];
        try { hist = JSON.parse((await env.FEEDBACK_KV.get(hk)) || '[]'); } catch {}
        if (!Array.isArray(hist)) hist = [];
        hist.unshift({
          t: Date.now(),
          ip: parseIp,
          dev: deviceId || '',
          cc: String(cf2.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX',
          region: cf2.region || '',
          city: cf2.city || '',
        });
        await env.FEEDBACK_KV.put(hk, JSON.stringify(hist.slice(0, 20)));
      } catch {}
    }
    return json({ ok: true, ...result });
  } catch (e) {
    const body = { ok: false, error: e.message || '解析失败' };
    if (debug && e.debug) body.debug = e.debug;
    return json(body, 502);
  }
}

// ---------- YouTube 直链下载代理 ----------
// googlevideo 不发送 CORS 头，手机端 fetch 会被拦；由 Worker 中转后加 CORS 头返回。
// /api/yt-hd 返回的 media URL 带 ip=<当时的 Worker 出口>。另一次 /api/ytdl 可能从别的边缘出口出去，
// googlevideo 直接 403（进度条一闪就关）。带 v+itag（+client）时，在同一次请求里重新向 player 要直链再拉流。
// 同时带上解析时的 url= 时：重新签发失败或媒体 401/403/410，就在这一次请求里改拉那条直链。
// 只带 url= 的老下载仍走原来的透传。
function ytdlFilename(raw) {
  return String(raw || 'youtube_video.mp4').replace(/["\r\n]/g, '').slice(0, 80) || 'youtube_video.mp4';
}

function isAllowedMediaUrl(mediaUrl) {
  let target = null;
  try { target = new URL(mediaUrl); } catch { return false; }
  const allowed = /(^|\.)googlevideo\.com$|(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)ytimg\.com$/i;
  return /^https:$/.test(target.protocol) && allowed.test(target.hostname);
}

function ytdlFail(status, opts = {}) {
  const code = status || 0;
  const http = code ? '（HTTP ' + code + '）' : '';
  if (opts.both) {
    return json({
      ok: false,
      error: '直链失效' + http + '。重新签发和解析时的直链都失败了，请改用「服务器合并」。',
    }, 502);
  }
  if (!code) {
    return json({
      ok: false,
      error: '直链失效：没有拿到可下载的视频流。YouTube 可能把服务器当成了机器人，请改用「服务器合并」。',
    }, 502);
  }
  if (code === 401 || code === 403 || code === 410) {
    return json({
      ok: false,
      error: '直链失效（HTTP ' + code + '）。YouTube 限制了这条直链，请改用「服务器合并」。',
    }, 502);
  }
  return json({ ok: false, error: '下载失败（HTTP ' + code + '）' }, 502);
}

function ytdlMediaResponse(resp, filename) {
  const h = new Headers();
  h.set('Content-Type', resp.headers.get('content-type') || 'application/octet-stream');
  const len = resp.headers.get('content-length');
  if (len) h.set('Content-Length', len);
  const cr = resp.headers.get('content-range');
  if (cr) h.set('Content-Range', cr);
  h.set('Accept-Ranges', 'bytes');
  h.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
  h.set('Content-Disposition', 'attachment; filename="' + filename + '"');
  h.set('Cache-Control', 'no-store');
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status === 206 ? 206 : 200, headers: h });
}

function ytdlUpstreamHeaders(request, ua, extra) {
  const upHeaders = { 'User-Agent': ua || UA_PC, Accept: '*/*' };
  // 登录态客户端（WEB / MWEB / TVHTML5）签发的流，媒体请求也要带同一份 Cookie。
  if (extra?.cookie) {
    upHeaders.Cookie = extra.cookie;
    upHeaders.Referer = 'https://www.youtube.com/';
    upHeaders.Origin = 'https://www.youtube.com';
  }
  const range = request.headers.get('Range');
  if (range && /^bytes=\d+-\d*$/.test(range)) upHeaders.Range = range;
  return upHeaders;
}

// 先打 yt-hd 用过的那个客户端（通常一次就中）。没有直链再带 visitor 重试，然后换同组里的另外两个。
// 匿名客户端绝不附带 Cookie；Cookie 客户端才附带。
function ytdlResolveSteps(clientKey) {
  const named = YT_CLIENT_BY_KEY[String(clientKey || '').trim()] || null;
  const pool = named
    ? (YT_COOKIE_KEYS.has(named.key) ? YT_COOKIE_CLIENTS : YT_CLIENTS)
    : YT_CLIENTS.concat(YT_COOKIE_CLIENTS);
  const clients = [];
  if (named) clients.push(named);
  for (const c of pool) {
    if (!clients.some((x) => x.key === c.key)) clients.push(c);
  }
  const steps = [];
  if (clients[0]) {
    steps.push({ client: clients[0], withVisitor: false });
    steps.push({ client: clients[0], withVisitor: true });
  }
  for (const c of clients.slice(1, 3)) steps.push({ client: c, withVisitor: false });
  return steps;
}

async function ytdlResolveHit(vid, itag, step, auth) {
  const c = step.client;
  const useCookie = YT_COOKIE_KEYS.has(c.key) && !!auth.cookie;
  const cAuth = useCookie ? auth : { poToken: auth.poToken };
  const visitor = step.withVisitor
    ? await ytVisitorData({ cookie: useCookie ? auth.cookie : '', force: true })
    : '';
  const player = await ytPlayer(vid, c, visitor, cAuth);
  const fmt = findFormatByItag(player, itag);
  if (!fmt || !isAllowedMediaUrl(fmt.url)) return null;
  return { url: fmt.url, ua: c.ua, cookie: useCookie ? auth.cookie : '' };
}

async function ytdlReadMedia(request, mediaUrl, ua, cookie, signal) {
  const resp = await fetch(mediaUrl, {
    headers: ytdlUpstreamHeaders(request, ua, cookie ? { cookie } : undefined),
    signal,
  });
  return resp;
}

// fallbackUrl：解析当时的 googlevideo 直链。重新签发拿不到或媒体 401/403/410 时，同一次请求里再试这条。
// 有回退地址时只打一次 player，避免机器人墙把 YTFetch 的每个分段都拖住。
async function proxyResolvedYtDl(request, env, vid, itag, clientKey, filename, fallbackUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const fallbackOk = isAllowedMediaUrl(fallbackUrl);
  try {
    const auth = await ytAuthFromEnv(env || {});
    const steps = ytdlResolveSteps(clientKey);
    const plan = fallbackOk ? steps.slice(0, 1) : steps;
    let fetches = 0;
    let lastStatus = 0;
    for (const step of plan) {
      if (fetches >= 3) break;
      let hit = null;
      try { hit = await ytdlResolveHit(vid, itag, step, auth); } catch { hit = null; }
      if (!hit) continue;
      fetches++;
      let resp = null;
      try {
        resp = await ytdlReadMedia(request, hit.url, hit.ua, hit.cookie, ctrl.signal);
      } catch (e) {
        if (!fallbackOk) throw e;
        break;
      }
      if (resp.ok && resp.body) return ytdlMediaResponse(resp, filename);
      lastStatus = resp.status || 0;
      try { if (resp.body) await resp.body.cancel(); } catch { /* 换下一条直链 */ }
      if (!fallbackOk && lastStatus !== 401 && lastStatus !== 403 && lastStatus !== 410) return ytdlFail(lastStatus);
      if (fallbackOk) break;
    }
    if (fallbackOk) {
      let resp = null;
      try {
        resp = await ytdlReadMedia(request, fallbackUrl, YT_UA[clientKey] || UA_PC, '', ctrl.signal);
      } catch (e) {
        if (!lastStatus) return json({ ok: false, error: '下载失败：' + (e.message || '网络错误') }, 502);
        return ytdlFail(lastStatus, { both: true });
      }
      if (resp.ok && resp.body) return ytdlMediaResponse(resp, filename);
      lastStatus = resp.status || lastStatus;
      try { if (resp.body) await resp.body.cancel(); } catch { /* 两条都失败 */ }
      return ytdlFail(lastStatus, { both: true });
    }
    return ytdlFail(lastStatus);
  } catch (e) {
    return json({ ok: false, error: '下载失败：' + (e.message || '网络错误') }, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function handleYtDl(request, env) {
  const u = new URL(request.url);
  const filename = ytdlFilename(u.searchParams.get('filename'));
  const vid = String(u.searchParams.get('v') || '').trim();
  const itagRaw = String(u.searchParams.get('itag') || '').trim();
  if (vid || itagRaw) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(vid) || !/^\d{1,4}$/.test(itagRaw) || +itagRaw <= 0)
      return json({ ok: false, error: '无效的视频或画质参数' }, 400);
    const clientKey = u.searchParams.get('client') || u.searchParams.get('ua') || '';
    const fallbackUrl = u.searchParams.get('url') || '';
    return proxyResolvedYtDl(
      request,
      env,
      vid,
      +itagRaw,
      clientKey,
      filename,
      isAllowedMediaUrl(fallbackUrl) ? fallbackUrl : '',
    );
  }

  const mediaUrl = u.searchParams.get('url') || '';
  try { new URL(mediaUrl); } catch {
    return json({ ok: false, error: '无效的下载地址' }, 400);
  }
  if (!isAllowedMediaUrl(mediaUrl))
    return json({ ok: false, error: '不支持的下载地址' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(mediaUrl, {
      headers: ytdlUpstreamHeaders(request, YT_UA[u.searchParams.get('ua') || ''] || UA_PC),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) return ytdlFail(resp.status);
    return ytdlMediaResponse(resp, filename);
  } catch (e) {
    return json({ ok: false, error: '下载失败：' + (e.message || '网络错误') }, 502);
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 反馈系统（KV 存储 + 管理后台，与小红书/TikTok/抖音站共用） ================= */
async function handleFeedbackSubmit(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  const ct = request.headers.get('content-type') || '';
  let message = '',
    contact = '',
    page = '',
    tsToken = '',
    files = [];
  if (ct.includes('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(form.get('message') || '').trim();
    contact = String(form.get('contact') || '').trim().slice(0, 120);
    page = String(form.get('page') || '').slice(0, 200);
    tsToken = String(form.get('cf-turnstile-response') || '');
    files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(body.message || '').trim();
    contact = String(body.contact || '').trim().slice(0, 120);
    page = String(body.page || '').slice(0, 200);
    tsToken = String(body['cf-turnstile-response'] || '');
  }
  if (!message) return json({ ok: false, error: '请填写反馈内容' }, 400);
  if (message.length > 2000) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  if (files.length > 3) return json({ ok: false, error: '最多上传 3 个附件' }, 400);

  const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const COOLDOWN_SECS = 600;
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  if (clientIp) {
    const lastTs = await env.FEEDBACK_KV.get('cool_' + clientIp);
    if (lastTs) {
      const remain = COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0)
        return json(
          { ok: false, error: `提交太频繁，请 ${Math.max(1, Math.ceil(remain / 60))} 分钟后再试` },
          429
        );
    }
  }

  const id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const attachments = [];
  if (files.length) {
    if (!env.FEEDBACK_BUCKET) return json({ ok: false, error: '附件功能暂未启用' }, 500);
    for (const f of files) {
      const type = f.type || '';
      if (!/^(image|video)\//.test(type))
        return json({ ok: false, error: '只支持图片和视频附件' }, 400);
      if (f.size > 20 * 1024 * 1024)
        return json({ ok: false, error: '单个附件不能超过 20MB' }, 400);
      const ext =
        (String(f.name || '').split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
        'bin';
      const key = `fb/${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.FEEDBACK_BUCKET.put(key, f.stream(), {
        httpMetadata: { contentType: type },
      });
      attachments.push({ key, type, name: String(f.name || '').slice(0, 80), size: f.size });
    }
  }

  const record = {
    id,
    message: message.slice(0, 2000),
    contact,
    page,
    attachments,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: request.headers.get('cf-connecting-ip') || '',
    geo: {
      country: (request.cf && request.cf.country) || '',
      region: (request.cf && request.cf.region) || '',
      city: (request.cf && request.cf.city) || '',
    },
    time: new Date().toISOString(),
  };
  await env.FEEDBACK_KV.put(id, JSON.stringify(record));
  if (clientIp)
    await env.FEEDBACK_KV.put('cool_' + clientIp, String(Date.now()), {
      expirationTtl: COOLDOWN_SECS,
    });
  return json({ ok: true });
}

function checkAdminKey(url, env) {
  const key = env.FEEDBACK_ADMIN_KEY || '';
  return !!key && url.searchParams.get('key') === key;
}

async function handleFeedbackList(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const listed = await env.FEEDBACK_KV.list({ prefix: 'fb_' });
  const items = [];
  for (const k of listed.keys) {
    try {
      const v = await env.FEEDBACK_KV.get(k.name);
      if (v) items.push(JSON.parse(v));
    } catch {}
  }
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return json({ ok: true, count: items.length, items });
}

async function handleFeedbackDelete(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const id = url.searchParams.get('id') || '';
  if (!/^fb_[a-z0-9_]+$/i.test(id)) return json({ ok: false, error: '参数错误' }, 400);
  try {
    const v = await env.FEEDBACK_KV.get(id);
    if (v) {
      const rec = JSON.parse(v);
      if (env.FEEDBACK_BUCKET && Array.isArray(rec.attachments)) {
        for (const a of rec.attachments) {
          try {
            await env.FEEDBACK_BUCKET.delete(a.key);
          } catch {}
        }
      }
    }
  } catch {}
  await env.FEEDBACK_KV.delete(id);
  return json({ ok: true });
}

async function handleFeedbackFile(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return new Response('无权访问', { status: 403 });
  if (!env.FEEDBACK_BUCKET) return new Response('未绑定存储', { status: 500 });
  const m = url.pathname.match(/^\/api\/fb-file\/(.+)$/);
  const key = m ? decodeURIComponent(m[1]) : '';
  if (!key.startsWith('fb/') || key.includes('..')) return new Response('参数错误', { status: 400 });
  const obj = await env.FEEDBACK_BUCKET.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈管理</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f8;color:#222}
.wrap{max-width:640px;margin:0 auto;padding:16px 14px 60px}
h1{font-size:20px;margin:8px 0 4px}h1 span{font-size:13px;color:#888;font-weight:400}
.fb{background:#fff;border-radius:12px;padding:12px 14px;margin-top:12px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.fb .meta{font-size:12px;color:#999;margin-bottom:6px}
.fb .site{font-size:11px;color:#ff2442;font-weight:600}
.fb .msg{font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.fb button{margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#c00}
.empty{text-align:center;color:#aaa;margin-top:40px;font-size:14px}
</style></head>
<body><div class="wrap">
<h1>用户反馈 <span id="count"></span></h1>
<div style="margin:6px 0 4px"><a href="/dashboard?key=" id="dashLink" style="font-size:13px;color:#FE2C55">📊 数据总览</a></div>
<script>document.getElementById('dashLink').href = '/dashboard?key=' + encodeURIComponent(new URLSearchParams(location.search).get('key') || '');</script>
<div id="list">加载中…</div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',AR:'阿根廷',KR:'韩国',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',SA:'沙特',EG:'埃及',ZA:'南非',NL:'荷兰',SE:'瑞典',NO:'挪威',FI:'芬兰',DK:'丹麦',PL:'波兰',UA:'乌克兰',CH:'瑞士',AT:'奥地利',BE:'比利时',IE:'爱尔兰',PT:'葡萄牙',GR:'希腊',CZ:'捷克',HU:'匈牙利',RO:'罗马尼亚',IL:'以色列',KZ:'哈萨克斯坦'};
function geoName(it){
  const g = it.geo || {};
  if(!g.country && !g.region && !g.city) return '';
  const c = COUNTRY_ZH[g.country] || g.country || '';
  return [c, g.region, g.city].filter(Boolean).join('·');
}
const siteName = (p) => {
  try {
    const h = new URL(p).hostname;
    if (h.includes('tiktok')) return 'TikTok站';
    if (h.includes('xiaohongshu')) return '小红书站';
    if (h.includes('douyin')) return '抖音站';
    if (h.includes('youtube')) return 'YouTube站';
    if (h.includes('bilibili')) return 'B站站';
    if (h.includes('DeepSeek')) return 'DeepSeek站';
    return h;
  } catch { return ''; }
};
async function load() {
  const box = document.getElementById('list');
  try {
    const r = await fetch('/api/feedback/list?key=' + encodeURIComponent(key));
    const j = await r.json();
    if (!j.ok) { box.innerHTML = '<div class="empty">加载失败：' + esc(j.error) + '</div>'; return; }
    document.getElementById('count').textContent = '共 ' + j.count + ' 条';
    if (!j.items.length) { box.innerHTML = '<div class="empty">暂无反馈</div>'; return; }
    box.innerHTML = '';
    for (const it of j.items) {
      const d = document.createElement('div');
      d.className = 'fb';
      const t = new Date(it.time).toLocaleString('zh-CN', { hour12: false });
      d.innerHTML = '<div class="meta"><span class="site">[' + esc(siteName(it.page)) + ']</span> ' + esc(t) + (it.contact ? ' · ' + esc(it.contact) : '') + (it.ip ? ' · IP: ' + esc(it.ip) : '') + (geoName(it) ? ' (' + esc(geoName(it)) + ')' : '') + '</div>' +
        '<div class="msg">' + esc(it.message) + '</div>';
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 复制文本';
      copyBtn.style.cssText = 'margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;cursor:pointer';
      copyBtn.onclick = function(){
        const txt = it.message || '';
        const done = function(){ copyBtn.textContent = '✅ 已复制'; setTimeout(function(){ copyBtn.textContent = '📋 复制文本'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(function(){ alert('复制失败'); });
        } else { alert('当前浏览器不支持一键复制'); }
      };
      d.appendChild(copyBtn);
      if (it.attachments && it.attachments.length) {
        const att = document.createElement('div');
        for (const a of it.attachments) {
          const src = '/api/fb-file/' + encodeURIComponent(a.key) + '?key=' + encodeURIComponent(key);
          const fname = esc(String(a.name || 'attachment'));
          if (String(a.type || '').startsWith('image/')) {
            att.innerHTML += '<img src="' + src + '" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" loading="lazy">';
          } else {
            att.innerHTML += '<video src="' + src + '" controls playsinline style="max-width:100%;border-radius:8px;margin-top:8px;display:block"></video>';
          }
          att.innerHTML += '<a href="' + src + '" download="' + fname + '" style="display:inline-block;margin-top:6px;background:#f0f0f2;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;text-decoration:none">⬇ 下载</a>';
        }
        d.appendChild(att);
      }
      const btn = document.createElement('button');
      btn.textContent = '删除';
      btn.onclick = async () => {
        if (!confirm('删除这条反馈？')) return;
        await fetch('/api/feedback?id=' + encodeURIComponent(it.id) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
        load();
      };
      d.appendChild(btn);
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="empty">网络错误</div>'; }
}
load();
<\/script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>数据总览</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f13;color:#f1f1f3}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:10px 0 4px}h1 span{font-size:13px;color:#9a9aa3;font-weight:400}
.sub{font-size:13px;color:#9a9aa3;margin-bottom:16px}
h2{font-size:16px;margin:24px 0 12px;color:#f1f1f3}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#1a1a21;border-radius:16px;padding:20px 16px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.card .name{font-size:14px;color:#9a9aa3;margin-bottom:8px}
.card .num{font-size:36px;font-weight:800}
.card .unit{font-size:12px;color:#9a9aa3;margin-top:4px}
.total{margin-top:12px;background:linear-gradient(135deg,#FE2C55,#ff6b4a);border-radius:16px;padding:18px;text-align:center}
.total .num{font-size:32px;font-weight:800}
.total .label{font-size:13px;opacity:.85;margin-top:4px}
.panel{background:#1a1a21;border-radius:16px;padding:18px 16px;margin-top:12px;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.pie-wrap{display:flex;align-items:center;gap:18px;justify-content:center;flex-wrap:wrap}
#pie{width:150px;height:150px;border-radius:50%;flex-shrink:0}
#geoPie{width:150px;height:150px;border-radius:50%;flex-shrink:0}
.legend{font-size:13px;line-height:2}
.legend .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.bar-row{margin-bottom:12px}
.bar-row .blabel{font-size:13px;margin-bottom:5px;display:flex;justify-content:space-between}
.bar-track{background:#2a2a34;border-radius:8px;height:22px;overflow:hidden}
.bar-fill{height:100%;border-radius:8px;transition:width .5s;min-width:2px}
.refresh{margin-top:16px;text-align:center}
.refresh button{background:#2a2a34;border:none;border-radius:12px;padding:12px 32px;font-size:14px;color:#f1f1f3;cursor:pointer}
.err{text-align:center;color:#ff8ba0;margin-top:20px;font-size:14px}
.links{margin-top:16px;text-align:center;font-size:13px}
.links a{color:#9a9aa3;margin:0 8px}
</style></head>
<body><div class="wrap">
<h1>📊 数据总览 <span id="time"></span></h1>
<div class="sub">五站解析次数统计（仅成功计数）</div>
<div class="grid" id="grid"><div class="err">加载中…</div></div>
<div class="total" id="total" style="display:none"><div class="num" id="totalNum">0</div><div class="label">累计解析</div></div>

<h2>🥧 占比</h2>
<div class="panel"><div class="pie-wrap">
<div id="pie"></div>
<div class="legend" id="pieLegend"></div>
</div></div>

<h2>📊 柱状对比</h2>
<div class="panel" id="barChart"></div>

<h2>🌍 解析者地区分布</h2>
<div class="panel"><div class="pie-wrap">
<div id="geoPie"></div>
<div class="legend" id="geoLegend"></div>
</div></div>
<div class="panel" id="geoBars" style="margin-top:12px"></div>

<h2>🕐 最近解析者</h2>
<div class="panel" id="histList"><div style="color:#9a9aa3;font-size:13px;text-align:center">加载中…</div></div>

<div class="refresh"><button onclick="load()">🔄 刷新</button></div>
<div class="links"><a href="/admin?key=" id="adminLink">💬 反馈管理</a></div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
document.getElementById('adminLink').href = '/admin?key=' + encodeURIComponent(key);
const COLORS = ['#FE2C55','#25F4EE','#FFC107','#9C27B0'];
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',XX:'未知'};
async function load(){
  const grid = document.getElementById('grid');
  try{
    const r = await fetch('/api/stats-all?key=' + encodeURIComponent(key));
    const j = await r.json();
    if(!j.ok){ grid.innerHTML = '<div class="err">加载失败：' + (j.error || '未知错误') + '</div>'; return; }
    const sites = j.sites;
    grid.innerHTML = '';
    let sum = 0;
    sites.forEach(function(s, i){
      sum += s.count;
      const d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div class="name">' + s.name + '</div><div class="num" style="color:' + COLORS[i % COLORS.length] + '">' + s.count + '</div><div class="unit">次解析</div>';
      grid.appendChild(d);
    });
    document.getElementById('totalNum').textContent = sum;
    document.getElementById('total').style.display = 'block';
    document.getElementById('time').textContent = new Date().toLocaleString('zh-CN', {hour12:false});
    renderPie(sites, sum);
    renderBars(sites);
    loadGeo();
    loadHistory();
  }catch(e){ grid.innerHTML = '<div class="err">网络错误</div>'; }
}
function escH(s){ return String(s || '').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
async function loadHistory(){
  const box = document.getElementById('histList');
  try{
    const r = await fetch('/api/parse-history?key=' + encodeURIComponent(key));
    const j = await r.json();
    if(!j.ok || !j.items || !j.items.length){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">暂无数据（新解析才会记录）</div>'; return; }
    box.innerHTML = '';
    j.items.slice(0, 20).forEach(function(h){
      const geo = [COUNTRY_ZH[h.cc] || h.cc || '', h.region || '', h.city || ''].filter(Boolean).join('·');
      const time = new Date(h.t).toLocaleString('zh-CN', {hour12:false});
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 0;border-bottom:1px solid #2a2a34;line-height:1.8';
      const dev = h.dev ? escH(String(h.dev)) : '';
      row.innerHTML = '<div style="font-size:14px"><b>' + escH(h.ip || '未知IP') + '</b>' + (geo ? ' <span style="color:#9a9aa3;font-size:13px">(' + escH(geo) + ')</span>' : '') + '</div>' +
        '<div style="color:#9a9aa3;font-size:12px">' + escH(h.site) + ' · ' + escH(time) + '</div>' +
        (dev ? '<div style="color:#7a7a85;font-size:11px;word-break:break-all">设备ID: ' + dev + '</div>' : '');
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">加载失败</div>'; }
}
async function loadGeo(){
  try{
    const r = await fetch('/api/geo-stats?key=' + encodeURIComponent(key));
    const j = await r.json();
    if(!j.ok) return;
    const byCountry = j.byCountry || {};
    const entries = Object.keys(byCountry).map(function(cc){ return {cc:cc, n:byCountry[cc]}; })
      .sort(function(a,b){ return b.n - a.n; });
    const sum = entries.reduce(function(a,e){ return a + e.n; }, 0);
    renderGeoPie(entries, sum);
    renderGeoBars(entries);
  }catch(e){}
}
function geoZh(cc){ return COUNTRY_ZH[cc] || cc; }
const GEO_COLORS = ['#FE2C55','#25F4EE','#FFC107','#9C27B0','#4CAF50','#FF9800','#03A9F4','#E91E63','#8BC34A','#FF5722'];
function renderGeoPie(entries, sum){
  const pie = document.getElementById('geoPie');
  const legend = document.getElementById('geoLegend');
  if(!sum){ pie.style.background = '#2a2a34'; legend.innerHTML = '<div style="color:#9a9aa3">暂无数据（新解析才会统计）</div>'; return; }
  let acc = 0, parts = [], html = '';
  entries.slice(0, 10).forEach(function(e, i){
    const pct = e.n / sum * 100;
    parts.push(GEO_COLORS[i % GEO_COLORS.length] + ' ' + acc + '% ' + (acc + pct) + '%');
    acc += pct;
    html += '<div><span class="dot" style="background:' + GEO_COLORS[i % GEO_COLORS.length] + '"></span>' + geoZh(e.cc) + ' ' + e.n + '次 (' + pct.toFixed(1) + '%)</div>';
  });
  pie.style.background = 'conic-gradient(' + parts.join(',') + ')';
  legend.innerHTML = html;
}
function renderGeoBars(entries){
  const box = document.getElementById('geoBars');
  if(!entries.length){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">暂无数据</div>'; return; }
  const max = entries[0].n;
  box.innerHTML = '';
  entries.slice(0, 15).forEach(function(e, i){
    const w = Math.max(2, e.n / max * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<div class="blabel"><span>' + geoZh(e.cc) + '</span><span>' + e.n + '次</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + GEO_COLORS[i % GEO_COLORS.length] + '"></div></div>';
    box.appendChild(row);
  });
}
function renderPie(sites, sum){
  const pie = document.getElementById('pie');
  const legend = document.getElementById('pieLegend');
  if(!sum){ pie.style.background = '#2a2a34'; legend.innerHTML = '<div style="color:#9a9aa3">暂无数据</div>'; return; }
  let acc = 0, parts = [], html = '';
  sites.forEach(function(s, i){
    const pct = s.count / sum * 100;
    parts.push(COLORS[i % COLORS.length] + ' ' + acc + '% ' + (acc + pct) + '%');
    acc += pct;
    html += '<div><span class="dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' + s.name + ' ' + s.count + '次 (' + pct.toFixed(1) + '%)</div>';
  });
  pie.style.background = 'conic-gradient(' + parts.join(',') + ')';
  legend.innerHTML = html;
}
function renderBars(sites){
  const box = document.getElementById('barChart');
  const max = Math.max.apply(null, sites.map(function(s){ return s.count; }).concat([1]));
  box.innerHTML = '';
  sites.forEach(function(s, i){
    const w = Math.max(2, s.count / max * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<div class="blabel"><span>' + s.name + '</span><span>' + s.count + '次</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + COLORS[i % COLORS.length] + '"></div></div>';
    box.appendChild(row);
  });
}
load();
<\/script></body></html>`;



async function handleParseHistory(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const siteNames = { tiktok: 'TikTok站', xhs: '小红书站', douyin: '抖音站', youtube: 'YouTube站', bilibili: 'B站站' };
  const all = [];
  if (env.FEEDBACK_KV) {
    for (const site of Object.keys(siteNames)) {
      try {
        const raw = await env.FEEDBACK_KV.get('parsehist_' + site);
        const hist = raw ? JSON.parse(raw) : [];
        if (Array.isArray(hist)) for (const h of hist) all.push({ site: siteNames[site], ...h });
      } catch {}
    }
  }
  all.sort((a, b) => (b.t || 0) - (a.t || 0));
  return json({ ok: true, items: all.slice(0, 50) });
}

/* ================= 解析者归属地分布 ================= */
async function handleGeoStats(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const byCountry = {};
  const bySite = { tiktok: {}, xhs: {}, douyin: {}, youtube: {}, bilibili: {} };
  if (env.FEEDBACK_KV) {
    try {
      const listed = await env.FEEDBACK_KV.list({ prefix: 'geoparse_' });
      for (const k of listed.keys) {
        const m = k.name.match(/^geoparse_(tiktok|xhs|douyin|youtube|bilibili)_([A-Z]{2})$/);
        if (!m) continue;
        const n = Number((await env.FEEDBACK_KV.get(k.name)) || 0);
        if (!n) continue;
        const site = m[1], cc = m[2];
        byCountry[cc] = (byCountry[cc] || 0) + n;
        bySite[site][cc] = (bySite[site][cc] || 0) + n;
      }
    } catch {}
  }
  return json({ ok: true, byCountry, bySite });
}


/* ================= 每日解析配额 ================= */
async function handleParseQuota(request, env) {
  const DAILY_LIMIT = 20;
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const deviceId = url.searchParams.get('deviceId') || '';
  const quotaId = deviceId || ip;
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let used = 0;
  if (quotaId && env.FEEDBACK_KV) {
    try { used = Number((await env.FEEDBACK_KV.get('dlimit_' + quotaId + '_' + bjDate)) || 0); } catch {}
  }
  return json({ ok: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) });
}

/* ================= 数据总览 ================= */
async function handleStatsAll(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const sites = [
    { key: 'stats_parse_tiktok', name: 'TikTok站' },
    { key: 'stats_parse_xhs', name: '小红书站' },
    { key: 'stats_parse_douyin', name: '抖音站' },
    { key: 'stats_parse_youtube', name: 'YouTube站' },
    { key: 'stats_parse_bilibili', name: 'B站站' },
  ];
  const result = [];
  for (const s of sites) {
    let n = 0;
    if (env.FEEDBACK_KV) {
      try { n = Number((await env.FEEDBACK_KV.get(s.key)) || 0); } catch {}
    }
    result.push({ name: s.name, count: n });
  }
  return json({ ok: true, sites: result });
}

/* ================= 1080P 直连 InnerTube（多客户端轮换，拿高清无声流 + 音频，给浏览器合并用） ================= */
const YT_CLIENTS = [
  { key: 'vr', name: 'ANDROID_VR', id: 28, version: '1.62.27',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extra: { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' } },
  { key: 'ios', name: 'IOS', id: 5, version: '20.10.4',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' } },
  { key: 'android', name: 'ANDROID', id: 3, version: '20.10.38',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    extra: { androidSdkVersion: 34, osName: 'Android', osVersion: '14' } },
];
// 带 Cookie 时只试这些客户端。ANDROID / IOS / ANDROID_VR 不吃网页登录态，
// 带上 YT_COOKIES 会得到没有 playabilityStatus 的错误体（tried 里是 +ck:none），帮不上忙。
const YT_COOKIE_CLIENTS = [
  { key: 'mweb', name: 'MWEB', id: 2, version: '2.20260708.05.00',
    ua: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    extra: {} },
  { key: 'tv', name: 'TVHTML5', id: 7, version: '7.20260707.07.00',
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    extra: {} },
  { key: 'web', name: 'WEB', id: 1, version: '2.20260708.00.00',
    ua: UA_PC,
    extra: {} },
];
const YT_UA = Object.fromEntries(YT_CLIENTS.concat(YT_COOKIE_CLIENTS).map((c) => [c.key, c.ua]));
const YT_CLIENT_BY_KEY = Object.fromEntries(YT_CLIENTS.concat(YT_COOKIE_CLIENTS).map((c) => [c.key, c]));
const YT_COOKIE_KEYS = new Set(YT_COOKIE_CLIENTS.map((c) => c.key));
// 机器人墙重试时先打曾经能出 720P 的 IOS，再打另外两个匿名客户端。
const YT_BOT_RETRY_CLIENTS = [YT_CLIENTS[1], YT_CLIENTS[2], YT_CLIENTS[0]];

let ytVisitorCache = '';
// opts.cookie：带登录态取 visitor 时把 Cookie 一并带上，避免匿名 visitor 和会话对不上。
// opts.force：机器人墙重试必须重新取，不能复用上一轮可能已经被标脏的 visitor。
async function ytVisitorData(opts = {}) {
  const cookie = opts.cookie || '';
  if (!opts.force && !cookie && ytVisitorCache) return ytVisitorCache;
  try {
    const headers = { 'User-Agent': UA_PC };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch('https://www.youtube.com/sw.js_data', { headers });
    const t = await r.text();
    const m = t.match(/"(Cg[A-Za-z0-9_%-]{20,})"/);
    const vd = m ? decodeURIComponent(m[1]) : '';
    if (!cookie) ytVisitorCache = vd;
    return vd;
  } catch {
    if (!cookie) ytVisitorCache = '';
    return '';
  }
}

// YouTube 用同一个 status=LOGIN_REQUIRED 表示两件事，必须看 reason：
//   「Sign in to confirm you're not a bot」→ 机器人校验（BOT_CHECK）
//   「Sign in to confirm your age」/「inappropriate for some users」/ desktopLegacyAgeGateReason → 登录或年龄墙
export function classifyPlayability(ps) {
  const status = String(ps?.status || '');
  const reason = String(ps?.reason || '');
  const messages = Array.isArray(ps?.messages) ? ps.messages.map((x) => String(x)).join(' ') : '';
  const sub = ps?.errorScreen?.playerErrorMessageRenderer?.subreason;
  const subText = typeof sub?.simpleText === 'string'
    ? sub.simpleText
    : (Array.isArray(sub?.runs) ? sub.runs.map((r) => r?.text || '').join('') : '');
  const text = reason + '\n' + messages + '\n' + subText;
  const bot = /not a bot|not a robot|confirm you.?re not a bot|unusual traffic|机器人/i.test(text);
  const age = (ps?.desktopLegacyAgeGateReason != null && ps.desktopLegacyAgeGateReason !== 0)
    || /inappropriate for some users|confirm your age|age[- ]restricted|年龄限制|确认你的年龄|确认您的年龄/i.test(text)
    || status === 'AGE_CHECK_REQUIRED'
    || status === 'AGE_VERIFICATION_REQUIRED';
  if (status === 'OK') return { kind: 'ok', status, reason, age: false };
  if (bot && !age) return { kind: 'bot', status, reason, age: false };
  if (age || status === 'LOGIN_REQUIRED') return { kind: 'login', status, reason, age: !!age };
  return { kind: 'other', status, reason, age: false };
}

// 接受三种写法，方便从浏览器或扩展粘贴。不记录、不回传原文。
export function normalizeCookieHeader(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data.cookies || data.cookie || []);
      if (Array.isArray(list) && list.length) {
        const pairs = [];
        for (const c of list) {
          const name = c && (c.name || c.key);
          if (!name || c.value == null) continue;
          pairs.push(String(name).trim() + '=' + String(c.value));
        }
        if (pairs.length) return pairs.join('; ');
      }
    } catch { /* 不是 JSON 就按文本 Cookie 解析 */ }
  }
  if (text.includes('\t') || text.startsWith('#')) {
    const pairs = [];
    for (const line of text.split(/\r?\n/)) {
      let s = line.trim();
      if (!s) continue;
      if (s.startsWith('#HttpOnly_')) s = s.slice('#HttpOnly_'.length);
      else if (s.startsWith('#')) continue;
      const cols = s.split('\t');
      if (cols.length < 7) continue;
      const name = cols[5].trim();
      const value = cols.slice(6).join('\t');
      if (!name) continue;
      pairs.push(name + '=' + value);
    }
    if (pairs.length) return pairs.join('; ');
  }
  return text.replace(/[\r\n]+/g, ' ').replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '').trim();
}

// PREF=hl=zh-CN&gl=CN… 登录态请求沿用账号地区，避免写死 gl=US 把可播会话打成 UNPLAYABLE。
function cookieLocale(cookieHeader) {
  const pref = cookieMap(cookieHeader).PREF || '';
  if (!pref) return {};
  let text = pref;
  try { text = decodeURIComponent(pref); } catch { /* PREF 不一定带百分号编码 */ }
  const hl = (text.match(/(?:^|[?&\s])hl=([A-Za-z0-9-]+)/i) || [])[1] || '';
  const gl = (text.match(/(?:^|[?&\s])gl=([A-Za-z]{2})/i) || [])[1] || '';
  const out = {};
  if (hl) out.hl = hl;
  if (gl) out.gl = gl.toUpperCase();
  return out;
}

function cookieMap(header) {
  const map = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && map[k] == null) map[k] = v;
  }
  return map;
}

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Authorization: SAPISIDHASH <ts>_<sha1(ts + " " + SAPISID + " " + origin)>
// 同时带上 1P / 3P（有对应 Cookie 才生成）。SAPISID 缺失时用 __Secure-3PAPISID 顶上。
export async function ytSapiSidAuthorization(cookieHeader, origin = 'https://www.youtube.com', nowSec) {
  const map = cookieMap(cookieHeader);
  const sapisid = map.SAPISID || map['__Secure-3PAPISID'] || '';
  const one = map['__Secure-1PAPISID'] || '';
  const three = map['__Secure-3PAPISID'] || '';
  const ts = String(nowSec != null ? nowSec : Math.floor(Date.now() / 1000));
  const parts = [];
  for (const [scheme, sid] of [['SAPISIDHASH', sapisid], ['SAPISID1PHASH', one], ['SAPISID3PHASH', three]]) {
    if (!sid) continue;
    parts.push(scheme + ' ' + ts + '_' + await sha1Hex(ts + ' ' + sid + ' ' + origin));
  }
  return parts.join(' ');
}

async function ytAuthFromEnv(env) {
  const cookie = normalizeCookieHeader(env?.YT_COOKIES || env?.YT_COOKIE || '');
  const poToken = String(env?.YT_PO_TOKEN || env?.YT_POT || '').trim();
  let authorization = '';
  if (cookie) {
    try { authorization = await ytSapiSidAuthorization(cookie); } catch { authorization = ''; }
  }
  return { cookie, poToken, authorization };
}

export function loginRequiredMessage(hasCookies) {
  if (hasCookies) {
    return '这部视频需要已登录的 YouTube 会话（年龄限制或登录墙）。已读取环境变量 YT_COOKIES，但 YouTube 仍返回 LOGIN_REQUIRED：请换一份有效 Cookie（需包含 LOGIN_INFO，以及 SAPISID 或 __Secure-3PAPISID），并确认该账号已通过年龄验证，保存后重新部署。';
  }
  return '这部视频需要已登录的 YouTube 会话（年龄限制或登录墙），当前服务器没有可用的登录 Cookie。请在 Cloudflare Pages 环境变量设置 YT_COOKIES（浏览器里已登录 youtube.com 的 Cookie，可选再设 YT_PO_TOKEN），保存后重新部署。';
}

const YT_BOT_ERROR = 'YouTube 暂时把服务器当成了机器人，这次没有拿到可下载的视频流，过一会再试';

function isAgeLoginReason(reason) {
  return /inappropriate for some users|confirm your age|age[- ]restricted|年龄限制|确认你的年龄|确认您的年龄/i.test(String(reason || ''));
}

export function ytHdFailureBody(state) {
  // 年龄墙优先于机器人墙（有的客户端把年龄限制也报成 bot）。
  // 只有机器人墙、登录原因又不是年龄时，仍然报 BOT_CHECK，避免被空的 LOGIN_REQUIRED 盖掉。
  const age = !!(state?.sawAge || isAgeLoginReason(state?.loginReason));
  if (state?.sawLogin && (age || !state?.sawBot)) {
    const body = {
      ok: false,
      code: 'LOGIN_REQUIRED',
      error: loginRequiredMessage(!!state.cookiesConfigured),
    };
    if (state.loginReason) body.reason = String(state.loginReason).slice(0, 180);
    return body;
  }
  if (state?.sawBot) {
    return { ok: false, code: 'BOT_CHECK', error: YT_BOT_ERROR };
  }
  const other = state?.otherReason ? String(state.otherReason).replace(/\s+/g, ' ').slice(0, 180) : '';
  return {
    ok: false,
    code: 'UNAVAILABLE',
    error: other ? ('没拿到可下载的视频流：' + other) : '没拿到可下载的视频流',
  };
}

async function ytPlayer(vid, c, visitorData, auth) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': c.ua,
    'X-YouTube-Client-Name': String(c.id),
    'X-YouTube-Client-Version': c.version,
    Origin: 'https://www.youtube.com',
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  if (auth?.cookie) headers.Cookie = auth.cookie;
  if (auth?.authorization) {
    headers.Authorization = auth.authorization;
    headers['X-Origin'] = 'https://www.youtube.com';
    headers['X-Goog-AuthUser'] = '0';
  }
  const loc = auth?.cookie ? cookieLocale(auth.cookie) : {};
  const context = {
    client: {
      clientName: c.name,
      clientVersion: c.version,
      hl: loc.hl || 'en',
      gl: loc.gl || 'US',
      ...(visitorData ? { visitorData } : {}),
      ...c.extra,
    },
  };
  if (auth?.cookie) context.user = { enableSafetyMode: false, lockedSafetyMode: false };
  const body = {
    context,
    videoId: vid, contentCheckOk: true, racyCheckOk: true,
  };
  if (auth?.poToken) body.serviceIntegrityDimensions = { poToken: auth.poToken };
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
}

const HD_TARGET = 1080;
const ITAG_HEIGHT = {
  18: 360, 22: 720, 37: 1080, 59: 480,
  133: 240, 134: 360, 135: 480, 136: 720, 137: 1080,
  298: 720, 299: 1080, 398: 720, 399: 1080,
};

function fmtHeight(f) {
  const h = +f?.height || 0;
  if (h) return h;
  return ITAG_HEIGHT[+f?.itag] || 0;
}

function isAvcMp4(f) {
  const mime = String(f?.mimeType || '');
  return /^video\/mp4/i.test(mime) && /avc1/i.test(mime);
}

// 只要带直链的那一条。signatureCipher 没有 url，不能在这次请求里播。
export function findFormatByItag(player, itag) {
  const want = +itag;
  if (!want) return null;
  const lists = [player?.streamingData?.formats, player?.streamingData?.adaptiveFormats];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (f && +f.itag === want && f.url) return f;
    }
  }
  return null;
}

function isAacMp4(f) {
  const mime = String(f?.mimeType || '');
  // audio/mp4 里只有 AAC（mp4a）能进 iPhone 相册；ec-3 / ac-3 之类也排除。没写 codecs 的老格式按 AAC 处理。
  return /^audio\/mp4/i.test(mime) && (/mp4a/i.test(mime) || !/codecs=/i.test(mime));
}

// 只配 avc1 + AAC：iPhone 相册不认 AV1 / VP9，也不认装在 MP4 里的 Opus。
// 没有 AAC 分离音轨时不退回 webm/Opus，改用渐进式 MP4（itag 18/22 这类，H.264 + AAC 已经合好）。
// 只要有直链就用，不要求 playabilityStatus 一定是 OK——有的响应带着可用流却标了别的状态。
export function pickHdPair(j) {
  const adaptive = (j?.streamingData?.adaptiveFormats || []).filter((f) => f && f.url);
  const progressive = (j?.streamingData?.formats || []).filter((f) => f && f.url);
  const vids = adaptive.filter((f) => isAvcMp4(f) && fmtHeight(f) > 0 && fmtHeight(f) <= HD_TARGET)
    .sort((a, b) => fmtHeight(b) - fmtHeight(a) || (b.bitrate || 0) - (a.bitrate || 0));
  const auds = adaptive.filter(isAacMp4)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  let adaptivePair = null;
  if (vids.length && auds.length) {
    const video = vids[0];
    adaptivePair = { video, audio: auds[0], progressive: false, height: fmtHeight(video) };
  }
  const prog = progressive.filter((f) => isAvcMp4(f) && fmtHeight(f) > 0 && fmtHeight(f) <= HD_TARGET)
    .sort((a, b) => fmtHeight(b) - fmtHeight(a) || (b.bitrate || 0) - (a.bitrate || 0));
  let progPair = null;
  if (prog.length) {
    const video = prog[0];
    progPair = { video, audio: null, progressive: true, height: fmtHeight(video) };
  }
  if (adaptivePair && progPair) {
    // 同清晰度优先分离音轨（码率通常更高）；渐进式更高时用渐进式，不要为了“必须成对”丢掉 720/1080。
    return pairBeats(progPair, adaptivePair) ? adaptivePair : progPair;
  }
  return adaptivePair || progPair;
}

function pairBeats(best, hit) {
  if (!hit) return false;
  if (!best) return true;
  if (hit.height !== best.height) return hit.height > best.height;
  if (!!hit.audio !== !!best.audio) return !!hit.audio;
  return (hit.video?.bitrate || 0) > (best.video?.bitrate || 0);
}

function hdSuccessJson(vid, client, j, pair) {
  const v = pair.video;
  const body = {
    ok: true,
    directOk: true,
    videoId: vid,
    client: client.key,
    title: j?.videoDetails?.title || '',
    capped: pair.height < HD_TARGET,
    video: {
      url: v.url,
      height: pair.height,
      width: v.width || 0,
      size: +v.contentLength || 0,
      itag: v.itag,
    },
    progressive: !pair.audio,
  };
  body.audio = pair.audio
    ? { url: pair.audio.url, size: +pair.audio.contentLength || 0, itag: pair.audio.itag }
    : null;
  return json(body);
}

// 匿名轮换先跑（公开视频仍在 ANDROID_VR 第一次成功就返回）。
// 机器人墙且一个直链都没有时，按 ytHdTiming.botRetryDelaysMs 退避再打匿名客户端。
// Cookie 只发给 MWEB / TV / WEB。已经拿到 720P 就不会因为后面的 BOT_CHECK 把结果丢掉。
export const ytHdTiming = {
  botRetryDelaysMs: [400, 1000],
  probeTimeoutMs: 5000,
};

// ---- 直链尾部探测 ----
// Worker 签发的 googlevideo 直链有时只给开头约 1 分钟的字节，再往后就 403（手机合并第一块 ~8MB 音频必失败）。
// 返回直链前，对每条流按已知大小（contentLength）请求最后 1 KB；不知道大小就请求 8 MB 处的 1 KB。
// 只有 401/403/410 算「受限」；网络错误、超时、416、5xx 都算「判断不了」，不拦（不让探测本身把能用的结果丢掉）。
const DIRECT_PROBE_FALLBACK_OFFSET = 8 * 1024 * 1024;
export function directProbeRange(size) {
  const n = +size || 0;
  if (n >= 2048) return 'bytes=' + (n - 1024) + '-' + (n - 1);
  return 'bytes=' + DIRECT_PROBE_FALLBACK_OFFSET + '-' + (DIRECT_PROBE_FALLBACK_OFFSET + 1023);
}
async function probeDirectUrl(url, size, ua, cookie) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ytHdTiming.probeTimeoutMs) : null;
  try {
    const headers = { 'User-Agent': ua || UA_PC, Accept: '*/*', Range: directProbeRange(size) };
    if (cookie) {
      headers.Cookie = cookie;
      headers.Referer = 'https://www.youtube.com/';
      headers.Origin = 'https://www.youtube.com';
    }
    const r = await fetch(url, { headers, signal: ctrl ? ctrl.signal : undefined });
    try { if (r.body) await r.body.cancel(); } catch { /* ignore */ }
    if (r.status === 401 || r.status === 403 || r.status === 410) return { limited: true, status: r.status };
    return { limited: false, status: r.status };
  } catch {
    return { limited: false, status: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// 画面和声音（若有）都探一遍；任一条受限就算这组直链受限。
async function probeHdHit(hit, auth) {
  const c = hit.client;
  const cookie = YT_COOKIE_KEYS.has(c.key) && auth.cookie ? auth.cookie : '';
  const streams = [hit.pair.video, hit.pair.audio].filter(Boolean);
  const res = await Promise.all(streams.map((f) => probeDirectUrl(f.url, f.contentLength, c.ua, cookie)));
  const bad = res.find((r) => r.limited);
  return bad ? { ok: false, status: bad.status } : { ok: true };
}
// 受限时换不需要 PO token 的客户端（ANDROID_VR、TVHTML5）再签一次，IOS 放最后。
const YT_DIRECT_FALLBACK_KEYS = ['vr', 'tv', 'ios'];
export const DIRECT_LIMITED_MSG = 'YouTube 只让服务器拿到这条视频的开头一小段（直链受限），手机里合并会在中途 403。请改用「服务器合并」。';

function sleepMs(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ytHdOnce(vid, c, visitorData, auth, tried, state) {
  const tag = c.key + (visitorData ? '+vd' : '') + (auth?.cookie ? '+ck' : '');
  let j;
  try {
    j = await ytPlayer(vid, c, visitorData, auth);
  } catch {
    tried.push(tag + ':err');
    return null;
  }
  const kind = classifyPlayability(j?.playabilityStatus);
  const urlCount = [...(j?.streamingData?.formats || []), ...(j?.streamingData?.adaptiveFormats || [])]
    .filter((f) => f && f.url).length;
  const errLabel = j?.error ? 'error' : '';
  tried.push(tag + ':' + (kind.status || errLabel || 'none') + ':' + urlCount + ':' + kind.kind);
  if (kind.kind === 'login') {
    state.sawLogin = true;
    if (kind.age) state.sawAge = true;
    if (!state.loginReason && kind.reason) state.loginReason = kind.reason;
  } else if (kind.kind === 'bot') state.sawBot = true;
  else if (kind.reason && !state.otherReason) state.otherReason = kind.reason;
  const pair = pickHdPair(j);
  if (!pair) return null;
  return { pair, j, client: c };
}

async function runClientList(vid, clients, auth, tried, state, opts = {}) {
  let best = opts.best || null;
  const rounds = opts.rounds == null ? 2 : opts.rounds;
  for (let round = 0; round < rounds; round++) {
    const wantVisitor = !!(opts.withVisitor || round > 0);
    const vd = wantVisitor ? await ytVisitorData({ cookie: opts.visitorCookie || '', force: true }) : '';
    for (const c of clients) {
      const hit = await ytHdOnce(vid, c, vd, auth, tried, state);
      if (!hit) continue;
      if (pairBeats(
        best && { height: best.pair.height, audio: best.pair.audio, video: best.pair.video },
        { height: hit.pair.height, audio: hit.pair.audio, video: hit.pair.video },
      )) best = hit;
      if (best && best.pair.height >= HD_TARGET) return best;
    }
  }
  return best;
}

async function handleYtHd(request, env) {
  const u = new URL(request.url);
  const src = u.searchParams.get('url') || '';
  const m = src.match(/(?:[?&]v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || src.match(/^([A-Za-z0-9_-]{11})$/);
  if (!m) return json({ ok: false, error: '没找到视频 ID' }, 400);
  const vid = m[1];
  const auth = await ytAuthFromEnv(env);
  const tried = [];
  const state = {
    sawLogin: false, sawBot: false, sawAge: false, loginReason: '', otherReason: '',
    cookiesConfigured: !!auth.cookie,
  };
  ytVisitorCache = '';
  const anonAuth = { poToken: auth.poToken };
  let best = await runClientList(vid, YT_CLIENTS, anonAuth, tried, state, { rounds: 2 });
  // 年龄墙重试匿名客户端没有用。只有纯机器人墙、而且现在一个流都没有，才退避重试。
  if (!best && state.sawBot && !state.sawAge) {
    for (const delay of ytHdTiming.botRetryDelaysMs) {
      await sleepMs(delay);
      ytVisitorCache = '';
      best = await runClientList(vid, YT_BOT_RETRY_CLIENTS, anonAuth, tried, state, { rounds: 1, withVisitor: true });
      if (best) break;
    }
  }
  if (auth.cookie && (!best || best.pair.height < HD_TARGET)) {
    const cookieBest = await runClientList(vid, YT_COOKIE_CLIENTS, auth, tried, state, {
      rounds: best ? 1 : 2,
      best,
      visitorCookie: auth.cookie,
    });
    if (cookieBest) best = cookieBest;
  }
  if (best) {
    const probe = await probeHdHit(best, auth);
    if (probe.ok) return hdSuccessJson(vid, best.client, best.j, best.pair);
    tried.push(best.client.key + ':direct' + probe.status);
    for (const key of YT_DIRECT_FALLBACK_KEYS) {
      if (key === best.client.key) continue;
      const c = YT_CLIENT_BY_KEY[key];
      // 匿名客户端绝不附带 Cookie；TV 有 Cookie 时带上（与 runClientList 的规则一致）。
      const cAuth = YT_COOKIE_KEYS.has(key) && auth.cookie ? auth : anonAuth;
      const hit = await ytHdOnce(vid, c, '', cAuth, tried, state);
      if (!hit) continue;
      const p2 = await probeHdHit(hit, auth);
      if (p2.ok) return hdSuccessJson(vid, hit.client, hit.j, hit.pair);
      tried.push(key + ':direct' + p2.status);
    }
    const limited = { ok: false, directOk: false, code: 'DIRECT_LIMITED', error: DIRECT_LIMITED_MSG, tried };
    if ((env.YT_MERGE_TOKEN || '').trim()) limited.serverMerge = true;
    return json(limited, 503);
  }
  const body = ytHdFailureBody(state);
  body.tried = tried;
  // 机器人墙 / 不可播时，前端可以改走已配置的服务器合并，而不是死在手机里的 403。
  if ((env.YT_MERGE_TOKEN || '').trim()) body.serverMerge = true;
  return json(body, body.code === 'LOGIN_REQUIRED' ? 403 : 503);
}

/* ================= 1080P 服务器合并（EC2 yt-dlp + ffmpeg） ================= */
// 前端不直接调 EC2（token 不能进前端），一律经 Pages Worker 中转，
// Worker 用环境变量 YT_MERGE_TOKEN（与 EC2 ~/yt-merge/token.txt 一致）向 EC2 鉴权。
// EC2 任务是异步的：start 立即返回 job_id，前端轮询 status，done 后再拉 file。
// 未配 YT_MERGE_TOKEN 时明确报错，不让请求静默失败。
/* 注意：Cloudflare Worker 不能直接按 IP 调后端（会被 1003 拦截），
   所以这里用 sslip.io 主机名（解析到同一 EC2 IP），不要改回裸 IP。 */
const MERGE_BASE_DEFAULT = 'http://3-129-45-49.sslip.io:30002';
// 给 EC2 yt-dlp 的格式串：只要 H.264(avc1) + AAC(mp4a)，没有就要已合好的 H.264 MP4，最后才放开。
// iPhone 相册不认 AV1(398/399)、VP9，也不认 MP4 里的 Opus。EC2 要读 body.format 才生效（旧版会忽略这个字段）。
export function mergeFormat(quality, mode) {
  const q = +quality || 1080;
  // 最后一段是退路：视频根本没有 H.264 时也要能出文件，不能直接 "Requested format is not available"；
  // 退路产物不是 H.264+AAC 的话，由 status / file 接口识别出来给中文提示（见 mergeCompat）。
  if (mode === 'silent') return `bv*[height<=${q}][vcodec^=avc1]/b[height<=${q}][ext=mp4][vcodec^=avc1]/bv*[height<=${q}]`;
  return `bv*[height<=${q}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${q}][ext=mp4][vcodec^=avc1]/b[ext=mp4]/bv*[height<=${q}]+ba/b`;
}
export const MERGE_NOT_IPHONE_MSG = '服务器合并出来的是 iPhone 相册存不了的格式（{fmt}）。请改点「360P（含声音）」直接下载，或用页面上的「一键下载」在手机里合并。';
function notIphone(fmt) {
  return { ok: false, code: 'MERGE_NOT_IPHONE', error: MERGE_NOT_IPHONE_MSG.replace('{fmt}', fmt) };
}
// EC2 status 里如果带了编码字段就直接用。没有字段返回 null（放行，交给 file 接口看文件头）。
export function mergeCodecVerdict(s) {
  if (!s || typeof s !== 'object') return null;
  const v = String(s.vcodec || s.video_codec || '').toLowerCase();
  const a = String(s.acodec || s.audio_codec || '').toLowerCase();
  const ext = String(s.ext || s.container || '').toLowerCase();
  if (!v && !a && !ext) return null;
  const vOk = !v || /^(avc|h264)/.test(v);
  const aOk = !a || a === 'none' || /^(mp4a|aac)/.test(a);
  const eOk = !ext || /^(mp4|m4v|mov)$/.test(ext);
  if (vOk && aOk && eOk) return { ok: true };
  return { ok: false, fmt: [v, a, ext].filter(Boolean).join(' + ') };
}
function u32(buf, o) {
  return (buf[o] << 24 | buf[o + 1] << 16 | buf[o + 2] << 8 | buf[o + 3]) >>> 0;
}
function fourcc(buf, o) {
  return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
}
// 按 ISO BMFF 盒子结构遍历 [from, to) 内的直接子盒子。返回 {type, start, body, end, truncated}。
// end 是盒子声明的结尾（可能超出已读到的 buf），truncated 表示没读全。
function mp4Boxes(buf, from, to) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(buf, o);
    const type = fourcc(buf, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u32(buf, o + 8) * 4294967296 + u32(buf, o + 12);
      hdr = 16;
    } else if (size === 0) {
      size = to - o; // 到父盒子 / 文件结尾
    }
    if (size < hdr) break; // 结构坏了，不再往下猜
    const end = o + size;
    out.push({ type, start: o, body: o + hdr, end, truncated: end > buf.length });
    o = end;
  }
  return out;
}
const MP4_BAD_SAMPLE = { av01: 'AV1', vp09: 'VP9', vp08: 'VP8', Opus: 'Opus', fLaC: 'FLAC' };
// hvc1（参数集在 sample entry 里）iPhone 相册可直接存；hev1（参数集在码流里）兼容性不稳，仍按「判断不了」放行不判 ok。
const MP4_GOOD_VIDEO = new Set(['avc1', 'avc3', 'hvc1']);
const MP4_GOOD_AUDIO = new Set(['mp4a']);
// 只读 moov→trak→mdia→minf→stbl→stsd 里每个样本描述条目的格式 fourcc。
// stsd 是 FullBox：盒子头之后（body，一般是起点 +8，64 位 largesize 时 +16）是版本/标志 4 字节、条目数 4 字节，
// 再往后（body+8）是条目；每个条目 = size(4) + 格式(4) + …。
// 标题、udta、mdat 里的文字（如「Chopin Opus 28」）都不会被读到。
function mp4SampleFormats(buf, moov) {
  const lim = Math.min(moov.end, buf.length);
  const formats = [];
  let complete = !moov.truncated;
  const child = (box, type) => mp4Boxes(buf, box.body, Math.min(box.end, buf.length)).filter((b) => b.type === type);
  for (const trak of child(moov, 'trak')) {
    for (const mdia of child(trak, 'mdia')) {
      for (const minf of child(mdia, 'minf')) {
        for (const stbl of child(minf, 'stbl')) {
          for (const stsd of child(stbl, 'stsd')) {
            if (stsd.body + 8 > lim) { complete = false; continue; }
            const count = u32(buf, stsd.body + 4);
            if (count > 16) complete = false; // 只读前 16 个，后面没看到就不能说兼容
            let e = stsd.body + 8;
            for (let i = 0; i < count && i < 16; i++) {
              if (e + 8 > Math.min(stsd.end, buf.length)) { complete = false; break; }
              formats.push(fourcc(buf, e + 4));
              const es = u32(buf, e);
              if (es < 8) { complete = false; break; } // 条目大小坏了，后面的条目读不到
              e += es;
            }
          }
        }
      }
    }
  }
  return { formats, complete };
}
// 看成品开头（最多 512 KB，faststart 的 moov 一般都在里面）：
//  - WebM/Matroska（EBML 头 1A 45 DF A3）→ 不兼容；
//  - MP4：ftyp 兼容品牌里有 av01 → 不兼容；
//    能读到 moov 时解析盒子结构，只看 stsd 样本格式：av01/vp09/vp08/Opus/fLaC → 不兼容；
//    moov 读全了、有 avc1/avc3/hvc1、其余都是 avc1/avc3/hvc1/mp4a → 兼容；
//  - ftyp 盒子本身坏了（size < 8、largesize 不对）→ unknown，放行；
//  - moov 在文件尾（读不到）、没读全且没坏标记、或认不出 → unknown，放行。
export function sniffMergedHead(buf) {
  if (!buf || buf.length < 12) return { kind: 'unknown' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'webm', ok: false, fmt: 'WebM' };
  if (fourcc(buf, 4) !== 'ftyp') return { kind: 'unknown' };
  const top = mp4Boxes(buf, 0, buf.length);
  // ftyp 的 size < 8 或 largesize 不对时解析不出盒子：认不出就放行，别让 ftyp.end 抛错变成 502。
  if (!top.length || top[0].type !== 'ftyp') return { kind: 'unknown' };
  const ftyp = top[0];
  const ftypEnd = Math.min(buf.length, ftyp.end);
  for (let o = ftyp.body; o + 4 <= ftypEnd; o += 4) {
    if (o === ftyp.body + 4) continue; // minor_version 不是品牌
    if (fourcc(buf, o) === 'av01') return { kind: 'mp4', ok: false, fmt: 'AV1 MP4' };
  }
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { kind: 'mp4' };
  const { formats, complete } = mp4SampleFormats(buf, moov);
  const bad = [...new Set(formats.filter((f) => MP4_BAD_SAMPLE[f]).map((f) => MP4_BAD_SAMPLE[f]))];
  if (bad.length) return { kind: 'mp4', ok: false, fmt: bad.join(' + ') + ' MP4' };
  if (complete && formats.some((f) => MP4_GOOD_VIDEO.has(f)) && formats.every((f) => MP4_GOOD_VIDEO.has(f) || MP4_GOOD_AUDIO.has(f))) {
    return { kind: 'mp4', ok: true };
  }
  return { kind: 'mp4' };
}
// RFC 5987：encodeURIComponent 不转义 ' ( ) *，在 filename* 里要转。
export function rfc5987(s) {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// Content-Disposition 取文件名：优先 filename*（RFC 5987，UTF-8 百分号编码），再退到 filename。
export function dispositionFilename(cd) {
  const star = /filename\*\s*=\s*([\w-]+)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    const v = star[2].trim().replace(/^"|"$/g, '');
    try { return /^utf-?8$/i.test(star[1]) ? decodeURIComponent(v) : unescape(v); } catch { /* 坏编码就退到 filename */ }
  }
  const q = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd);
  if (q) return q[1].replace(/\\(.)/g, '$1');
  const t = /filename\s*=\s*([^;]+)/i.exec(cd);
  return t ? t[1].trim() : '';
}
// Workers 里用自建 ReadableStream 当响应体会丢掉 Content-Length（变成 chunked，前端没有百分比）。
// 上游给了长度就经 FixedLengthStream 转接保留长度；本地/测试环境没有 FixedLengthStream 时原样返回。
// 上游带 Content-Encoding（gzip/br 等）时 fetch 拿到的是解压后的字节，长度对不上，不套。
export function withKnownLength(stream, contentLength, contentEncoding) {
  const len = Number(contentLength);
  if (contentEncoding && !/^\s*identity\s*$/i.test(contentEncoding)) return stream;
  if (typeof FixedLengthStream !== 'function' || !Number.isSafeInteger(len) || len <= 0) return stream;
  const { readable, writable } = new FixedLengthStream(len);
  stream.pipeTo(writable).catch(() => { /* 客户端中断或上游断流，readable 端会报错 */ });
  return readable;
}
// 先读够 limit 字节用于判断，再把读过的块和剩下的流原样接起来下发，不用整份缓存。
async function peekStream(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let got = 0, done = false;
  while (got < limit) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    chunks.push(r.value);
    got += r.value.byteLength;
  }
  const head = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { head.set(c, o); o += c.byteLength; }
  const stream = new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(c); if (done) ctrl.close(); },
    async pull(ctrl) {
      const r = await reader.read();
      if (r.done) ctrl.close(); else ctrl.enqueue(r.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, stream };
}
function mergeBase(env) {
  return (env.YT_MERGE_BASE || MERGE_BASE_DEFAULT).replace(/\/$/, '');
}
function mergeToken(env) {
  return (env.YT_MERGE_TOKEN || '').trim();
}
// Cloudflare 530 + error code 1016 = 源站域名解析失败（sslip.io 那台 EC2 不在线或 YT_MERGE_BASE 写错）。
// 521/522/523 同样是源站连不上。不要把英文错误页原样丢给前端。
export function mergeOriginDown(status, text) {
  const body = String(text || '');
  if (status === 530 || status === 521 || status === 522 || status === 523) return true;
  return /error\s*code:\s*1016|Error 1016|Origin DNS error/i.test(body);
}
export function mergeOriginDownMessage(status, text) {
  const hit1016 = /1016/.test(String(text || '')) || status === 530;
  const code = hit1016 ? '530/1016' : String(status || '');
  return '合并服务器连不上（Cloudflare ' + code + '，源站不可达）。请检查 Pages 环境变量 YT_MERGE_BASE（EC2 合并服务地址）和 YT_MERGE_TOKEN（须与 EC2 口令一致），并确认 EC2 上的合并服务进程正在运行。默认 sslip.io 源站不可达时，把 YT_MERGE_BASE 改成你自己的服务地址后重新部署。';
}
function mergeConnectError(e) {
  const detail = (e && e.message) ? String(e.message).replace(/[\r\n]/g, ' ').slice(0, 160) : '网络错误';
  return json({
    ok: false,
    code: 'MERGE_ORIGIN_DOWN',
    error: '合并服务暂时连不上（' + detail + '）。请检查 Pages 环境变量 YT_MERGE_BASE、YT_MERGE_TOKEN，以及 EC2 上的合并服务是否在运行。',
  }, 502);
}
async function mergePassthrough(resp) {
  const text = await resp.text();
  if (mergeOriginDown(resp.status, text)) {
    return json({ ok: false, code: 'MERGE_ORIGIN_DOWN', error: mergeOriginDownMessage(resp.status, text) }, 502);
  }
  // EC2 正常时返回 JSON；若上游返回非 JSON（如 Cloudflare 1003），
  // 不能原样透传（前端 r.json() 会抛晦涩的英文错），要转成中文 JSON 错误。
  try {
    JSON.parse(text);
  } catch {
    if (resp.status >= 500) {
      return json({
        ok: false,
        code: 'MERGE_ORIGIN_DOWN',
        error: '合并服务器连不上或内部出错（HTTP ' + resp.status + '）。请确认 EC2 上的合并服务进程正在运行（Pages 环境变量 YT_MERGE_BASE）。',
      }, 502);
    }
    return json({ ok: false, error: '合并服务返回异常（HTTP ' + resp.status + '）：' + text.slice(0, 200) }, resp.status >= 400 ? resp.status : 502);
  }
  return new Response(text, {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
async function handleYt1080Start(request, env) {
  const token = mergeToken(env);
  if (!token)
    return json({ ok: false, error: '未配置合并服务口令：请在 Pages 环境变量里设置 YT_MERGE_TOKEN（与 EC2 合并服务的口令一致），设置后重新部署生效' }, 500);
  const reqUrl = new URL(request.url);
  const ytUrl = reqUrl.searchParams.get('url') || '';
  if (!ytUrl.trim()) return json({ ok: false, error: '请先粘贴 YouTube 分享链接' }, 400);
  const qualityRaw = parseInt(reqUrl.searchParams.get('quality') || '1080', 10);
  const quality = [360, 720, 1080].includes(qualityRaw) ? qualityRaw : 1080;
  const modeRaw = reqUrl.searchParams.get('mode') || 'merged';
  const mode = modeRaw === 'silent' ? 'silent' : 'merged';
  try {
    const resp = await fetch(mergeBase(env) + '/yt1080-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Merge-Token': token, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json' },
      body: JSON.stringify({
        url: ytUrl,
        quality: quality,
        mode: mode,
        format: mergeFormat(quality, mode),
        format_sort: 'vcodec:h264,acodec:aac,res:' + quality + ',ext:mp4:m4a',
        merge_output_format: 'mp4',
      }),
    });
    return mergePassthrough(resp);
  } catch (e) {
    return mergeConnectError(e);
  }
}
async function handleYt1080Status(request, env) {
  const token = mergeToken(env);
  if (!token) return json({ ok: false, error: '未配置合并服务口令' }, 500);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: '缺少任务 id' }, 400);
  try {
    const resp = await fetch(mergeBase(env) + '/yt1080-jobs/' + encodeURIComponent(id), {
      headers: { 'X-Merge-Token': token, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json' },
    });
    if (resp.ok) {
      const text = await resp.text();
      let s = null;
      try { s = JSON.parse(text); } catch { /* 交给 mergePassthrough 处理非 JSON */ }
      if (s && s.status === 'done') {
        const v = mergeCodecVerdict(s);
        if (v && !v.ok) return json(notIphone(v.fmt));
      }
      return mergePassthrough(new Response(text, { status: resp.status, headers: resp.headers }));
    }
    return mergePassthrough(resp);
  } catch (e) {
    return mergeConnectError(e);
  }
}
async function handleYt1080File(request, env) {
  const token = mergeToken(env);
  if (!token) return json({ ok: false, error: '未配置合并服务口令' }, 500);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: '缺少任务 id' }, 400);
  try {
    const resp = await fetch(mergeBase(env) + '/yt1080-jobs/' + encodeURIComponent(id) + '/file', {
      headers: { 'X-Merge-Token': token, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json' },
    });
    if (!resp.ok) return mergePassthrough(resp);
    const upType = resp.headers.get('content-type') || '';
    // 上游 200 却是 JSON/HTML（错误页）：原样下发，前端 __hkSave 靠 blob.type 识别成错误。
    if (/json|html/i.test(upType) || !resp.body) return mergePassthrough(resp);
    // 不靠后缀名：看文件开头。webm 或 AV1/Opus 的 MP4 → 中文错误；avc1 或判断不了 → 放行。
    const { head, stream } = await peekStream(resp.body, 512 * 1024);
    const sn = sniffMergedHead(head);
    if (sn.ok === false) {
      try { await stream.cancel(); } catch { /* ignore */ }
      return json(notIphone(sn.fmt), 415);
    }
    const headers = new Headers(resp.headers);
    let fname = dispositionFilename(resp.headers.get('content-disposition') || '');
    fname = fname.replace(/["\r\n\\/]/g, '').slice(0, 80);
    // 只在没有上游文件名时补一个；确认是 MP4 才补 .mp4，不把别的容器改名成 .mp4。
    if (!fname) fname = 'youtube_' + id.replace(/[^\w-]/g, '').slice(0, 24) + (sn.kind === 'mp4' ? '.mp4' : '');
    const ascii = fname.replace(/[^\x20-\x7e]/g, '_');
    if (sn.kind === 'mp4') headers.set('Content-Type', 'video/mp4');
    else if (!upType) headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + rfc5987(fname));
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');
    headers.set('Cache-Control', 'no-store');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(withKnownLength(stream, resp.headers.get('content-length'), resp.headers.get('content-encoding')), { status: 200, headers });
  } catch (e) {
    return mergeConnectError(e);
  }
}

/* ================= 服务器状态 /api/server-status、/api/ping ================= */
// 前端「服务器状态」卡片用。Worker 带 X-Merge-Token 请求 EC2 的 GET /status（契约见文件顶部注释），
// 只回传清洗过的数字，绝不回传口令或上游原文。结果在边缘缓存 SERVER_STATUS_TTL 秒，避免频繁打 EC2。
export const SERVER_STATUS_TIMEOUT_MS = 5000;
const SERVER_STATUS_TTL = 15;
const serverStatusMemo = new Map(); // mergeBase -> { at, body }（同一 isolate 内的兜底缓存，pages.dev 上 Cache API 不生效）

function statusNum(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
function statusPct(used, total, given) {
  let p = null;
  if (used !== null && total !== null && total > 0) p = (used / total) * 100;
  else if (given !== null) p = given;
  if (p === null) return null;
  return Math.round(Math.min(100, Math.max(0, p)) * 10) / 10;
}
function statusObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
// 把 EC2 /status 的 JSON 清洗成只含数字的固定结构（多余字段一律丢弃）
export function sanitizeServerStatus(raw) {
  const r = statusObj(raw);
  const m = statusObj(r.mem), c = statusObj(r.cpu), d = statusObj(r.disk), j = statusObj(r.jobs);
  const memTotal = statusNum(m.total), memUsed = statusNum(m.used);
  const diskTotal = statusNum(d.total), diskUsed = statusNum(d.used);
  const load1 = statusNum(c.load1), load5 = statusNum(c.load5), load15 = statusNum(c.load15);
  const coresRaw = statusNum(c.cores);
  const cores = coresRaw !== null && coresRaw >= 1 ? Math.floor(coresRaw) : null;
  const cpuPct = load1 !== null && cores ? statusPct(load1, cores, null) : statusPct(null, null, statusNum(c.percent));
  const running = statusNum(j.running), queued = statusNum(j.queued);
  const uptime = statusNum(r.uptimeSec);
  return {
    mem: { total: memTotal, used: memUsed, percent: statusPct(memUsed, memTotal, statusNum(m.percent)) },
    cpu: { load1, load5, load15, cores, percent: cpuPct },
    disk: { total: diskTotal, used: diskUsed, percent: statusPct(diskUsed, diskTotal, statusNum(d.percent)) },
    uptimeSec: uptime === null ? null : Math.floor(uptime),
    jobs: { running: running === null ? null : Math.floor(running), queued: queued === null ? null : Math.floor(queued) },
  };
}

// 实际探测 EC2。返回给前端的 body（不含口令）。opts.timeoutMs 仅供测试缩短超时。
export async function fetchServerStatus(env, opts) {
  const checkedAt = Date.now();
  const token = mergeToken(env);
  if (!token) return { ok: true, online: false, latencyMs: null, error: '未配置合并服务', checkedAt };
  const timeoutMs = (opts && opts.timeoutMs) || SERVER_STATUS_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const offline = (error) => ({ ok: true, online: false, latencyMs: null, error, checkedAt });
  try {
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetch(mergeBase(env) + '/status', {
        method: 'GET',
        headers: { 'X-Merge-Token': token, 'Accept': 'application/json', 'User-Agent': 'yt-site-status/1' },
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timedOut || (e && e.name === 'AbortError')) return offline('连接超时');
      return offline('无法连接服务器');
    }
    const latencyMs = Math.max(0, Date.now() - t0);
    let text = '';
    try { text = await resp.text(); } catch { if (timedOut) return offline('连接超时'); }
    if (mergeOriginDown(resp.status, text)) return offline('服务器不可达');
    if (resp.status === 404) return { ok: true, online: true, latencyMs, statusSupported: false, checkedAt };
    if (resp.status === 401 || resp.status === 403) return offline('口令不匹配（HTTP ' + resp.status + '）');
    if (resp.status !== 200) return offline('服务器异常（HTTP ' + resp.status + '）');
    let raw;
    try { raw = JSON.parse(text); } catch { return offline('服务器返回格式异常'); }
    if (!raw || typeof raw !== 'object' || raw.ok === false) return offline('服务器返回格式异常');
    return Object.assign({ ok: true, online: true, latencyMs, statusSupported: true }, sanitizeServerStatus(raw), { checkedAt });
  } finally {
    clearTimeout(timer);
  }
}

export function _resetServerStatusCache() {
  serverStatusMemo.clear();
}

async function handleServerStatus(request, env, ctx) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=' + SERVER_STATUS_TTL,
  };
  const memoKey = mergeBase(env) + '|' + (mergeToken(env) ? '1' : '0');
  const memo = serverStatusMemo.get(memoKey);
  if (memo && Date.now() - memo.at < SERVER_STATUS_TTL * 1000) {
    return new Response(JSON.stringify(memo.body), { status: 200, headers });
  }
  const cache = typeof caches !== 'undefined' && caches && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL('/api/server-status', request.url).toString(), { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {}
  }
  const body = await fetchServerStatus(env);
  serverStatusMemo.set(memoKey, { at: Date.now(), body });
  const resp = new Response(JSON.stringify(body), { status: 200, headers });
  if (cache) {
    try {
      const p = cache.put(cacheKey, resp.clone());
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
    } catch {}
  }
  return resp;
}

/* Experimental direct parse (no RedFox): Worker fetches YouTube InnerTube
   player API, returns only format metadata (no stream URLs) for testing. */
async function handleYtDirect(request, env) {
  const reqUrl = new URL(request.url);
  const ytUrl = reqUrl.searchParams.get('url') || '';
  const m = ytUrl.match(/[?&]v=([A-Za-z0-9_-]{6,20})/) || ytUrl.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/);
  if (!m) return json({ ok: false, error: '请先粘贴 YouTube 分享链接' }, 400);
  const vid = m[1];
  const results = [];
  // Method 1: InnerTube WEB client
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240111.09.00', hl: 'zh-CN' } }, videoId: vid, racyCheckOk: true, contentCheckOk: true }),
    });
    const d = await resp.json().catch(() => ({}));
    const sd = d.streamingData || {};
    const fmts = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
    results.push({ method: 'innertube-web', http: resp.status, playability: (d.playabilityStatus || {}).status || '', reason: ((d.playabilityStatus || {}).reason || '').slice(0, 120), count: fmts.length, formats: fmts.map(f => ({ itag: f.itag, mime: (f.mimeType || '').split(';')[0], height: f.height || 0, quality: f.qualityLabel || '', hasUrl: !!f.url, hasCipher: !!f.signatureCipher })) });
  } catch (e) {
    results.push({ method: 'innertube-web', error: String(e).slice(0, 200) });
  }
  // Method 2: watch page HTML, extract ytInitialPlayerResponse
  try {
    const resp = await fetch('https://www.youtube.com/watch?v=' + vid, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const html = await resp.text();
    const mm = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var meta/) || html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});<\/script>/);
    let count = 0, playability = '', fmts = [];
    if (mm) {
      try {
        const d = JSON.parse(mm[1]);
        playability = (d.playabilityStatus || {}).status || '';
        const sd = d.streamingData || {};
        fmts = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
        count = fmts.length;
      } catch (e) { playability = 'parse-error'; }
    }
    results.push({ method: 'watch-html', http: resp.status, htmlLen: html.length, hasPlayerResponse: !!mm, playability: playability, count: count, formats: fmts.map(f => ({ itag: f.itag, mime: (f.mimeType || '').split(';')[0], height: f.height || 0, quality: f.qualityLabel || '', hasUrl: !!f.url, hasCipher: !!f.signatureCipher })) });
  } catch (e) {
    results.push({ method: 'watch-html', error: String(e).slice(0, 200) });
  }
  return json({ ok: true, videoId: vid, results: results });
}

/* ================= 路由 ================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ping') return json({ ok: true, t: Date.now() });
    if (url.pathname === '/api/server-status') return handleServerStatus(request, env, ctx);

    if (url.pathname === '/api/parse') return handleParse(request, env);
    if (url.pathname === '/api/ytdl') return handleYtDl(request, env);
    if (url.pathname === '/api/yt1080-start') return handleYt1080Start(request, env);
    if (url.pathname === '/api/yt1080-status') return handleYt1080Status(request, env);
    if (url.pathname === '/api/yt1080-file') return handleYt1080File(request, env);
    if (url.pathname === '/api/yt-direct') return handleYtDirect(request, env);
    if (url.pathname === '/api/yt-hd') return handleYtHd(request, env);

    if (url.pathname === '/api/diag')
      return json({
        ok: true,
        hasApiKey: !!(env.REDFOX_API_KEY || '').trim(),
        hasAssets: typeof env.ASSETS?.fetch === 'function',
        hasMergeToken: !!(env.YT_MERGE_TOKEN || '').trim(),
        hasYtCookies: !!(env.YT_COOKIES || env.YT_COOKIE || '').trim(),
        hasYtPoToken: !!(env.YT_PO_TOKEN || env.YT_POT || '').trim(),
      });

    // Turnstile 公开 site key 下发
    if (url.pathname === '/api/turnstile-key')
      return json({ ok: true, siteKey: (env.TURNSTILE_SITE_KEY || '').trim() });

    // 本站解析次数
    if (url.pathname === '/api/stats') {
      let n = 0;
      if (env.FEEDBACK_KV) {
        try {
          n = Number((await env.FEEDBACK_KV.get('stats_parse_youtube')) || 0);
        } catch {}
      }
      return json({ ok: true, parseCount: n });
    }

    if (url.pathname === '/api/feedback') {
      if (request.method === 'POST') return handleFeedbackSubmit(request, env);
      if (request.method === 'DELETE') return handleFeedbackDelete(request, env);
      return json({ ok: false, error: '方法不支持' }, 405);
    }
    if (url.pathname === '/api/feedback/list') return handleFeedbackList(request, env);
    if (url.pathname.startsWith('/api/fb-file/')) return handleFeedbackFile(request, env);
    if (url.pathname === '/api/stats-all') return handleStatsAll(request, env);
    if (url.pathname === '/api/parse-quota') return handleParseQuota(request, env);
    if (url.pathname === '/api/geo-stats') return handleGeoStats(request, env);
    if (url.pathname === '/api/parse-history') return handleParseHistory(request, env);
    if (url.pathname === '/dashboard') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /dashboard?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === '/admin') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /admin?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      try {
        return await env.ASSETS.fetch(request);
      } catch {}
    }
    return new Response('Not Found', { status: 404 });
  },
};
