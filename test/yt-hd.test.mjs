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
  mergeFormat,
  mergeCodecVerdict,
  sniffMergedHead,
  rfc5987,
  dispositionFilename,
  withKnownLength,
} from '../_worker.js';
import { spawnSync } from 'node:child_process';

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
  assert.match(html, /mergeDownload\(best, bestA, d\.title \|\| 'youtube', mb, '', d\.videoId/);
  assert.match(html, /r\.itag = it/);
  assert.match(html, /function offerServerMerge/);
  assert.match(html, /e\.serverMerge && \(code === 'BOT_CHECK' \|\| code === 'UNAVAILABLE'\)/);
  assert.match(html, /function startServerMerge/);
  assert.match(html, /服务器合并 ' \+ q \+ 'P/);
  assert.match(html, /复制直链/);
  assert.match(html, /function formatDlError/);
  assert.match(html, /直链失效/);
  assert.match(mergeJs, /\/api\/ytdl\?v=/);
  assert.match(mergeJs, /spec\.itag/);
  assert.match(mergeJs, /\/api\/ytdl\?url=/);
  assert.match(mergeJs, /&url=/);
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

test('ytdl falls back to the parse-time url when re-resolve misses or media is 403', async () => {
  const orig = globalThis.fetch;
  const fallback = 'https://rr.googlevideo.com/videoplayback?id=redfox';
  const fresh = 'https://fresh.googlevideo.com/videoplayback?id=new';
  let mode = 'miss';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const headers = init?.headers || {};
    calls.push({ u, cookie: headers.Cookie || '', range: headers.Range || '' });
    if (u.includes('sw.js_data')) return new Response('none', { status: 200 });
    if (u.includes('/youtubei/v1/player')) {
      if (mode === 'miss') return playerJson({ playabilityStatus: BOT_PS });
      return playerJson({
        playabilityStatus: { status: 'OK' },
        streamingData: { formats: [{ itag: 18, url: fresh, mimeType: 'video/mp4; codecs="avc1"' }] },
      });
    }
    if (u === fresh) return new Response('no', { status: 403 });
    if (u === fallback) {
      if (mode === 'both') return new Response('no', { status: 403 });
      return new Response('ftyp', {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4', 'Content-Range': 'bytes 0-15/100' },
      });
    }
    throw new Error('unexpected ' + u);
  };
  const q = 'https://example.com/api/ytdl?v=mOzcOE03prg&itag=18&filename=a.mp4&url=' + encodeURIComponent(fallback);
  try {
    mode = 'miss';
    const ok = await worker.fetch(new Request(q, { headers: { Range: 'bytes=0-15' } }), {
      YT_COOKIES: 'LOGIN_INFO=super-secret-session; SAPISID=sap-secret',
    });
    assert.equal(ok.status, 206);
    assert.equal(ok.headers.get('Content-Range'), 'bytes 0-15/100');
    assert.equal(await ok.text(), 'ftyp');
    assert.ok(calls.some((c) => c.u.includes('/youtubei/v1/player')));
    const fb = calls.filter((c) => c.u === fallback);
    assert.equal(fb.length, 1);
    assert.equal(fb[0].range, 'bytes=0-15');
    assert.equal(fb[0].cookie, '');
    assert.equal(calls.some((c) => c.u === fresh), false);
    assert.equal(JSON.stringify(calls).includes('super-secret-session'), false);

    mode = '403';
    calls.length = 0;
    const viaFallback = await worker.fetch(new Request(q, { headers: { Range: 'bytes=0-15' } }), {});
    assert.equal(viaFallback.status, 206);
    assert.equal(await viaFallback.text(), 'ftyp');
    assert.equal(calls.some((c) => c.u === fresh), true);
    assert.equal(calls.filter((c) => c.u === fallback).length, 1);

    mode = 'both';
    const denied = await worker.fetch(new Request(q, { headers: { Range: 'bytes=0-15' } }), {});
    assert.equal(denied.status, 502);
    const body = await denied.json();
    assert.match(body.error, /直链失效/);
    assert.match(body.error, /403/);
    assert.match(body.error, /复制直链/);
    assert.match(body.error, /服务器合并/);
    assert.match(body.error, /都失败了/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('bot-gated yt-hd offers server merge only when YT_MERGE_TOKEN is set', async () => {
  const orig = globalThis.fetch;
  const delays = ytHdTiming.botRetryDelaysMs;
  ytHdTiming.botRetryDelaysMs = [0, 0];
  globalThis.fetch = async (url) => {
    if (String(url).includes('sw.js_data')) return new Response('none', { status: 200 });
    return playerJson({ playabilityStatus: BOT_PS });
  };
  try {
    const hidden = await worker.fetch(new Request('https://example.com/api/yt-hd?url=mOzcOE03prg'), {});
    const hiddenBody = await hidden.json();
    assert.equal(hidden.status, 503);
    assert.equal(hiddenBody.code, 'BOT_CHECK');
    assert.equal(hiddenBody.serverMerge, undefined);
    assert.match(hiddenBody.error, /机器人/);

    const shown = await worker.fetch(
      new Request('https://example.com/api/yt-hd?url=mOzcOE03prg'),
      { YT_MERGE_TOKEN: 'merge-secret' },
    );
    const shownBody = await shown.json();
    assert.equal(shown.status, 503);
    assert.equal(shownBody.code, 'BOT_CHECK');
    assert.equal(shownBody.serverMerge, true);
    assert.equal(JSON.stringify(shownBody).includes('merge-secret'), false);
  } finally {
    ytHdTiming.botRetryDelaysMs = delays;
    globalThis.fetch = orig;
  }
});

test('non-JSON merge 500 becomes a Chinese origin-down error', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  try {
    const res = await worker.fetch(
      new Request('https://example.com/api/yt1080-start?url=https://youtu.be/mOzcOE03prg&quality=720&mode=merged', { method: 'POST' }),
      { YT_MERGE_TOKEN: 'local-test-token' },
    );
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.code, 'MERGE_ORIGIN_DOWN');
    assert.match(body.error, /合并服务器连不上或内部出错/);
    assert.match(body.error, /HTTP 500/);
    assert.match(body.error, /复制直链/);
    assert.equal(JSON.stringify(body).includes('local-test-token'), false);
  } finally {
    globalThis.fetch = orig;
  }
});


// ---- iPhone 相册兼容：只要 H.264 + AAC ----
const avAdaptive = [
  { itag: 137, url: 'https://v/137', mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, bitrate: 4e6 },
  { itag: 136, url: 'https://v/136', mimeType: 'video/mp4; codecs="avc1.4D401F"', height: 720, bitrate: 2e6 },
  { itag: 398, url: 'https://v/398', mimeType: 'video/mp4; codecs="av01.0.05M.08"', height: 720, bitrate: 1.5e6 },
  { itag: 247, url: 'https://v/247', mimeType: 'video/webm; codecs="vp9"', height: 720, bitrate: 1.5e6 },
  { itag: 251, url: 'https://v/251', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
];
const aac140 = { itag: 140, url: 'https://v/140', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 };
const prog18 = { itag: 18, url: 'https://v/18', mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', height: 360, bitrate: 6e5 };

test('pickHdPair pairs avc1 only with AAC, never with Opus', () => {
  const r = pickHdPair({ streamingData: { formats: [prog18], adaptiveFormats: [...avAdaptive, aac140] } });
  assert.equal(r.video.itag, 137);
  assert.equal(r.audio.itag, 140);
  const noAac = pickHdPair({ streamingData: { formats: [prog18], adaptiveFormats: avAdaptive } });
  assert.ok(!noAac || !noAac.audio || noAac.audio.itag !== 251, 'must not fall back to Opus');
  if (noAac) assert.equal(noAac.video.itag, 18);
  const nothing = pickHdPair({ streamingData: { formats: [], adaptiveFormats: avAdaptive } });
  assert.equal(nothing, null);
});

test('mergeFormat asks EC2 yt-dlp for avc1 + mp4a first and always ends with a fallback', () => {
  assert.equal(mergeFormat(720, 'merged'), 'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][ext=mp4][vcodec^=avc1]/b[ext=mp4]/bv*[height<=720]+ba/b');
  assert.equal(mergeFormat(720, 'silent'), 'bv*[height<=720][vcodec^=avc1]/b[height<=720][ext=mp4][vcodec^=avc1]/bv*[height<=720]');
  assert.match(mergeFormat(1080, 'merged'), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\+ba\[acodec\^=mp4a\]/);
  assert.doesNotMatch(mergeFormat(720, 'silent'), /\+ba/);
});

// 没有 avc1 / mp4a 的模拟格式表：只有 AV1、VP9 和 Opus（WeiM_vffWAw 在机房 IP 上的样子去掉 H.264/AAC）。
const NO_AVC_INFO = {
  id: 'noavc0000_1', title: 'no avc', extractor: 'generic', extractor_key: 'Generic', webpage_url: 'https://example.com/v', _type: 'video',
  formats: [
    { format_id: '251', url: 'https://example.com/251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 130, protocol: 'https' },
    { format_id: '247', url: 'https://example.com/247', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 720, width: 1280, tbr: 1500, protocol: 'https' },
    { format_id: '398', url: 'https://example.com/398', ext: 'mp4', vcodec: 'av01.0.05M.08', acodec: 'none', height: 720, width: 1280, tbr: 1400, protocol: 'https' },
    { format_id: '399', url: 'https://example.com/399', ext: 'mp4', vcodec: 'av01.0.08M.08', acodec: 'none', height: 1080, width: 1920, tbr: 2500, protocol: 'https' },
  ],
};
const ytdlp = process.env.YTDLP || 'yt-dlp';
const hasYtdlp = spawnSync(ytdlp, ['--version']).status === 0;
test('yt-dlp still picks something from a format list without avc1 (fallback works)', { skip: !hasYtdlp && 'yt-dlp not installed (set YTDLP=/path)' }, async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'ytm-')), 'info.json');
  writeFileSync(f, JSON.stringify(NO_AVC_INFO));
  const pick = (fmt) => spawnSync(ytdlp, ['-q', '--no-warnings', '--load-info-json', f, '-f', fmt, '--simulate', '--print', '%(format_id)s'], { encoding: 'utf8' });
  const merged = pick(mergeFormat(720, 'merged'));
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(merged.stdout.trim(), '398+251');
  const silent = pick(mergeFormat(720, 'silent'));
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout.trim(), '398');
  // 旧格式串（没有退路）在这里会报 Requested format is not available
  const old = pick('bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][ext=mp4][vcodec^=avc1]/b[ext=mp4]');
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /Requested format is not available/);
});

