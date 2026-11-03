// 历史解析（index.html 里 JIEXI_HISTORY_CORE 段）：只存 原链接/标题/封面/时间，上限 50，防 XSS，localStorage 不可用不报错
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const KEY = 'jiexi_history_youtube_v1';

function core() {
  const a = HTML.indexOf('/* JIEXI_HISTORY_CORE_BEGIN */');
  const b = HTML.indexOf('/* JIEXI_HISTORY_CORE_END */');
  assert.ok(a > 0 && b > a, '找不到历史核心段');
  const ctx = vm.createContext({});
  vm.runInContext(HTML.slice(a, b) + '\nthis.C = JiexiHistoryCore;', ctx);
  return ctx.C;
}
function memLS(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('history: add 只留白名单字段，去重置顶，上限 50', () => {
  const C = core();
  let list = [];
  list = C.add(list, { url: 'https://youtu.be/aaa', title: 'A', cover: 'https://i.ytimg.com/vi/aaa/hq.jpg',
    videos: ['https://rr1.googlevideo.com/videoplayback?sig=SECRET'], cookie: 'SID=xyz', token: 't' }, 1000);
  assert.deepEqual(plain(list), [{ url: 'https://youtu.be/aaa', title: 'A', cover: 'https://i.ytimg.com/vi/aaa/hq.jpg', time: 1000 }]);
  list = C.add(list, { url: 'https://youtu.be/bbb', title: 'B' }, 2000);
  list = C.add(list, { url: 'https://youtu.be/aaa', title: 'A2' }, 3000);
  assert.deepEqual(plain(list.map((e) => e.url)), ['https://youtu.be/aaa', 'https://youtu.be/bbb']);
  assert.equal(list[0].title, 'A2');
  for (let i = 0; i < 80; i++) list = C.add(list, { url: 'https://youtu.be/v' + i, title: 'T' + i }, 4000 + i);
  assert.equal(list.length, 50);
  assert.equal(C.MAX, 50);
  assert.equal(list[0].url, 'https://youtu.be/v79');
});

test('history: 从分享文案里取第一个 http(s) 链接，拒绝 javascript: / data: 等', () => {
  const C = core();
  assert.equal(C.firstUrl('看看这个 https://youtu.be/abc?si=1 ，超好看！'), 'https://youtu.be/abc?si=1');
  assert.equal(C.firstUrl('【标题】https://www.youtube.com/watch?v=x1。'), 'https://www.youtube.com/watch?v=x1');
  assert.equal(C.firstUrl('javascript:alert(1)'), '');
  assert.equal(C.firstUrl('data:text/html,hi'), '');
  assert.equal(C.firstUrl('没有链接'), '');
  assert.deepEqual(plain(C.add([], { url: 'javascript:alert(1)' }, 1)), []);
  // 文案里夹着 javascript: 也只会取出后面真正的 http(s) 链接
  assert.equal(C.add([], { url: 'javascript:alert(1)//https://x.com/a' }, 1)[0].url, 'https://x.com/a');
  // 封面不是 http(s) 就丢掉
  assert.equal(C.add([], { url: 'https://youtu.be/a', cover: 'javascript:alert(1)' }, 1)[0].cover, '');
});

test('history: 渲染时转义标题 / 链接 / 封面，防 XSS', () => {
  const C = core();
  const list = C.add([], { url: 'https://youtu.be/a?x="><img src=x onerror=alert(1)>', title: '<script>alert(1)</script>"\'&',
    cover: 'https://i.ytimg.com/a.jpg?"onerror="alert(1)' }, Date.now());
  const h = C.renderItems(list, Date.now());
  assert.ok(!h.includes('<script>'), h);
  assert.ok(!/<img src=x/i.test(h), h);
  assert.ok(!h.includes('"onerror="'), h);
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
  assert.match(h, /rel="noopener noreferrer"/);
  assert.match(h, /referrerpolicy="no-referrer"/);
  assert.match(h, /重新解析/);
  assert.match(h, /复制链接/);
  assert.match(h, /删除/);
});

test('history: load/save 容错——坏 JSON、脏数据、localStorage 抛错都不炸', () => {
  const C = core();
  assert.deepEqual(plain(C.load(null, KEY)), []);
  assert.deepEqual(plain(C.load(memLS({ [KEY]: '{bad json' }), KEY)), []);
  assert.deepEqual(plain(C.load(memLS({ [KEY]: '"str"' }), KEY)), []);
  const dirty = [null, 1, { url: 'javascript:1' }, { url: 'https://a.com/1', title: 'x'.repeat(500), extra: 'cookie' },
    { url: 'https://a.com/1', title: 'dup' }];
  const got = C.load(memLS({ [KEY]: JSON.stringify(dirty) }), KEY);
  assert.equal(got.length, 1);
  assert.deepEqual(plain(Object.keys(got[0]).sort()), ['cover', 'time', 'title', 'url']);
  assert.ok(got[0].title.length <= 121);

  const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() {} };
  assert.equal(C.probe(boom), null);
  assert.equal(C.probe(undefined), null);
  assert.deepEqual(plain(C.load(boom, KEY)), []);
  assert.equal(C.save(boom, KEY, [{ url: 'https://a.com' }]), false);
  assert.equal(C.save(null, KEY, []), false);

  const ls = memLS();
  assert.equal(C.probe(ls), ls);
  assert.equal(C.save(ls, KEY, C.add([], { url: 'https://youtu.be/z', title: 'Z' }, 5)), true);
  assert.deepEqual(plain(C.load(ls, KEY)), [{ url: 'https://youtu.be/z', title: 'Z', cover: '', time: 5 }]);
  assert.deepEqual([...ls._m.keys()], [KEY]);
});

