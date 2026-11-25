# 添加一个插件

以现有插件为模板最快：`plugins/bilibili/` 是完整范例（QR 登录、音画分离 DASH、搜索、进度、收藏、外挂字幕），`fixtures/recorded-responses.json` 展示如何录制服务端响应。

## 1. 目录

```
plugins/<name>/
├── manifest.json                 必需
├── main.js                       必需，单文件 ES2020 模块
├── locales/zh-CN.json            必需（本仓库约定：至少简体中文）
├── fixtures/recorded-responses.json   离线测试用，可选但强烈建议
└── README.md                     插件说明：能力、配置、已知限制
```

`<name>` 应与 `manifest.id` 的最后一段一致（`npm run build` 会检查）。

## 2. manifest.json

```json
{
  "api": 1,
  "id": "dev.depth3d.example",
  "name": "$t:plugin_name",
  "version": "1.0.0",
  "author": "you",
  "description": "$t:plugin_desc",
  "license": "GPL-3.0-or-later",
  "minApp": "1.0.0",
  "multiInstance": false,
  "capabilities": ["search", "progress", "favorites", "categories"],
  "permissions": {
    "hosts": ["api.example.com", "*.cdn.example.com"],
    "userHosts": false,
    "lan": false
  },
  "config": [
    { "key": "quality", "type": "select", "label": "$t:cfg_quality",
      "options": [{ "value": "auto", "label": "$t:q_auto" }], "default": "auto" }
  ],
  "auth": "none"
}
```

规则：

- `id` 反向域名、全局唯一、安装后不可变；**本仓库用 `dev.depth3d.<name>` 前缀**，第三方自建仓库请用你自己的域名。
- `permissions.hosts` 只写插件真的会请求的域名；`lan: true` 只在需要访问局域网设备时才加（自建服务器），视频网站的插件必须是 `false`。
- `capabilities` 里写了什么就必须实现对应的函数，`npm run check` 会核对。
- `auth`：`none` / `form`（用 config 里的账号密码，需要 `login`）/ `qr` 或 `device`（需要 `loginStart` + `loginPoll`）。

## 3. main.js

```js
export default {
  async home(ctx) { /* -> Shelf[] */ },
  async browse(ctx, { categoryId = '', cursor = null } = {}) { /* -> { items, next } */ },
  async detail(ctx, { itemId }) { /* -> Item */ },
  async playback(ctx, { itemId, quality = null }) { /* -> PlaybackInfo */ },
};
```

约定：

- **游标翻页，不要自己分页。** App 的库页是无限滚动，只要 `browse` 返回非空 `next`，滚到底就会继续拉下一页；`next: null` 表示到底。整表一次返回的接口（如排行榜）请缓存后按 offset 切片。
- **id 必须唯一。** App 用 item id 当列表 key，同一响应里出现重复 id 会让主线程崩（`IllegalArgumentException: Key ... was already used`）。各列表返回前自己去重；分区的 `more` 也必须互不相同。
- **二维码内容 ≤ 134 字节。** App 的二维码编码器只实现 QR v1–V6（字节模式、ECC L）。超长会直接抛异常并把 App 打崩，插件侧必须先裁剪（参考 `fitQrPayload`）。
- 令牌只写 `ctx.storage`（异步，必须 `await`）；`ctx.log` 里不要打印 token、Cookie、完整 URL 查询串。
- 错误抛 `new ctx.Error(code, '简体中文短句')`：`NeedsAuth` / `AuthFailed` / `NeedsSetup` / `Unavailable` / `NotFound` / `Forbidden` / `RateLimited` / `Unsupported` / `Internal`。不要抛裸字符串，也不要吞错返回空数组。
- 服务端“HTTP 200 + 业务错误码”的错误要显式映射；`Forbidden` 用于会员/地区/试看限制，`Unsupported` 用于 DRM。
- 音画分离的流返回 `dash: { video, audio }` 并**必须**给 `durationMs`；DASH 的 `SegmentBase` 要映射成 `initRange` / `indexRange`，播放器才能字节级拖动。
- 图片/流地址若需要 `Referer` 或 `User-Agent`，用 `Image.headers` 与 `PlaybackInfo.headers` 带上；`PlaybackInfo.headers` 是全局的，别把登录 Cookie 发给 CDN。

## 4. fixtures 与测试

`fixtures/recorded-responses.json` 放**录制并脱敏**的服务端响应：真实字段结构，但 id、标题、令牌、Cookie、WBI 密钥全部替换成假值（本仓库用 `BV1d3…` 系列合成 id）。里面不允许出现真实令牌、密码、个人信息。

`test/<name>.test.mjs` 用 kit 的 `QuickJsPluginHost` + `transportOverride` 把 fixture 喂给插件，覆盖：

- `checkPlugin` 静态检查通过
- `home` / `browse` / `detail` / `playback` 的结构与图片 URL 策略
- 每个 `capabilities` 的主力路径（搜索、登录、进度、收藏）
- 错误映射（未登录、限流、会员、DRM、不存在）
- 分页：满页时给 `next`、最后一页 `next: null`、两页不重叠
- 令牌不外泄：返回 JSON 与日志里搜不到 `SESSDATA` 之类的字符串

参考 `test/bilibili.test.mjs`（约 430 行）。

## 5. 提交前

```bash
npm test              # 离线回归
npm run check         # 打真实服务跑一遍（需要网络与配置）
npm run build         # 生成 dist/ 与 index.json
```

`dist/` 与 `index.json` 要一起提交；CI 的 `npm run verify` 会确认它们和源码一致。

打包用 kit 的 `packPluginToBuffer`，再由 `lib/zip-normalize.mjs` 把所有 zip 时间戳统一成 2026-01-01 00:00，保证同样源码得到同样的 `sha256`。直接用 `d3plugin pack` 打出来的包内容相同，但时间戳不同、哈希也会不同，所以**以 `npm run build` 的产物为准**（CI 只校验这里生成的 `dist/`）。

## 6. 评审关注点

- 是否有任何请求发往 `permissions.hosts` 之外（会被 App 拒绝，但别浪费用户一次点击）
- 是否把错误吞成空列表（用户会以为“这个来源没内容”）
- 是否把令牌写进日志、标题、`overview` 或 URL（播放地址里带 key 是可以的，但不要带账号 Cookie）
- 是否声明了做不到的能力（例如没有解压能力就声明 `danmaku`）