// ---- 合成的文件头 ----
function box(type, ...parts) {
  const payload = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + payload.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}
const ftyp = (brands) => box('ftyp', 'isom', Buffer.alloc(4), brands);
// 正经的 moov→trak→mdia→minf→stbl→stsd 结构；stsd = FullBox(版本/标志 4 字节 + 条目数 4 字节) + 条目。
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const stsd = (...fmts) => box('stsd', Buffer.alloc(4), u32be(fmts.length), ...fmts.map((f) => box(f, Buffer.alloc(70))));
const trak = (...fmts) => box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('mdhd', Buffer.alloc(24)), box('minf', box('stbl', stsd(...fmts), box('stts', Buffer.alloc(8))))));
const udtaTitle = (t) => box('udta', box('meta', Buffer.alloc(4), box('ilst', box('\u00a9nam', box('data', Buffer.alloc(8), t)))));
const moov = (...entries) => box('moov', box('mvhd', Buffer.alloc(100)), ...entries.map((e) => trak(e)));
const mdat = box('mdat', Buffer.alloc(4096, 7));
const EBML = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 1)]);
const MP4_H264_AAC = Buffer.concat([ftyp('isomiso2avc1mp41'), moov('avc1', 'mp4a'), mdat]);
const MP4_H264_OPUS = Buffer.concat([ftyp('isomiso2avc1mp41'), moov('avc1', 'Opus'), mdat]);
const MP4_AV1_BRAND_TAIL = Buffer.concat([ftyp('isomav01iso2mp41'), mdat, moov('av01', 'Opus')]);
const MP4_MOOV_AT_END = Buffer.concat([ftyp('isomiso2mp41'), mdat, moov('avc1', 'mp4a')]);

