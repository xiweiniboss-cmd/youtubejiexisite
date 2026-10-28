# YouTube 解析（Cloudflare Pages + Worker）

根目录 `_worker.js` 处理 `/api/*`，`index.html` 是页面。不要把 Cookie、PO Token、合并口令写进仓库，只放在 Cloudflare Pages 的环境变量里（Settings → Environment variables，选加密）。改完变量后需要重新部署才会生效。

## 年龄限制 / 登录墙（`/api/yt-hd`）

YouTube 的 `playabilityStatus.status` 经常是 `LOGIN_REQUIRED`，但含义要看 `reason`：

- `Sign in to confirm you're not a bot`：机器人校验。接口仍返回原来的中文提示，并带 `code: "BOT_CHECK"`。
- `Sign in to confirm your age`、`This video may be inappropriate for some users`，或带 `desktopLegacyAgeGateReason`：需要已登录且过了年龄验证的会话。接口返回 `code: "LOGIN_REQUIRED"` 和单独的中文说明。

公开视频仍先走原来的匿名客户端（ANDROID_VR → IOS → ANDROID，带一次 visitorData 重试）。只有匿名没拿到流、并且配置了 Cookie 时，才会带登录态再试，并额外请求 TVHTML5 / MWEB。

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