test('history: remove / fmtTime', () => {
  const C = core();
  let list = C.add(C.add([], { url: 'https://a.com/1' }, 1), { url: 'https://a.com/2' }, 2);
  list = C.remove(list, 'https://a.com/1');
  assert.deepEqual(plain(list.map((e) => e.url)), ['https://a.com/2']);
  const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
  assert.equal(C.fmtTime(now - 5000, now), '刚刚');
  assert.equal(C.fmtTime(now - 5 * 60000, now), '5 分钟前');
  assert.equal(C.fmtTime(new Date(2026, 10, 3, 8, 5).getTime(), now), '今天 08:05');
  assert.equal(C.fmtTime(new Date(2026, 0, 2, 9, 30).getTime(), now), '01-02 09:30');
  assert.equal(C.fmtTime(new Date(2025, 0, 2, 9, 30).getTime(), now), '2025-01-02 09:30');
});

test('index.html: 历史区块、独立 key、解析成功后才记录（只传原链接/标题/封面）', () => {
  assert.ok(HTML.includes('"key": "' + KEY + '"'), '本站 key 必须是 ' + KEY);
  for (const id of ['jxHist', 'jxhToggle', 'jxhBody', 'jxhList', 'jxhClear']) assert.ok(HTML.includes('id="' + id + '"'), id);
  assert.match(HTML, />清空历史</);
  assert.match(HTML, /🕘 历史解析/);
  // 挂在 parseBtn 成功分支：renderResult(data) 之后，且 data.ok 判定之后
  assert.match(HTML, /if\(!data\.ok\) throw new Error\([^\n]*\);\n\s*renderResult\(data\);\n\s*try \{ if \(window\.JiexiHistory\) window\.JiexiHistory\.add\(\{ url: text, title: data\.title, cover: data\.cover \}\); \} catch\(e\)\{\}\n/);
  assert.equal((HTML.match(/JiexiHistory\.add\(/g) || []).length, 1);
  // 重新解析走原来的按钮（人机验证 / 配额照常生效）
  assert.ok(HTML.includes('"input": "urlInput", "btn": "parseBtn"'));
});

test('history: 原链接 / 封面只认 http(s)——javascript: / data: / vbscript: 等被拒', () => {
  const C = core();
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)',
    'file:///etc/passwd', '//evil.com/x', 'https:/x', ' https://a.com', 'https://a.com/\nx', 'blob:https://a.com/1']) {
    assert.equal(C.isHttp(bad), false, bad);
    // 存储里的记录：链接不合法整条跳过
    assert.equal(C.clean({ url: bad, title: 't', cover: '', time: 1 }, true), null, bad);
    // 封面不合法只丢封面，记录保留
    const e = C.clean({ url: 'https://a.com/v', title: 't', cover: bad, time: 1 }, true);
    assert.equal(e.cover, '', bad);
    assert.equal(C.add([], { url: 'https://a.com/v', cover: bad }, 1)[0].cover, '', bad);
  }
  assert.equal(C.isHttp('https://i.ytimg.com/vi/a/hq.jpg'), true);
  assert.equal(C.isHttp('HTTP://a.com'), true);
  // 新解析写入时链接里没有 http(s) 就不记
  assert.deepEqual(plain(C.add([], { url: 'data:text/html,https' }, 1)), []);
  assert.deepEqual(plain(C.add([], { url: ['https://a.com'] }, 1)), []);
  const h = C.renderItems(C.load(memLS({ [KEY]: JSON.stringify([{ url: 'https://a.com', cover: 'javascript:alert(1)', title: 'x', time: 1 }]) }), KEY), 2);
  assert.ok(!/javascript:/i.test(h), h);
  assert.ok(!h.includes('<img'), h);
});