test('sniffMergedHead: only stsd sample formats count — titles / udta / mdat text with Opus, av01 pass', () => {
  const titled = Buffer.concat([
    ftyp('isomiso2avc1mp41'),
    box('moov', box('mvhd', Buffer.alloc(100)), trak('avc1'), trak('mp4a'), udtaTitle('Chopin Opus 28 av01 vp09 fLaC')),
    box('mdat', 'Opus av01 vp09 fLaC', Buffer.alloc(2048, 5)),
  ]);
  assert.deepEqual(sniffMergedHead(titled), { kind: 'mp4', ok: true });
  // moov 在尾、标题里有 Opus：读不到 moov 也只是 unknown，不拦
  const tailTitled = Buffer.concat([ftyp('isomiso2mp41'), box('mdat', 'Chopin Opus 28', Buffer.alloc(2048, 5)), box('moov', trak('avc1'), udtaTitle('Opus'))]);
  assert.notEqual(sniffMergedHead(tailTitled).ok, false);
  // 真样本仍然拦
  assert.deepEqual(sniffMergedHead(Buffer.concat([ftyp('isomiso2mp41'), moov('avc1', 'Opus'), mdat])), { kind: 'mp4', ok: false, fmt: 'Opus MP4' });
  assert.deepEqual(sniffMergedHead(Buffer.concat([ftyp('isomiso2mp41'), moov('av01', 'mp4a'), mdat])), { kind: 'mp4', ok: false, fmt: 'AV1 MP4' });
  assert.deepEqual(sniffMergedHead(Buffer.concat([ftyp('isomiso2mp41'), moov('vp09', 'Opus'), mdat])), { kind: 'mp4', ok: false, fmt: 'VP9 + Opus MP4' });
  // 一个 stsd 里多个条目：依次读到第二个
  const multi = Buffer.concat([ftyp('isomiso2mp41'), box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd('mp4a', 'Opus')))))), mdat]);
  assert.equal(sniffMergedHead(multi).ok, false);
  // 64 位 largesize 的 mdat 在前、moov 在后也能走过去
  const big = Buffer.concat([ftyp('isomiso2mp41'), Buffer.concat([u32be(1), Buffer.from('mdat'), u32be(0), u32be(16 + 64), Buffer.alloc(64)]), moov('avc1', 'mp4a')]);
  assert.equal(sniffMergedHead(big).ok, true);
});

