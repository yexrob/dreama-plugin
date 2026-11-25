# Dreama 插件仓库

[Dreama](https://github.com/yexrob/dreama) 是 PICO 头显上的「2D → 实时 3D 影院」。这个仓库放它的**第三方媒体源插件**：每个插件把某个视频来源（B 站、网盘、自建服务……）变成 App 里的首页分区、分类、详情和播放地址。

插件是单个 `.d3plugin` 包（标准 zip），跑在 App 内置的 QuickJS 沙箱里，只能通过宿主网关访问 `manifest.json` 里声明的域名。协议规范在 Dreama 仓库的 [`docs/specs/plugin-protocol.md`](https://github.com/yexrob/dreama/blob/main/docs/specs/plugin-protocol.md)。

## 安装

在头显里：**播放源 › 插件 › 添加插件仓库**，填入仓库索引地址（手机扫码填写更方便）：

```
https://cdn.jsdelivr.net/gh/yexrob/dreama-plugin@main/index.json
```

索引 `index.json` 列出本仓库全部插件及其 `sha256`，App 下载后会先校验哈希再校验包内 `manifest.json` 的 `id` / `version`。

## 插件列表

| 插件 | id | 版本 | 需要账号 | 说明 |
|---|---|---|---|---|
| 哔哩哔哩 | `dev.depth3d.bilibili` | 1.0.2 | 可选（扫码） | 推荐 / 热门 / 排行榜 / 番剧 / 影视 / 分区 / 搜索；音画分离 DASH、清晰度切换、观看历史、收藏、进度同步、外挂字幕 |

各插件的能力、配置项与已知限制见 [`docs/plugins/`](docs/plugins/)。

## 状态

早期阶段。插件按“能真实跑通”的标准逐个加，接口不完整或服务端不支持的会明确写在插件文档里，而不是假装支持。

## 自己写一个

看 [`docs/adding-a-plugin.md`](docs/adding-a-plugin.md)。要点：

- 目录 `plugins/<名字>/`，含 `manifest.json`、`main.js`、`locales/zh-CN.json`，可选 `fixtures/recorded-responses.json`
- `manifest.id` 用反向域名，`permissions.hosts` 只申请真正需要的域名
- 必须实现 `home` / `browse` / `detail` / `playback`，其余能力在 `capabilities` 里声明
- 错误必须抛协议第 6 节的 `ctx.Error` 类型，不要抛裸字符串、也不要吞掉错误返回空列表
- 令牌只放 `ctx.storage`，不写日志、不出现在标题或描述里
- 文案用简体中文

## 开发

本仓库的测试与打包依赖 Dreama 仓库里的 `tools/plugin-kit`（与头显同语义的 QuickJS 运行时、网络策略、Schema 与打包器）。把两个仓库放在同一目录：

```
Projects/
├── dreama/             # 提供 tools/plugin-kit
└── dreama-plugin/      # 本仓库
```

```bash
cd dreama/tools/plugin-kit && npm ci

cd ../../dreama-plugin
npm run lint                              # 结构检查，不依赖 kit（CI 必跑）
npm test                                  # 离线回归（fixtures 驱动）
npm run check                             # 打真实服务跑 d3plugin check（需要网络）
npm run check -- bilibili                 # 只查一个
npm run build                             # 生成 dist/*.d3plugin 与 index.json
npm run verify                            # 确认 dist/ 与 index.json 和源码一致
```

`DEPTH3D_KIT=/path/to/dreama/tools/plugin-kit` 可以覆盖自动查找。

CI 里 `lint` 作业总是运行；`test` 作业需要 Dreama 仓库可访问（已配置 `DEPTH3D_REPO=yexrob/dreama`）。

单独调试某个插件：

```bash
KIT=../dreama/tools/plugin-kit
node $KIT/bin/d3plugin.js run home plugins/bilibili --config /tmp/cfg.json --storage /tmp/st.json
node $KIT/bin/d3plugin.js run playback plugins/bilibili --item v:BV1xx411c7mD --config /tmp/cfg.json
```

## 目录结构

```
plugins/<name>/     插件源码（manifest.json、main.js、locales/、fixtures/、README.md）
dist/               打包产物 *.d3plugin（提交进仓库，供 CDN 分发）
index.json          仓库索引（由 npm run build 生成，不要手改）
lib/kit.mjs         定位并加载 depth3d plugin-kit
scripts/build.mjs   打包 + 生成索引 + --check 校验一致性
scripts/lint.mjs    不依赖 kit 的结构检查（manifest、文案、index/dist 一致性）
scripts/check.mjs   对所有插件跑 d3plugin check
test/               每个插件一条离线回归（fixtures 驱动）
```

## 免责与许可

- 这些插件是第三方作品，与任何内容平台的官方无关。
- 插件只负责“把某个来源的数据变成 App 能播的地址”，不托管、不分发、不绕过任何付费或版权保护；遇到 DRM、会员试看、地区限制会明确报错。
- 使用时请遵守所在地区法律与平台服务条款，仅限个人合法访问自己有权观看的内容。
- 代码以 [GPL-3.0-or-later](LICENSE) 发布。