test('history: 读取时坏记录逐条跳过（字段类型不对），好记录照常保留，不抛错', () => {
  const C = core();
  const good = { url: 'https://youtu.be/ok', title: 'OK', cover: 'https://i.ytimg.com/ok.jpg', time: 123 };
  const rows = [
    good,
    { url: 123, title: 'num url' },
    { url: ['https://youtu.be/arr'], title: 'arr url' },
    { url: { toString: 'https://x' } },
    { url: 'https://youtu.be/t1', title: { a: 1 } },
    { url: 'https://youtu.be/t2', title: ['x'] },
    { url: 'https://youtu.be/t3', title: 5 },
    { url: 'https://youtu.be/c1', cover: 42 },
    { url: 'https://youtu.be/c2', cover: { src: 'https://a' } },
    { url: 'https://youtu.be/tm', time: '2026-11-03' },
    { url: 'https://youtu.be/tm2', time: true },
    ['https://youtu.be/array-record'],
    'https://youtu.be/string-record',
    null, 0, false, true,
    { url: 'https://youtu.be/minimal' },
    { url: 'https://youtu.be/nulls', title: null, cover: null, time: null },
    { url: 'https://youtu.be/ok', title: 'dup' },
  ];
  const got = plain(C.load(memLS({ [KEY]: JSON.stringify(rows) }), KEY));
  assert.deepEqual(got, [
    good,
    { url: 'https://youtu.be/minimal', title: '', cover: '', time: 0 },
    { url: 'https://youtu.be/nulls', title: '', cover: '', time: 0 },
  ]);
  // 各种坏 JSON / 非数组都返回 []
  for (const raw of ['', '{', 'null', 'true', '1', '"x"', '{"length":3,"0":{"url":"https://a.com"}}', '[', 'undefined']) {
    assert.deepEqual(plain(C.load(memLS({ [KEY]: raw }), KEY)), [], raw);
  }
  // getItem 返回非字符串（怪异实现）也不炸
  assert.deepEqual(plain(C.load({ getItem: () => 42 }, KEY)), []);
});

test('history: 标题只以转义文本插入（index.html 渲染路径没有未转义的 title）', () => {
  assert.match(HTML, /'<div class="jxh-title">' \+ esc\(e\.title \|\| '（无标题）'\) \+ '<\/div>'/);
  assert.match(HTML, /'<div class="jxh-url">' \+ esc\(e\.url\) \+ '<\/div>'/);
  assert.match(HTML, /'<img src="' \+ esc\(e\.cover\) \+ '"/);
  assert.match(HTML, /<a href="' \+ esc\(e\.url\) \+ '"/);
  assert.match(HTML, /msg\.textContent = t;/);
});
