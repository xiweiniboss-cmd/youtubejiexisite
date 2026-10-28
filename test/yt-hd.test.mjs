import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import worker, {
  classifyPlayability,
  normalizeCookieHeader,
  ytSapiSidAuthorization,
  mergeOriginDown,
  mergeOriginDownMessage,
  ytHdFailureBody,
  loginRequiredMessage,
  pickHdPair,
  findFormatByItag,
  ytHdTiming,
} from '../_worker.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const BOT = 'YouTube 暂时把服务器当成了机器人，这次没有拿到可下载的视频流，过一会再试';

test('bot LOGIN_REQUIRED is not an age gate', () => {
  const kind = classifyPlayability({
    status: 'LOGIN_REQUIRED',
    reason: 'Sign in to confirm you’re not a bot',
    errorScreen: {
      playerErrorMessageRenderer: {
        subreason: { simpleText: 'This helps protect our community. Learn more' },
      },
    },
  });
  assert.equal(kind.kind, 'bot');
  const body = ytHdFailureBody({ sawLogin: false, sawBot: true, cookiesConfigured: false });
  assert.equal(body.code, 'BOT_CHECK');
  assert.equal(body.error, BOT);
});

test('age-gate LOGIN_REQUIRED gets its own Chinese error', () => {
  const ios = classifyPlayability({
    status: 'LOGIN_REQUIRED',
    reason: 'This video may be inappropriate for some users.',
    desktopLegacyAgeGateReason: 1,
  });
  const web = classifyPlayability({
    status: 'LOGIN_REQUIRED',
    reason: 'Sign in to confirm your age',
    desktopLegacyAgeGateReason: 1,
  });
  assert.equal(ios.kind, 'login');
  assert.equal(web.kind, 'login');
  assert.equal(classifyPlayability({ status: 'LOGIN_REQUIRED' }).kind, 'login');
  const body = ytHdFailureBody({
    sawLogin: true,
    sawBot: true,
    loginReason: ios.reason,
    cookiesConfigured: false,
  });
  assert.equal(body.code, 'LOGIN_REQUIRED');
  assert.match(body.error, /已登录的 YouTube 会话/);
  assert.match(body.error, /年龄/);
  assert.match(body.error, /YT_COOKIES/);
  assert.equal(body.reason, ios.reason);
  assert.doesNotMatch(body.error, /当成了机器人/);
});

test('configured cookies change the login guidance but are not echoed', () => {
  const secret = 'LOGIN_INFO=super-secret-session; SAPISID=sap';
  const body = ytHdFailureBody({ sawLogin: true, cookiesConfigured: true, loginReason: 'Sign in to confirm your age' });
  assert.match(body.error, /已读取环境变量 YT_COOKIES/);
  assert.match(loginRequiredMessage(true), /SAPISID/);
  assert.equal(body.error.includes(secret), false);
  assert.equal(JSON.stringify(body).includes('super-secret-session'), false);
});

test('cookie header, JSON export, and Netscape HttpOnly file', () => {
  assert.equal(normalizeCookieHeader(' SAPISID=abc;  LOGIN_INFO=xyz '), 'SAPISID=abc; LOGIN_INFO=xyz');
  assert.equal(
    normalizeCookieHeader('[{"name":"SAPISID","value":"abc"},{"name":"LOGIN_INFO","value":"xyz"}]'),
    'SAPISID=abc; LOGIN_INFO=xyz',
  );
  const netscape = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\txyz',
    '.youtube.com\tTRUE\t/\tFALSE\t0\tSAPISID\tabc',
  ].join('\n');
  assert.equal(normalizeCookieHeader(netscape), 'LOGIN_INFO=xyz; SAPISID=abc');
});

