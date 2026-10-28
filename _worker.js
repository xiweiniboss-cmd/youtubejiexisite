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
// 服务器合并 /api/yt1080-*（前端不持有口令，由 Worker 转发）：
//   YT_MERGE_TOKEN  与 EC2 合并服务口令一致；不配则接口直接说明未配置
//   YT_MERGE_BASE   EC2 根地址，默认 http://3-129-45-49.sslip.io:30002
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
// googlevideo 不发送 CORS 头，手机端 fetch 会被拦；由 Worker 中转后加 CORS 头返回
async function handleYtDl(request) {
  const u = new URL(request.url);
  const mediaUrl = u.searchParams.get('url') || '';
  const filename = (u.searchParams.get('filename') || 'youtube_video.mp4').replace(/["\r\n]/g, '').slice(0, 80) || 'youtube_video.mp4';
  let target = null;
  try { target = new URL(mediaUrl); } catch {
    return json({ ok: false, error: '无效的下载地址' }, 400);
  }
  // 仅允许 googlevideo / youtube 媒体域名
  const allowed = /(^|\.)googlevideo\.com$|(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)ytimg\.com$/i;
  if (!/^https:$/.test(target.protocol) || !allowed.test(target.hostname))
    return json({ ok: false, error: '不支持的下载地址' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const upHeaders = { 'User-Agent': YT_UA[u.searchParams.get('ua') || ''] || UA_PC, Accept: '*/*' };
    const range = request.headers.get('Range');   // 浏览器合并时分段下载
    if (range && /^bytes=\d+-\d*$/.test(range)) upHeaders['Range'] = range;
    const resp = await fetch(mediaUrl, {
      headers: upHeaders,
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body)
      return json({ ok: false, error: '下载失败（HTTP ' + resp.status + '）' }, 502);
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
const YT_UA = Object.fromEntries(YT_CLIENTS.map((c) => [c.key, c.ua]));

// 带 Cookie 时额外试这些客户端。ANDROID / IOS 不吃网页登录态，TV / MWEB 才会用 YT_COOKIES。
const YT_COOKIE_CLIENTS = [
  { key: 'tv', name: 'TVHTML5', id: 7, version: '7.20260707.07.00',
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    extra: {} },
  { key: 'mweb', name: 'MWEB', id: 2, version: '2.20260708.05.00',
    ua: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    extra: {} },
];

let ytVisitorCache = '';
async function ytVisitorData() {
  if (ytVisitorCache) return ytVisitorCache;
  try {
    const r = await fetch('https://www.youtube.com/sw.js_data', { headers: { 'User-Agent': UA_PC } });
    const t = await r.text();
    const m = t.match(/"(Cg[A-Za-z0-9_%-]{20,})"/);
    ytVisitorCache = m ? decodeURIComponent(m[1]) : '';
  } catch { ytVisitorCache = ''; }
  return ytVisitorCache;
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
  const bot = /not a bot|confirm you.?re not a bot|unusual traffic|机器人/i.test(text);
  const age = (ps?.desktopLegacyAgeGateReason != null && ps.desktopLegacyAgeGateReason !== 0)
    || /inappropriate for some users|confirm your age|age[- ]restricted|年龄限制|确认你的年龄|确认您的年龄/i.test(text)
    || status === 'AGE_CHECK_REQUIRED'
    || status === 'AGE_VERIFICATION_REQUIRED';
  if (status === 'OK') return { kind: 'ok', status, reason };
  if (bot && !age) return { kind: 'bot', status, reason };
  if (age || status === 'LOGIN_REQUIRED') return { kind: 'login', status, reason };
  return { kind: 'other', status, reason };
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

const YT_BOT_ERROR = 'YouTube 暂时把服务器当成了机器人，没拿到高清流，过一会再试';

export function ytHdFailureBody(state) {
  if (state?.sawLogin) {
    const body = {
      ok: false,
      code: 'LOGIN_REQUIRED',
      error: loginRequiredMessage(!!state.cookiesConfigured),
    };
    if (state.loginReason) body.reason = String(state.loginReason).slice(0, 180);
    return body;
  }
  return {
    ok: false,
    code: state?.sawBot ? 'BOT_CHECK' : 'UNAVAILABLE',
    error: YT_BOT_ERROR,
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
  const context = {
    client: { clientName: c.name, clientVersion: c.version, hl: 'en', gl: 'US', ...(visitorData ? { visitorData } : {}), ...c.extra },
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

function hdStream(j) {
  const fmts = (j?.streamingData?.adaptiveFormats || []).filter((f) => f.url);
  const vids = fmts.filter((f) => /^video\/mp4/.test(f.mimeType) && /avc1/.test(f.mimeType) && (f.height || 0) <= 1080)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const auds = fmts.filter((f) => /^audio\/mp4/.test(f.mimeType)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return { fmts, vids, auds };
}

// 先按原来的匿名客户端取流（公开视频行为不变）。配了 YT_COOKIES 仍失败时，再带 Cookie / SAPISIDHASH 重试，并加上 TV、MWEB。
async function ytHdTry(vid, clients, auth, tried, state) {
  for (const round of [0, 1]) {
    const vd = round ? await ytVisitorData() : '';
    for (const c of clients) {
      let j;
      try { j = await ytPlayer(vid, c, vd, auth); } catch (e) { tried.push(c.key + ':err'); continue; }
      const kind = classifyPlayability(j?.playabilityStatus);
      const { fmts, vids, auds } = hdStream(j);
      tried.push(c.key + (round ? '+vd' : '') + (auth?.cookie ? '+ck' : '') + ':' + (kind.status || 'none') + ':' + fmts.length + ':' + kind.kind);
      if (kind.kind === 'login') {
        state.sawLogin = true;
        if (!state.loginReason && kind.reason) state.loginReason = kind.reason;
      } else if (kind.kind === 'bot') state.sawBot = true;
      if (kind.status !== 'OK' || !vids.length || !auds.length) continue;
      const v = vids[0], a = auds[0];
      return json({
        ok: true, videoId: vid, client: c.key,
        title: j?.videoDetails?.title || '',
        video: { url: v.url, height: v.height, width: v.width, size: +v.contentLength || 0, itag: v.itag },
        audio: { url: a.url, size: +a.contentLength || 0, itag: a.itag },
      });
    }
  }
  return null;
}

async function handleYtHd(request, env) {
  const u = new URL(request.url);
  const src = u.searchParams.get('url') || '';
  const m = src.match(/(?:[?&]v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || src.match(/^([A-Za-z0-9_-]{11})$/);
  if (!m) return json({ ok: false, error: '没找到视频 ID' }, 400);
  const vid = m[1];
  const auth = await ytAuthFromEnv(env);
  const tried = [];
  const state = { sawLogin: false, sawBot: false, loginReason: '', cookiesConfigured: !!auth.cookie };
  ytVisitorCache = '';
  const anon = await ytHdTry(vid, YT_CLIENTS, { poToken: auth.poToken }, tried, state);
  if (anon) return anon;
  if (auth.cookie) {
    const loggedIn = await ytHdTry(vid, YT_CLIENTS.concat(YT_COOKIE_CLIENTS), auth, tried, state);
    if (loggedIn) return loggedIn;
  }
  const body = ytHdFailureBody(state);
  body.tried = tried;
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
      body: JSON.stringify({ url: ytUrl, quality: quality, mode: mode }),
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
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers });
  } catch (e) {
    return mergeConnectError(e);
  }
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/parse') return handleParse(request, env);
    if (url.pathname === '/api/ytdl') return handleYtDl(request);
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