test('sniffMergedHead: EBML/AV1/Opus are rejected, avc1+mp4a passes, moov at the end is unknown', () => {
  assert.deepEqual(sniffMergedHead(EBML), { kind: 'webm', ok: false, fmt: 'WebM' });
  assert.equal(sniffMergedHead(MP4_H264_AAC).ok, true);
  assert.equal(sniffMergedHead(MP4_H264_OPUS).ok, false);
  assert.equal(sniffMergedHead(MP4_AV1_BRAND_TAIL).ok, false);
  const tail = sniffMergedHead(MP4_MOOV_AT_END.subarray(0, 1024));
  assert.equal(tail.kind, 'mp4');
  assert.equal(tail.ok, undefined);
  // moov 只读到一半：没看到坏标记就不下结论
  const half = sniffMergedHead(MP4_H264_AAC.subarray(0, 60));
  assert.notEqual(half.ok, false);
  assert.equal(sniffMergedHead(Buffer.from('hello world, not a video')).kind, 'unknown');
});

test('mergeCodecVerdict uses EC2 status codec fields when present', () => {
  assert.equal(mergeCodecVerdict({ status: 'done' }), null);
  assert.deepEqual(mergeCodecVerdict({ vcodec: 'avc1.4D401F', acodec: 'mp4a.40.2', ext: 'mp4' }), { ok: true });
  assert.deepEqual(mergeCodecVerdict({ vcodec: 'h264', acodec: 'none' }), { ok: true });
  assert.equal(mergeCodecVerdict({ vcodec: 'av01.0.05M.08', acodec: 'opus' }).ok, false);
  assert.equal(mergeCodecVerdict({ vcodec: 'avc1', acodec: 'aac', ext: 'webm' }).ok, false);
});

test('rfc5987 escapes quote and brackets', () => {
  assert.equal(rfc5987("a'(b)*.mp4"), 'a%27%28b%29%2A.mp4');
});