test('SAPISIDHASH uses sha1(timestamp + space + sid + space + origin)', async () => {
  const ts = 1600000000;
  const origin = 'https://www.youtube.com';
  const header = await ytSapiSidAuthorization('SAPISID=abc; __Secure-3PAPISID=def; __Secure-1PAPISID=ghi', origin, ts);
  async function hash(sid) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sid} ${origin}`));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  assert.equal(header, [
    `SAPISIDHASH ${ts}_${await hash('abc')}`,
    `SAPISID1PHASH ${ts}_${await hash('ghi')}`,
    `SAPISID3PHASH ${ts}_${await hash('def')}`,
  ].join(' '));
  const fallback = await ytSapiSidAuthorization('__Secure-3PAPISID=def', origin, ts);
  assert.match(fallback, new RegExp(`^SAPISIDHASH ${ts}_`));
  assert.match(fallback, new RegExp(`SAPISID3PHASH ${ts}_`));
});

test('530 / 1016 becomes Chinese guidance about the merge env', () => {
  assert.equal(mergeOriginDown(530, 'error code: 1016\n'), true);
  assert.equal(mergeOriginDown(200, 'error code: 1016'), true);
  assert.equal(mergeOriginDown(502, '{"ok":false}'), false);
  const msg = mergeOriginDownMessage(530, 'error code: 1016\n');
  assert.match(msg, /530\/1016/);
  assert.match(msg, /YT_MERGE_BASE/);
  assert.match(msg, /YT_MERGE_TOKEN/);
  assert.match(msg, /EC2/);
});

function playerJson(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function playerOk() {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'public' },
    streamingData: {
      adaptiveFormats: [
        { url: 'https://example.com/v', mimeType: 'video/mp4; codecs="avc1.4d401f"', height: 1080, width: 1920, contentLength: '10', bitrate: 100, itag: 137 },
        { url: 'https://example.com/a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: '5', bitrate: 50, itag: 140 },
      ],
    },
  };
}

test('public videos resolve on the anonymous client before cookies are sent', async () => {
  const orig = globalThis.fetch;
  const playerCalls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/player')) {
      playerCalls.push(init?.headers?.Cookie || '');
      return playerJson(playerOk());
    }
    return new Response('nope', { status: 404 });
  };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/yt-hd?url=https://youtu.be/dQw4w9WgXcQ'),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret' },
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.client, 'vr');
    assert.equal(body.video.height, 1080);
    assert.equal(playerCalls.length, 1);
    assert.equal(playerCalls[0], '');
    assert.equal(JSON.stringify(body).includes('super-secret-session'), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('age-gated video succeeds once the player accepts the configured cookie', async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('sw.js_data')) return new Response('"Cgabcdefghijklmnopqrstuvwxyz"', { status: 200 });
    if (!u.includes('/youtubei/v1/player')) return new Response('nope', { status: 404 });
    const headers = init?.headers || {};
    const cookie = headers.Cookie || '';
    seen.push({ cookie, auth: headers.Authorization || '', po: JSON.parse(init.body).serviceIntegrityDimensions?.poToken || '' });
    if (cookie.includes('LOGIN_INFO=super-secret-session')) return playerJson(playerOk());
    return playerJson({
      playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age', desktopLegacyAgeGateReason: 1 },
    });
  };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/yt-hd?url=https://youtu.be/07FYdnEawAQ'),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret', YT_PO_TOKEN: 'player-pot' },
    );
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.video.itag, 137);
    assert.ok(seen.some((s) => s.cookie === ''));
    const authed = seen.find((s) => s.cookie.includes('LOGIN_INFO=super-secret-session'));
    assert.ok(authed);
    assert.match(authed.auth, /^SAPISIDHASH \d+_[0-9a-f]+$/);
    assert.equal(authed.po, 'player-pot');
    assert.equal(JSON.stringify(body).includes('super-secret-session'), false);
    assert.equal(JSON.stringify(body).includes('sap-secret'), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('age gate without cookies does not claim the server was treated as a bot', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
    return playerJson({
      playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'This video may be inappropriate for some users.', desktopLegacyAgeGateReason: 1 },
    });
  };
  try {
    const res = await worker.fetch(new Request('https://example.com/api/yt-hd?url=07FYdnEawAQ'), {});
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.code, 'LOGIN_REQUIRED');
    assert.match(body.error, /年龄限制或登录墙/);
    assert.doesNotMatch(body.error, /机器人/);
    assert.ok(body.tried.every((t) => t.endsWith(':login')));
  } finally {
    globalThis.fetch = orig;
  }
});

test('merge proxy rewrites a Cloudflare 1016 body and passes JSON through', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/yt1080-jobs')) {
      return new Response('error code: 1016\n', { status: 530 });
    }
    return orig(url, init);
  };
  try {
    const missing = await worker.fetch(new Request('https://example.com/api/yt1080-start?url=https://youtu.be/dQw4w9WgXcQ'), {});
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /YT_MERGE_TOKEN/);
    assert.equal(calls.length, 0);

    const down = await worker.fetch(
      new Request('https://example.com/api/yt1080-start?url=https://youtu.be/dQw4w9WgXcQ&quality=720&mode=silent', { method: 'POST' }),
      { YT_MERGE_TOKEN: 'local-test-token' },
    );
    const body = await down.json();
    assert.equal(down.status, 502);
    assert.equal(body.code, 'MERGE_ORIGIN_DOWN');
    assert.match(body.error, /YT_MERGE_BASE/);
    assert.equal(JSON.stringify(body).includes('local-test-token'), false);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = orig;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, job_id: 'job1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const ok = await worker.fetch(
      new Request('https://example.com/api/yt1080-start?url=https://youtu.be/dQw4w9WgXcQ'),
      { YT_MERGE_TOKEN: 'local-test-token' },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, job_id: 'job1' });
  } finally {
    globalThis.fetch = orig;
  }
});

function playerAt(height, { progressive = false } = {}) {
  if (progressive) {
    return {
      playabilityStatus: { status: 'OK' },
      videoDetails: { title: 'progressive' },
      streamingData: {
        formats: [
          { url: 'https://example.com/p' + height, mimeType: 'video/mp4; codecs="avc1.4d401f, mp4a.40.2"', height, width: 1280, contentLength: '8', bitrate: 40, itag: 22 },
        ],
      },
    };
  }
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'adaptive' },
    streamingData: {
      adaptiveFormats: [
        { url: 'https://example.com/v' + height, mimeType: 'video/mp4; codecs="avc1.4d401f"', height, width: 1280, contentLength: '10', bitrate: height, itag: height >= 1080 ? 137 : 136 },
        { url: 'https://example.com/a' + height, mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: '5', bitrate: 50, itag: 140 },
      ],
    },
  };
}
const BOT_PS = { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" };

test('pickHdPair keeps a 720 progressive file when adaptive avc1 is missing', () => {
  const pair = pickHdPair(playerAt(720, { progressive: true }));
  assert.equal(pair.height, 720);
  assert.equal(pair.progressive, true);
  assert.equal(pair.audio, null);
  const mixed = pickHdPair({
    streamingData: {
      adaptiveFormats: [
        { url: 'https://example.com/v360', mimeType: 'video/mp4; codecs="avc1.4d401e"', height: 360, bitrate: 10, itag: 134 },
        { url: 'https://example.com/a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 50, itag: 140 },
      ],
      formats: [
        { url: 'https://example.com/p720', mimeType: 'video/mp4; codecs="avc1.4d401f, mp4a.40.2"', height: 720, bitrate: 80, itag: 22 },
      ],
    },
  });
  assert.equal(mixed.height, 720);
  assert.equal(mixed.progressive, true);
});

test('a later 1080 replaces an earlier 720, and a later bot does not drop the 720', async () => {
  const orig = globalThis.fetch;
  const delays = ytHdTiming.botRetryDelaysMs;
  ytHdTiming.botRetryDelaysMs = [0, 0];
  try {
    const upgrade = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
      const name = JSON.parse(init.body).context.client.clientName;
      upgrade.push(name);
      if (name === 'IOS') return playerJson(playerAt(1080));
      if (name === 'ANDROID_VR') return playerJson(playerAt(720));
      return playerJson({ playabilityStatus: BOT_PS });
    };
    const up = await worker.fetch(new Request('https://example.com/api/yt-hd?url=https://youtu.be/mOzcOE03prg'), {});
    const upBody = await up.json();
    assert.equal(up.status, 200);
    assert.equal(upBody.ok, true);
    assert.equal(upBody.client, 'ios');
    assert.equal(upBody.video.height, 1080);
    assert.equal(upBody.capped, false);
    assert.equal(upBody.audio.itag, 140);
    assert.deepEqual(upgrade, ['ANDROID_VR', 'IOS']);

    const kept = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
      const name = JSON.parse(init.body).context.client.clientName;
      kept.push(name);
      if (name === 'ANDROID_VR' && kept.filter((n) => n === 'ANDROID_VR').length === 1) return playerJson(playerAt(720));
      return playerJson({ playabilityStatus: BOT_PS });
    };
    const low = await worker.fetch(new Request('https://example.com/api/yt-hd?url=mOzcOE03prg'), {});
    const lowBody = await low.json();
    assert.equal(low.status, 200);
    assert.equal(lowBody.client, 'vr');
    assert.equal(lowBody.video.height, 720);
    assert.equal(lowBody.capped, true);
    assert.equal(lowBody.progressive, false);
    assert.doesNotMatch(JSON.stringify(lowBody), /1080P/);
  } finally {
    ytHdTiming.botRetryDelaysMs = delays;
    globalThis.fetch = orig;
  }
});

test('progressive 720 is returned instead of BOT_CHECK when later clients are bot-walled', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
    const name = JSON.parse(init.body).context.client.clientName;
    if (name === 'ANDROID_VR') return playerJson(playerAt(720, { progressive: true }));
    return playerJson({ playabilityStatus: BOT_PS });
  };
  try {
    const res = await worker.fetch(new Request('https://example.com/api/yt-hd?url=https://youtu.be/mOzcOE03prg'), {});
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.video.height, 720);
    assert.equal(body.progressive, true);
    assert.equal(body.audio, null);
    assert.equal(body.capped, true);
  } finally {
    globalThis.fetch = orig;
  }
});

test('bot wall retries anonymous clients and does not attach cookies to ios/android/vr', async () => {
  const orig = globalThis.fetch;
  const delays = ytHdTiming.botRetryDelaysMs;
  ytHdTiming.botRetryDelaysMs = [0, 0];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('sw.js_data')) return new Response('"Cgabcdefghijklmnopqrstuvwxyz012345"', { status: 200 });
    const headers = init?.headers || {};
    const body = JSON.parse(init.body);
    const name = body.context.client.clientName;
    const cookie = headers.Cookie || '';
    calls.push({ name, cookie: cookie ? 'yes' : 'no' });
    const iosAnon = calls.filter((c) => c.name === 'IOS' && c.cookie === 'no').length;
    if (name === 'IOS' && !cookie && iosAnon >= 3) return playerJson(playerAt(720));
    if (name === 'WEB') {
      return playerJson({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Please sign in' } });
    }
    return playerJson({ playabilityStatus: BOT_PS });
  };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/yt-hd?url=https://youtu.be/mOzcOE03prg'),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret; PREF=hl=zh-CN&gl=HK' },
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.client, 'ios');
    assert.equal(body.video.height, 720);
    assert.equal(body.capped, true);
    const mobile = calls.filter((c) => c.name === 'IOS' || c.name === 'ANDROID' || c.name === 'ANDROID_VR');
    assert.ok(mobile.length >= 3);
    assert.ok(mobile.every((c) => c.cookie === 'no'));
    assert.ok(calls.some((c) => c.name === 'MWEB' && c.cookie === 'yes'));
    assert.equal(JSON.stringify(body).includes('super-secret-session'), false);
    const authed = calls.find((c) => c.cookie === 'yes');
    assert.ok(authed);
  } finally {
    ytHdTiming.botRetryDelaysMs = delays;
    globalThis.fetch = orig;
  }
});

test('a pure bot wall stays BOT_CHECK and does not claim 1080P is the thing that failed', async () => {
  const orig = globalThis.fetch;
  const delays = ytHdTiming.botRetryDelaysMs;
  ytHdTiming.botRetryDelaysMs = [0, 0];
  globalThis.fetch = async (url) => {
    if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
    return playerJson({ playabilityStatus: BOT_PS });
  };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/yt-hd?url=https://youtu.be/mOzcOE03prg'),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret' },
    );
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, 'BOT_CHECK');
    assert.equal(body.error, BOT);
    assert.doesNotMatch(body.error, /1080/);
    assert.ok(body.tried.some((t) => t.startsWith('ios') && t.endsWith(':bot')));
    assert.ok(body.tried.every((t) => !/^(vr|ios|android)(\+vd)?\+ck:/.test(t)));
    const masked = ytHdFailureBody({ sawLogin: true, sawBot: true, loginReason: 'Please sign in', cookiesConfigured: true });
    assert.equal(masked.code, 'BOT_CHECK');
  } finally {
    ytHdTiming.botRetryDelaysMs = delays;
    globalThis.fetch = orig;
  }
});

test('diag hasYtPoToken follows the env var and does not echo it', async () => {
  const empty = await (await worker.fetch(new Request('https://example.com/api/diag'), {})).json();
  assert.equal(empty.hasYtPoToken, false);
  assert.equal(empty.hasYtCookies, false);
  const blank = await (await worker.fetch(new Request('https://example.com/api/diag'), { YT_PO_TOKEN: '   ', YT_POT: '\n' })).json();
  assert.equal(blank.hasYtPoToken, false);
  const set = await (await worker.fetch(new Request('https://example.com/api/diag'), { YT_POT: 'player-pot-secret' })).json();
  assert.equal(set.hasYtPoToken, true);
  assert.equal(JSON.stringify(set).includes('player-pot-secret'), false);
});

test('index.html failure copy follows the real code and 720 is a real button', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const mergeJs = readFileSync(new URL('../ytmerge.js', import.meta.url), 'utf8');
  assert.equal(html.includes('暂时没拿到 1080P'), false);
  assert.equal(html.includes('没拿到 1080P'), false);
  assert.match(html, /正在获取可用画质/);
  assert.match(html, /function hdFailText/);
  assert.match(html, /hdFailText\(e\)/);
  assert.match(html, /一键下载 ' \+ px \+ 'P/);
  assert.match(html, /下载 ' \+ px \+ 'P（已含声音/);
  assert.match(html, /这是当前最高可用画质/);
  assert.match(html, /h\.progressive \|\| !h\.audio/);
  assert.match(html, /var hdVid = h\.videoId \|\| d\.videoId/);
  assert.match(html, /streamSpec\(h\.video, hdVid, h\.client\)/);
  assert.match(html, /mergeDownload\(h\.video, h\.audio, d\.title \|\| 'youtube', hb, h\.client, hdVid\)/);
  assert.match(html, /downloadResource\(r\.url,/);
  assert.match(html, /mergeDownload\(best, bestA,/);
  assert.match(html, /function formatDlError/);
  assert.match(html, /直链失效/);
  assert.match(mergeJs, /\/api\/ytdl\?v=/);
  assert.match(mergeJs, /spec\.itag/);
  assert.match(mergeJs, /\/api\/ytdl\?url=/);
});

test('findFormatByItag ignores cipher-only formats', () => {
  const fmt = findFormatByItag({
    streamingData: {
      formats: [{ itag: 22, signatureCipher: 's=1' }],
      adaptiveFormats: [
        { itag: 136, url: 'https://rr.googlevideo.com/v' },
        { itag: 140, url: 'https://rr.googlevideo.com/a' },
      ],
    },
  }, 136);
  assert.equal(fmt.url, 'https://rr.googlevideo.com/v');
  assert.equal(findFormatByItag({ streamingData: { formats: [{ itag: 22, signatureCipher: 'x' }] } }, 22), null);
  assert.equal(findFormatByItag({ streamingData: { adaptiveFormats: [{ itag: 140, url: 'https://rr.googlevideo.com/a' }] } }, '140').url, 'https://rr.googlevideo.com/a');
});

function ytdlPlayer(itag, mediaUrl) {
  return {
    playabilityStatus: { status: 'OK' },
    streamingData: {
      adaptiveFormats: [
        { itag, url: mediaUrl, mimeType: 'video/mp4; codecs="avc1"', height: 720, contentLength: '1000' },
        { itag: 140, url: 'https://rr3.googlevideo.com/audio', mimeType: 'audio/mp4', contentLength: '40' },
      ],
    },
  };
}

test('ytdl re-resolves itag in the same request, forwards Range, and ignores a stale url', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  const fresh = 'https://rr1---sn.googlevideo.com/videoplayback?id=fresh&ip=this-request';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const headers = init?.headers || {};
    calls.push({
      u,
      range: headers.Range || '',
      cookie: headers.Cookie || '',
      ua: headers['User-Agent'] || '',
      name: init?.body ? JSON.parse(init.body).context.client.clientName : '',
    });
    if (u.includes('/youtubei/v1/player')) return playerJson(ytdlPlayer(136, fresh));
    if (u === fresh) {
      return new Response('ftyp', {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '4',
          'Content-Range': 'bytes 0-99/1000',
        },
      });
    }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const stale = encodeURIComponent('https://stale.googlevideo.com/videoplayback?id=old&ip=other-edge');
    const res = await worker.fetch(
      new Request(
        'https://example.com/api/ytdl?v=dQw4w9WgXcQ&itag=136&client=vr&filename=clip.mp4&url=' + stale,
        { headers: { Range: 'bytes=0-99' } },
      ),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret' },
    );
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Type'), 'video/mp4');
    assert.equal(res.headers.get('Content-Range'), 'bytes 0-99/1000');
    assert.equal(res.headers.get('Content-Length'), '4');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'Content-Range, Content-Length');
    assert.match(res.headers.get('Content-Disposition') || '', /filename="clip\.mp4"/);
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await res.text(), 'ftyp');
    const players = calls.filter((c) => c.u.includes('/youtubei/v1/player'));
    assert.equal(players.length, 1);
    assert.equal(players[0].name, 'ANDROID_VR');
    assert.equal(players[0].cookie, '');
    assert.match(players[0].ua, /youtube\.vr\.oculus/);
    const media = calls.filter((c) => c.u.includes('googlevideo.com'));
    assert.equal(media.length, 1);
    assert.equal(media[0].u, fresh);
    assert.equal(media[0].range, 'bytes=0-99');
    assert.equal(media[0].cookie, '');
    assert.match(media[0].ua, /youtube\.vr\.oculus/);
    assert.equal(calls.some((c) => c.u.includes('stale.googlevideo.com')), false);
    assert.equal(JSON.stringify(calls).includes('super-secret-session'), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('ytdl cookie client sends Cookie on the player and the media fetch', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  const fresh = 'https://rr2.googlevideo.com/videoplayback?id=web';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const headers = init?.headers || {};
    const name = init?.body ? JSON.parse(init.body).context.client.clientName : '';
    calls.push({ u, name, cookie: headers.Cookie || '', referer: headers.Referer || '', auth: headers.Authorization || '' });
    if (u.includes('/youtubei/v1/player')) return playerJson(ytdlPlayer(22, fresh));
    if (u === fresh) return new Response('ok', { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '2' } });
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/ytdl?v=dQw4w9WgXcQ&itag=22&client=web&filename=p.mp4'),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret' },
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(calls.filter((c) => c.name === 'WEB').length, 1);
    assert.equal(calls.some((c) => c.name === 'ANDROID_VR' || c.name === 'IOS' || c.name === 'ANDROID'), false);
    const media = calls.find((c) => c.u === fresh);
    assert.ok(media);
    assert.match(media.cookie, /LOGIN_INFO=super-secret-session/);
    assert.equal(media.referer, 'https://www.youtube.com/');
    assert.equal(media.auth, '');
    assert.equal(JSON.stringify({ status: res.status }).includes('super-secret-session'), false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('ytdl 403 becomes a Chinese 直链失效 error and the legacy url proxy still streams', async () => {
  const orig = globalThis.fetch;
  let mediaHits = 0;
  let playerN = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('sw.js_data')) return new Response('none', { status: 200 });
    if (u.includes('/youtubei/v1/player')) {
      playerN += 1;
      return playerJson(ytdlPlayer(136, 'https://rr' + playerN + '.googlevideo.com/videoplayback?id=x'));
    }
    if (u.includes('googlevideo.com/videoplayback')) {
      mediaHits++;
      assert.equal(init?.headers?.Cookie || '', '');
      return new Response('nope', { status: 403 });
    }
    if (u === 'https://rr.googlevideo.com/legacy') {
      assert.equal(init?.headers?.Range, 'bytes=0-1');
      assert.match(init?.headers?.['User-Agent'] || '', /youtube\.vr\.oculus/);
      return new Response('ab', {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 0-1/9' },
      });
    }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const denied = await worker.fetch(
      new Request('https://example.com/api/ytdl?v=dQw4w9WgXcQ&itag=136&client=vr&filename=x.mp4', {
        headers: { Range: 'bytes=0-7' },
      }),
      { YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret' },
    );
    assert.equal(denied.status, 502);
    const body = await denied.json();
    assert.match(body.error, /直链失效/);
    assert.match(body.error, /403/);
    assert.equal(body.error.includes('super-secret-session'), false);
    assert.ok(mediaHits >= 1 && mediaHits <= 3);

    const legacy = await worker.fetch(
      new Request('https://example.com/api/ytdl?url=' + encodeURIComponent('https://rr.googlevideo.com/legacy') + '&filename=z.mp4&ua=vr', {
        headers: { Range: 'bytes=0-1' },
      }),
      {},
    );
    assert.equal(legacy.status, 206);
    assert.equal(legacy.headers.get('Content-Range'), 'bytes 0-1/9');
    assert.match(legacy.headers.get('Content-Disposition') || '', /z\.mp4/);
    assert.equal(await legacy.text(), 'ab');

    const bad = await worker.fetch(new Request('https://example.com/api/ytdl?v=short&itag=18'), {});
    assert.equal(bad.status, 400);
    const badHost = await worker.fetch(new Request('https://example.com/api/ytdl?url=' + encodeURIComponent('https://evil.example/a')), {});
    assert.equal(badHost.status, 400);
    assert.match((await badHost.json()).error, /不支持的下载地址/);
  } finally {
    globalThis.fetch = orig;
  }
});
