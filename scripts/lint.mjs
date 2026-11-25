#!/usr/bin/env node
// Kit-free structural checks that can run anywhere (including CI without the
// depth3d checkout): manifest shape, i18n key coverage, and consistency between
// plugins/, dist/ and index.json.
//
// This is deliberately not a replacement for `npm run check` (which runs the
// real QuickJS runtime and the shared JSON Schemas) — it catches the mistakes
// that are visible from the repository alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(repoRoot, 'plugins');
const DIST_DIR = path.join(repoRoot, 'dist');
const INDEX_PATH = path.join(repoRoot, 'index.json');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const KIND_FUNCS = {
  search: ['search'],
  suggest: ['suggest'],
  progress: ['reportProgress'],
  favorites: ['setFavorite'],
  played: ['setPlayed'],
  filters: ['filters'],
  danmaku: ['danmaku'],
  live: [],
  subtitles: [],
  categories: ['categories'],
};

const errors = [];
const fail = (msg) => errors.push(msg);

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${label}: 不是合法 JSON（${err.message}）`);
    return null;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function tKeys(text) {
  const keys = new Set();
  for (const m of String(text).matchAll(/ctx\.t\(\s*'([^']+)'/g)) keys.add(m[1]);
  return keys;
}

function manifestKeys(value, out = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('$t:')) out.add(value.slice(3));
  } else if (Array.isArray(value)) {
    for (const item of value) manifestKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) manifestKeys(item, out);
  }
  return out;
}

function lintPlugin(dir) {
  const name = path.basename(dir);
  const manifestFile = path.join(dir, 'manifest.json');
  const mainFile = path.join(dir, 'main.js');
  const manifest = readJson(manifestFile, `${name}/manifest.json`);
  if (!manifest) return null;

  if (manifest.api !== 1) fail(`${name}: manifest.api 必须是 1`);
  if (!PLUGIN_ID.test(String(manifest.id || ''))) fail(`${name}: manifest.id 不是反向域名（${manifest.id}）`);
  if (name !== String(manifest.id || '').split('.').pop()) {
    fail(`${name}: 目录名必须等于 manifest.id 的最后一段（${manifest.id}）`);
  }
  if (!SEMVER.test(String(manifest.version || ''))) fail(`${name}: manifest.version 不是 semver（${manifest.version}）`);
  if (!manifest.name) fail(`${name}: 缺少 name`);
  if (!manifest.permissions || !Array.isArray(manifest.permissions.hosts)) {
    fail(`${name}: 缺少 permissions.hosts 数组`);
  } else {
    for (const host of manifest.permissions.hosts) {
      if (typeof host !== 'string' || !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
        fail(`${name}: permissions.hosts 里的主机格式可疑（${host}）`);
      }
      if (/^(localhost|127\.|\[?::1\]?$)/.test(host)) fail(`${name}: 不允许申请回环地址（${host}）`);
    }
  }
  if (!Array.isArray(manifest.config || [])) fail(`${name}: config 必须是数组`);
  if (!['none', 'form', 'qr', 'device'].includes(manifest.auth || 'none')) {
    fail(`${name}: auth 必须是 none/form/qr/device（${manifest.auth}）`);
  }
  if (!fs.existsSync(mainFile)) {
    fail(`${name}: 缺少 main.js`);
    return null;
  }
  const main = fs.readFileSync(mainFile, 'utf8');
  if (!/export\s+default\s*\{/.test(main)) fail(`${name}: main.js 必须 export default { ... }`);

  for (const fn of ['home', 'browse', 'detail', 'playback']) {
    if (!new RegExp(`(^|\\s)async\\s+${fn}\\s*\\(|(^|\\s)${fn}\\s*\\(`, 'm').test(main)) {
      fail(`${name}: main.js 未实现必需函数 ${fn}()`);
    }
  }
  for (const cap of manifest.capabilities || []) {
    const fns = KIND_FUNCS[cap];
    if (fns === undefined) fail(`${name}: 未知能力 ${cap}`);
    else for (const fn of fns) if (!main.includes(`${fn}(`)) fail(`${name}: 声明了 ${cap} 但没有 ${fn}()`);
  }
  if (manifest.auth === 'form' && !main.includes('login(')) fail(`${name}: auth=form 需要 login()`);
  if (['qr', 'device'].includes(manifest.auth)) {
    if (!main.includes('loginStart(')) fail(`${name}: auth=${manifest.auth} 需要 loginStart()`);
    if (!main.includes('loginPoll(')) fail(`${name}: auth=${manifest.auth} 需要 loginPoll()`);
  }
  if (/ctx\.log\.(info|warn|error|debug)/.test(main) === false) {
    // not an error, just a hint that logging exists; no-op
  }
  const suspicious = /(?:SESSDATA|sessdata|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/;
  if (suspicious.test(main)) fail(`${name}: main.js 里疑似硬编码了凭据`);

  const localeFile = path.join(dir, 'locales', 'zh-CN.json');
  if (!fs.existsSync(localeFile)) {
    fail(`${name}: 缺少 locales/zh-CN.json`);
  } else {
    const locale = readJson(localeFile, `${name}/locales/zh-CN.json`);
    if (locale) {
      const needed = new Set([...manifestKeys(manifest), ...tKeys(main)]);
      for (const key of needed) if (!(key in locale)) fail(`${name}: 缺少文案 ${key}`);
      for (const key of Object.keys(locale)) if (!needed.has(key)) console.log(`  hint ${name}: 文案 ${key} 未被使用`);
    }
  }

  if (!fs.existsSync(path.join(dir, 'fixtures', 'recorded-responses.json'))) {
    console.log(`  hint ${name}: 没有 fixtures/recorded-responses.json（离线回归需要它）`);
  }
  const testFile = path.join(repoRoot, 'test', `${name}.test.mjs`);
  if (!fs.existsSync(testFile)) console.log(`  hint ${name}: 没有 test/${name}.test.mjs`);
  return manifest;
}

function lintArtifacts(manifests) {
  const index = fs.existsSync(INDEX_PATH) ? readJson(INDEX_PATH, 'index.json') : null;
  if (!index) {
    fail('缺少 index.json（运行 npm run build）');
    return;
  }
  if (!Array.isArray(index.plugins)) {
    fail('index.json: plugins 必须是数组');
    return;
  }
  const byId = new Map(manifests.filter(Boolean).map((m) => [m.id, m]));
  const seen = new Set();

  for (const entry of index.plugins) {
    const manifest = byId.get(entry.id);
    if (!manifest) {
      fail(`index.json 里的 ${entry.id} 在 plugins/ 下没有源码`);
      continue;
    }
    seen.add(entry.id);
    if (entry.version !== manifest.version) {
      fail(`index.json 的 ${entry.id} 版本是 ${entry.version}，manifest 是 ${manifest.version}`);
    }
    if (!/^https:\/\//.test(String(entry.url || ''))) fail(`index.json 的 ${entry.id} url 必须是 https`);
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 || ''))) fail(`index.json 的 ${entry.id} sha256 非法`);
    const distFile = path.join(DIST_DIR, `${entry.id}-${entry.version}.d3plugin`);
    if (!fs.existsSync(distFile)) {
      fail(`缺少产物 dist/${path.basename(distFile)}（运行 npm run build）`);
      continue;
    }
    const actual = sha256(distFile);
    if (actual !== entry.sha256) fail(`dist/${path.basename(distFile)} 的 sha256 与 index.json 不一致`);
    if (!String(entry.url).endsWith(path.basename(distFile))) {
      fail(`index.json 的 ${entry.id} url 与产物文件名不匹配`);
    }
  }

  for (const manifest of byId.values()) {
    if (!seen.has(manifest.id)) fail(`plugins/${manifest.id.split('.').pop()} 没有写进 index.json（运行 npm run build）`);
  }
  if (fs.existsSync(DIST_DIR)) {
    for (const file of fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.d3plugin'))) {
      if (!index.plugins.some((p) => file === `${p.id}-${p.version}.d3plugin`)) {
        fail(`dist/${file} 没有对应的 index.json 条目`);
      }
    }
  }
}

const dirs = fs
  .readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(PLUGINS_DIR, e.name));
const manifests = dirs.map(lintPlugin).filter(Boolean);
lintArtifacts(manifests);

if (errors.length > 0) {
  for (const err of errors) console.error(`✗ ${err}`);
  console.error(`\n${errors.length} 个问题`);
  process.exit(1);
}
console.log(`✓ ${manifests.length} 个插件结构正常，index.json 与 dist/ 一致`);