function mergeEnvFetch(fileBody, fileHeaders, statusBody) {
  const sent = {};
  const f = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/yt1080-jobs')) { sent.start = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true, job_id: 'j1' }), { headers: { 'content-type': 'application/json' } }); }
    if (u.endsWith('/file')) return new Response(fileBody, { status: 200, headers: fileHeaders });
    return new Response(JSON.stringify(statusBody || { ok: true, status: 'done', filename: 'x.mp4' }), { headers: { 'content-type': 'application/json' } });
  };
  return { f, sent };
}
const ENV = { YT_MERGE_TOKEN: 'local-test-token' };
async function withFetch(f, fn) {
  const orig = globalThis.fetch; globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('yt1080-start forwards the H.264/AAC format with its fallback', async () => {
  const { f, sent } = mergeEnvFetch();
  await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-start?url=https://youtu.be/WeiM_vffWAw&quality=720', { method: 'POST' }), ENV));
  assert.equal(sent.start.format, mergeFormat(720, sent.start.mode || 'merged'));
  assert.equal(sent.start.merge_output_format, 'mp4');
});

test('yt1080-file: a webm is not renamed to .mp4 — it becomes a Chinese MERGE_NOT_IPHONE error', async () => {
  const { f } = mergeEnvFetch(EBML, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="NEFFEX Statement.webm"' });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r.status, 415);
  const j = await r.json();
  assert.equal(j.code, 'MERGE_NOT_IPHONE');
  assert.match(j.error, /iPhone 相册存不了/);
  assert.match(j.error, /360P/);
});

test('yt1080-file: AV1/Opus mp4 (the WeiM_vffWAw file) is rejected even though it is named .mp4', async () => {
  const { f } = mergeEnvFetch(MP4_AV1_BRAND_TAIL, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="a.mp4"' });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r.status, 415);
  assert.equal((await r.json()).code, 'MERGE_NOT_IPHONE');
});

test('yt1080-file: H.264+AAC streams through unchanged as a video/mp4 attachment', async () => {
  const { f } = mergeEnvFetch(MP4_H264_AAC, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename=\"NEFFEX (Statement).mp4\"" });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="NEFFEX \(Statement\)\.mp4"; filename\*=UTF-8''NEFFEX%20%28Statement%29\.mp4$/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), MP4_H264_AAC);
});

test('yt1080-file: undecidable file passes through with its real type and name (no rename)', async () => {
  const body = Buffer.concat([Buffer.from('RIFF....AVI LIST'), Buffer.alloc(2048, 3)]);
  const { f } = mergeEnvFetch(body, { 'content-type': 'video/x-msvideo', 'content-disposition': 'attachment; filename="clip.avi"' });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/x-msvideo');
  assert.match(r.headers.get('content-disposition'), /filename="clip\.avi"/);
  assert.equal(Buffer.from(await r.arrayBuffer()).length, body.length);
  // moov 在文件尾的 mp4：放行
  const t = mergeEnvFetch(MP4_MOOV_AT_END, { 'content-type': 'video/mp4' });
  const r2 = await withFetch(t.f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r2.status, 200);
  assert.match(r2.headers.get('content-disposition'), /filename="youtube_j1\.mp4"/);
});

test('yt1080-file: upstream 200 JSON is not labelled video/mp4', async () => {
  const { f } = mergeEnvFetch(JSON.stringify({ ok: false, error: 'job not ready' }), { 'content-type': 'application/json' });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.match(r.headers.get('content-type'), /json/);
});

test('yt1080-status: done with AV1/Opus codecs becomes MERGE_NOT_IPHONE; without codec fields it passes', async () => {
  const bad = mergeEnvFetch(null, null, { ok: true, status: 'done', vcodec: 'av01.0.05M.08', acodec: 'opus', filename: 'a.mp4' });
  const r = await withFetch(bad.f, () => worker.fetch(new Request('https://example.com/api/yt1080-status?id=j1'), ENV));
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.code, 'MERGE_NOT_IPHONE');
  const plain = mergeEnvFetch(null, null, { ok: true, status: 'done', filename: 'a.mp4', size: 10 });
  const r2 = await withFetch(plain.f, () => worker.fetch(new Request('https://example.com/api/yt1080-status?id=j1'), ENV));
  assert.deepEqual(await r2.json(), { ok: true, status: 'done', filename: 'a.mp4', size: 10 });
});

