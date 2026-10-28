import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, {
  classifyPlayability,
  normalizeCookieHeader,
  ytSapiSidAuthorization,
  mergeOriginDown,
  mergeOriginDownMessage,
  ytHdFailureBody,
  loginRequiredMessage,
} from '../_worker.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const BOT = 'YouTube 暂时把服务器当成了机器人，没拿到高清流，过一会再试';

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
