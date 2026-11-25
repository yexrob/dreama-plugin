# 哔哩哔哩

完整说明见 [`docs/plugins/bilibili.md`](../../docs/plugins/bilibili.md)。

- id：`dev.depth3d.bilibili`
- 能力：`search` `progress` `favorites` `subtitles` `categories`
- 登录：`auth: "qr"`（手机客户端扫码，可选）
- 权限：`api.bilibili.com`、`passport.bilibili.com`、`s.search.bilibili.com`；不使用局域网

```bash
npm test
npm run check -- bilibili
npm run build
```

`fixtures/recorded-responses.json` 是脱敏录制数据，供离线回归使用；打包时不会进入 `.d3plugin`（只打包 `manifest.json`、`main.js`、`icon.png`、`locales/*.json`）。