test('index.html shows MERGE_NOT_IPHONE, forces .mp4 on merged saves, and keeps data-default from page load', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /s\.code === 'MERGE_NOT_IPHONE'/);
  assert.match(html, /e\.code === 'MERGE_NOT_IPHONE'/);
  assert.match(html, /__hkSave\(blob, mergedName\(filename, blob\.type\)\)/);
  assert.doesNotMatch(html, /:not\(:first-child\)/);
  const at = html.indexOf("dlHint = $('dlHint');");
  assert.ok(html.indexOf("setAttribute('data-default'", at) - at < 300);
  const mergeJs = readFileSync(new URL('../ytmerge.js', import.meta.url), 'utf8');
  assert.match(mergeJs, /finally \{[\s\S]*ff\.off\('progress', prog\)/);
  assert.doesNotMatch(mergeJs, /_sniffAudio/);
});

test('dispositionFilename prefers filename* (UTF-8) over the ASCII filename', () => {
  assert.equal(dispositionFilename(`attachment; filename="____.mp4"; filename*=UTF-8''%E8%82%96%E9%82%A6%20Opus%2028.mp4`), '肖邦 Opus 28.mp4');
  assert.equal(dispositionFilename(`attachment; filename*=utf-8'zh'%E4%B8%AD.mp4; filename="x.mp4"`), '中.mp4');
  assert.equal(dispositionFilename('attachment; filename="a \\"b\\".mp4"'), 'a "b".mp4');
  assert.equal(dispositionFilename('attachment; filename=plain.mp4'), 'plain.mp4');
  assert.equal(dispositionFilename(`attachment; filename*=UTF-8''%E0%A4%A; filename="fallback.mp4"`), 'fallback.mp4');
  assert.equal(dispositionFilename(''), '');
});

