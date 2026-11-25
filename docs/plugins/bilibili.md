# 哔哩哔哩 `dev.depth3d.bilibili`

浏览与播放哔哩哔哩的视频、番剧和影视。匿名可用；扫码登录后解锁观看历史、收藏、进度同步、登录后才能看的清晰度和外挂字幕。

参考实现：[`SocialSisterYi/bilibili-API-collect`](https://github.com/SocialSisterYi/bilibili-API-collect)（WBI 签名算法）、[`nilaoda/BBDown`](https://github.com/nilaoda/BBDown)（playurl 端点与参数）。

## 能力

| 能力 | 状态 |
|---|---|
| `home` | 推荐、热门、排行榜、番剧；登录后多一行「继续观看」 |
| `browse` | 推荐 / 热门 / 排行榜 / 番剧 / 影视 / 观看历史 / 收藏夹 / 14 个分区，均无限滚动 |
| `detail` | 视频详情（多分P 与 UGC 合集展开为 `episodes`）、番剧系列 → 季 → 分集、相关推荐 |
| `playback` | 音画分离 DASH（含 `initRange` / `indexRange` / `backupUrls`），按设备 codec 过滤 AVC/HEVC/AV1，清晰度列表带会员锁定原因 |
| `search` | 视频与番剧，最多 50 页 |
| `suggest` | 搜索联想 |
| `progress` | 上报观看进度（`x/v2/history/report`），需登录 |
| `favorites` | 收藏普通视频到默认收藏夹，需登录 |
| `subtitles` | 登录后取官方外挂字幕（JSON 格式） |
| `categories` | 4 个公共分类 + 14 个分区；登录后加历史与收藏 |
| `danmaku` | ❌ 未实现：弹幕接口固定返回 deflate 压缩 XML，沙箱没有解压能力 |
| `live` | ❌ 未实现 |
| `played` | ❌ 未实现：B 站没有可靠的“标记已看”接口，只能上报历史进度 |

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `quality` | select | 默认清晰度，`auto`（账号可用的最高画质）/ 1080 / 720 / 480 / 360 |

登录：设置页点登录，用哔哩哔哩手机客户端扫描头显里的二维码（180 秒内有效）。

## 权限

- `api.bilibili.com` — 视频、番剧、历史、收藏、字幕
- `passport.bilibili.com` — 扫码登录
- `s.search.bilibili.com` — 搜索联想
- `lan: false`、`userHosts: false`

流与图片走 CDN（`*.bilivideo.com`、`*.hdslb.com`），这类地址由播放器按协议 §11.3 直接拉取，不需要写进 `hosts`；图片请求带 `Referer: https://www.bilibili.com/`，否则 403。

## 隐私

- `SESSDATA` / `bili_jct` 只存在宿主的加密存储（`ctx.storage.session`）与实例 Cookie 罐里。
- 日志只记请求路径，不记查询串。
- `PlaybackInfo.headers` 只带 `Referer` 与 `User-Agent`，**不带登录 Cookie**，避免把账号凭据发给 CDN。

## 已知限制

- **大会员 / 付费内容**：`is_preview=1`（试看）映射为 `Forbidden`，`is_drm=1` 映射为 `Unsupported`。
- **清晰度回落**：匿名请求 1080P 时服务端可能在 `quality` 里回一个拿不到的清晰度，插件以实际返回的 DASH 轨道为准，并把拿不到的标成 locked。
- **收藏**：只支持普通视频（`type=2`）收藏到第一个收藏夹；番剧/影视的收藏抛 `Unsupported`。
- **进度**：番剧用 `epid` + `sid`，普通视频用 `aid` + `cid`；未用真实大会员账号验证过高码率与番剧进度。
- **登录成功路径**：真实扫码登录、历史、收藏、进度只在录制回归里验证过（`test/bilibili.test.mjs`），线上只验证了二维码生成与轮询的 `pending`。
- **超长季**：像 1281 集的番剧，`detail` 会一次返回全部集数，头显列表可能较慢。
- **WBI**：签名带客户端时间戳，系统时钟严重偏移时请求会失败。

## 测试

```bash
npm test                      # 使用 fixtures/recorded-responses.json，离线
npm run check -- bilibili     # 打真实接口
```

fixtures 里的 id、标题、WBI 密钥、Cookie 全部是合成的假值（`BV1d3…` 系列），没有任何真实令牌或个人信息。
