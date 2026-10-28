# YouTube 解析（Cloudflare Pages + Worker）

根目录 `_worker.js` 处理 `/api/*`，`index.html` 是页面。不要把 Cookie、PO Token、合并口令写进仓库，只放在 Cloudflare Pages 的环境变量里（Settings → Environment variables，选加密）。改完变量后需要重新部署才会生效。

## 年龄限制 / 登录墙（`/api/yt-hd`）

YouTube 的 `playabilityStatus.status` 经常是 `LOGIN_REQUIRED`，但含义要看 `reason`：

- `Sign in to confirm you're not a bot`：机器人校验。接口仍返回原来的中文提示，并带 `code: "BOT_CHECK"`。
- `Sign in to confirm your age`、`This video may be inappropriate for some users`，或带 `desktopLegacyAgeGateReason`：需要已登录且过了年龄验证的会话。接口返回 `code: "LOGIN_REQUIRED"` 和单独的中文说明。

公开视频仍先走原来的匿名客户端（ANDROID_VR → IOS → ANDROID，带一次 visitorData 重试）。拿到 1080P 的 avc1 + 音频就立刻返回。如果只有 720P（或更低的渐进式 MP4），会把这个结果留下来，继续找更高的；后面的客户端如果撞上机器人墙，也不会把已经拿到的 720P 丢掉。

匿名客户端整轮都是机器人墙、而且一个直链都没有时，会按大约 0.4s、1s 的间隔再试两轮（IOS → ANDROID → ANDROID_VR，每次换一个 visitor）。这是为了应付数据中心 IP 上间歇性的 bot wall。年龄墙不会走这几次重试。

只有匿名结果还不到 1080P、并且配置了 Cookie 时，才带登录态再试，而且只请求会吃网页 Cookie 的客户端：MWEB、TVHTML5、WEB。Cookie 不会再发给 IOS / ANDROID / ANDROID_VR（那些客户端会返回没有 `playabilityStatus` 的空响应）。登录态请求会尽量沿用 Cookie 里 `PREF` 的 `hl` / `gl`。

### 只有 720P，或一直 BOT_CHECK

有些视频在 Cloudflare 出口上时好时坏：同一次解析里 IOS 可能给出 720P 自适应流，下一次所有匿名客户端都是 `Sign in to confirm you're not a bot`。接口在拿得到流时返回 `ok: true` 和真实的 `video.height`（例如 720），`capped: true` 表示没到 1080。页面按钮写的是这个高度，不再把所有失败都说成「没拿到 1080P」。

失败时看 `code`：

- `BOT_CHECK`：匿名客户端被当成机器人，720P 和 1080P 都没拿到。过一会再试。
- `LOGIN_REQUIRED`：年龄限制或登录墙。需要有效的 `YT_COOKIES`。
- `UNAVAILABLE`：别的不可播原因，`error` 里会带上 YouTube 的简短说明。

稳定拿到这类视频的 1080P，通常还要 player PO Token（不是媒体 URL 上的 `pot`）：

1. 用已登录浏览器，按 [yt-dlp PO Token 指南](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) 生成 **player** token，对应请求体里的 `serviceIntegrityDimensions.poToken`。
2. 在 Cloudflare Pages → Settings → Environment variables 添加加密变量 `YT_PO_TOKEN`（别名 `YT_POT`）。不要把 token 写进仓库，也不要填占位符。
3. 重新部署。`GET /api/diag` 的 `hasYtPoToken` 只有在变量去空白后非空时才是 `true`，响应里不会出现 token 本身。

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `YT_COOKIES` | 否 | 已登录 `youtube.com` 的 Cookie。别名 `YT_COOKIE`。 |
| `YT_PO_TOKEN` | 否 | InnerTube player 请求体里的 `serviceIntegrityDimensions.poToken`。别名 `YT_POT`。这是 player PO Token，不会自动加到 googlevideo 的 `pot` 参数上。 |

`YT_COOKIES` 接受三种写法：

1. 请求头：`VISITOR_INFO1_LIVE=...; LOGIN_INFO=...; SAPISID=...; __Secure-3PAPISID=...`
2. Netscape `cookies.txt`（含 `#HttpOnly_` 行）
3. `[{"name":"SAPISID","value":"..."}]`

浏览器登录一个已经通过年龄验证的 YouTube 账号，从任意 `youtube.com` 请求复制 Cookie。年龄墙至少要有 `LOGIN_INFO`，以及 `SAPISID` 或 `__Secure-3PAPISID`（Worker 会据此生成 `Authorization: SAPISIDHASH ...`）。`/api/diag` 只返回 `hasYtCookies` / `hasYtPoToken` 布尔值，不回传内容。

## 服务器合并（`/api/yt1080-start`）

页面上的清晰度下拉和「服务器合并」会把任务交给 EC2（yt-dlp + ffmpeg）。本仓库没有合并服务本身；EC2 不在线时无法在这里假装有一个。

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `YT_MERGE_TOKEN` | 使用服务器合并时必填 | 与 EC2 `~/yt-merge/token.txt` 一致。只放在 Worker，不下发到浏览器。 |
| `YT_MERGE_BASE` | 否 | EC2 根地址，不要末尾斜杠。默认 `http://3-129-45-49.sslip.io:30002`。 |

源站 DNS 失败时，Cloudflare 会返回 HTTP 530 / error code 1016。Worker 改成中文 JSON（`code: "MERGE_ORIGIN_DOWN"`），说明去检查 `YT_MERGE_BASE`、`YT_MERGE_TOKEN` 和 EC2 进程。Worker 不能直接请求裸 IP（会被 Cloudflare 1003 拦截），地址要用主机名。

手机里的本地合并（解析结果上的「一键下载」，`YTMerge` + `/api/yt-hd` + `/api/ytdl`）不依赖 EC2。

本地检查：

```bash
node --experimental-default-type=module --test test/yt-hd.test.mjs
```