test('yt1080-file keeps the UTF-8 name from filename*', async () => {
  const { f } = mergeEnvFetch(MP4_H264_AAC, { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="____.mp4"; filename*=UTF-8''%E8%82%96%E9%82%A6.mp4` });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''%E8%82%96%E9%82%A6\.mp4$/);
});

test('withKnownLength pipes through FixedLengthStream when present, and degrades safely when not', async () => {
  const mk = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  const plain = mk();
  assert.equal(withKnownLength(plain, '3'), plain); // Node 里没有 FixedLengthStream
  let seen = null;
  globalThis.FixedLengthStream = class extends TransformStream { constructor(n) { super(); seen = n; } };
  try {
    const s0 = mk();
    assert.equal(withKnownLength(s0, null), s0);
    assert.equal(withKnownLength(s0, 'abc'), s0);
    const out = withKnownLength(mk(), '3');
    assert.equal(seen, 3);
    assert.deepEqual([...new Uint8Array(await new Response(out).arrayBuffer())], [1, 2, 3]);
    const { f } = mergeEnvFetch(MP4_H264_AAC, { 'content-type': 'video/mp4', 'content-length': String(MP4_H264_AAC.length) });
    seen = null;
    const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
    assert.equal(seen, MP4_H264_AAC.length);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), MP4_H264_AAC);
  } finally {
    delete globalThis.FixedLengthStream;
  }
});

// ---- 第三轮复核 ----
// 自定 stsd：rawEntries 原样拼接，count 可与实际条目数不同；large=true 时用 64 位 largesize 头。
function stsdRaw(count, rawEntries, large = false) {
  const payload = Buffer.concat([Buffer.alloc(4), u32be(count), ...rawEntries]);
  if (!large) return box('stsd', payload);
  return Buffer.concat([u32be(1), Buffer.from('stsd', 'latin1'), u32be(0), u32be(16 + payload.length), payload]);
}
const trakWith = (stsdBox) => box('trak', box('mdia', box('minf', box('stbl', stsdBox))));
const mp4With = (...traks) => Buffer.concat([ftyp('isomiso2mp41'), box('moov', box('mvhd', Buffer.alloc(100)), ...traks), mdat]);

test('sniffMergedHead: broken ftyp (size < 8, bad largesize) → unknown, no TypeError', () => {
  const tiny = new Uint8Array([0, 0, 0, 4, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffMergedHead(tiny), { kind: 'unknown' });
  const badLarge = Buffer.concat([u32be(1), Buffer.from('ftyp'), u32be(0), u32be(8), Buffer.alloc(16)]);
  assert.deepEqual(sniffMergedHead(badLarge), { kind: 'unknown' });
  const shortLarge = Buffer.concat([u32be(1), Buffer.from('ftypisom')]); // largesize 字段都不全
  assert.deepEqual(sniffMergedHead(shortLarge), { kind: 'unknown' });
});

test('yt1080-file: 20-byte upstream starting 00000004 ftyp passes through (not 502)', async () => {
  const b = new Uint8Array([0, 0, 0, 4, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 0, 0, 0, 0]);
  const { f } = mergeEnvFetch(b, { 'content-type': 'video/mp4', 'content-length': '20' });
  const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), b);
});

test('sniffMergedHead: entry size < 8 or > 16 entries → not judged ok (but real bad formats still block)', () => {
  const ok = mp4With(trakWith(stsdRaw(1, [box('avc1', Buffer.alloc(70))])), trakWith(stsdRaw(1, [box('mp4a', Buffer.alloc(20))])));
  assert.deepEqual(sniffMergedHead(ok), { kind: 'mp4', ok: true });
  // 第一个条目 size=4，第二个条目（Opus）读不到 → 不能说兼容
  const tinyEntry = Buffer.concat([u32be(4), Buffer.from('avc1'), box('Opus', Buffer.alloc(20))]);
  assert.deepEqual(sniffMergedHead(mp4With(trakWith(stsdRaw(2, [tinyEntry])), trakWith(stsdRaw(1, [box('mp4a', Buffer.alloc(20))])))), { kind: 'mp4' });
  const many = Array.from({ length: 17 }, () => box('avc1', Buffer.alloc(8)));
  assert.deepEqual(sniffMergedHead(mp4With(trakWith(stsdRaw(17, many)))), { kind: 'mp4' });
  const manyBad = [...Array.from({ length: 15 }, () => box('avc1', Buffer.alloc(8))), box('vp09', Buffer.alloc(8)), box('avc1', Buffer.alloc(8))];
  assert.deepEqual(sniffMergedHead(mp4With(trakWith(stsdRaw(17, manyBad)))), { kind: 'mp4', ok: false, fmt: 'VP9 MP4' });
});

test('sniffMergedHead: stsd with 64-bit largesize header is read at body+8', () => {
  assert.deepEqual(sniffMergedHead(mp4With(trakWith(stsdRaw(1, [box('Opus', Buffer.alloc(20))], true)))), { kind: 'mp4', ok: false, fmt: 'Opus MP4' });
  assert.deepEqual(sniffMergedHead(mp4With(trakWith(stsdRaw(1, [box('avc1', Buffer.alloc(70))], true)), trakWith(stsdRaw(1, [box('mp4a', Buffer.alloc(20))], true)))), { kind: 'mp4', ok: true });
});

test('sniffMergedHead: hvc1 is compatible, hev1 stays undecided', () => {
  assert.deepEqual(sniffMergedHead(Buffer.concat([ftyp('isomiso2mp41'), moov('hvc1', 'mp4a'), mdat])), { kind: 'mp4', ok: true });
  assert.deepEqual(sniffMergedHead(Buffer.concat([ftyp('isomiso2mp41'), moov('hev1', 'mp4a'), mdat])), { kind: 'mp4' });
});

test('withKnownLength skips FixedLengthStream when upstream has Content-Encoding', async () => {
  const mk = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  let seen = null;
  globalThis.FixedLengthStream = class extends TransformStream { constructor(n) { super(); seen = n; } };
  try {
    const s0 = mk();
    assert.equal(withKnownLength(s0, '3', 'gzip'), s0);
    assert.equal(withKnownLength(s0, '3', 'br'), s0);
    assert.equal(seen, null);
    withKnownLength(mk(), '3', 'identity');
    assert.equal(seen, 3);
    seen = null;
    const { f } = mergeEnvFetch(MP4_H264_AAC, { 'content-type': 'video/mp4', 'content-length': '99', 'content-encoding': 'gzip' });
    const r = await withFetch(f, () => worker.fetch(new Request('https://example.com/api/yt1080-file?id=j1'), ENV));
    assert.equal(r.status, 200);
    assert.equal(seen, null);
  } finally {
    delete globalThis.FixedLengthStream;
  }
});
