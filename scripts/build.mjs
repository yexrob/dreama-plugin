#!/usr/bin/env node
// Packs every plugin under plugins/ and (re)writes the repository index.
//
//   node scripts/build.mjs            build dist/*.d3plugin and index.json
//   node scripts/build.mjs --check    verify committed artifacts are up to date
//
// Requires the depth3d plugin-kit (see lib/kit.mjs) so packages are byte-for-byte
// identical to `d3plugin pack` and validated against the shared manifest schema.
import fs from 'node:fs';
import path from 'node:path';

import {
  inspectArchiveBuffer,
  packPluginToBuffer,
  repoRoot,
  sha256Hex,
  validateManifest,
  validateRepository,
} from '../lib/kit.mjs';
import { normalizeZipTimestamps } from '../lib/zip-normalize.mjs';

const PLUGINS_DIR = path.join(repoRoot, 'plugins');
const DIST_DIR = path.join(repoRoot, 'dist');
const INDEX_PATH = path.join(repoRoot, 'index.json');

// jsDelivr serves raw repo files over HTTPS with a real content type and no
// rate limits, which is what the headset needs. Override with PUBLIC_BASE_URL
// when hosting dist/ somewhere else (e.g. GitHub Pages).
const DEFAULT_BASE_URL = 'https://cdn.jsdelivr.net/gh/yexrob/dreama-plugin@main/dist';
const BASE_URL = (process.env.PUBLIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const REPO_NAME = process.env.REPO_NAME || 'Dreama 插件仓库';

const checkMode = process.argv.includes('--check');

function readLocale(pluginDir) {
  const file = path.join(pluginDir, 'locales', 'zh-CN.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Manifest strings may be i18n keys (`$t:plugin_name`); the index has to carry
// the localized text the user will see in the install sheet.
function localize(value, locale) {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('$t:')) return value;
  const key = value.slice(3);
  return locale[key] || key;
}

function pluginDirs() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PLUGINS_DIR, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
    .sort();
}

async function build() {
  const built = [];
  const problems = [];

  for (const pluginDir of pluginDirs()) {
    const dirName = path.basename(pluginDir);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
    } catch (err) {
      problems.push(`${dirName}: manifest.json 不是合法 JSON（${err.message}）`);
      continue;
    }
    if (dirName !== manifest.id.split('.').pop()) {
      problems.push(`${dirName}: 目录名与插件 id 的最后一段不一致（${manifest.id}）`);
    }
    const check = validateManifest(manifest);
    if (!check.valid) {
      problems.push(`${dirName}: manifest 校验失败\n  - ${check.errors.join('\n  - ')}`);
      continue;
    }

    // The kit's packer is not byte-reproducible (JSZip stamps the auto-created
    // `locales/` directory entry with the build time), so timestamps are
    // normalized before hashing: same sources -> same sha256 -> stable index.
    const packed = await packPluginToBuffer(pluginDir);
    const buffer = normalizeZipTimestamps(packed.buffer);
    await inspectArchiveBuffer(buffer);
    const sha256 = sha256Hex(buffer);
    const fileName = `${manifest.id}-${manifest.version}.d3plugin`;
    built.push({
      dirName,
      fileName,
      buffer,
      sha256,
      manifest,
      locale: readLocale(pluginDir),
    });
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exitCode = 1;
    return;
  }

  const wanted = new Map(built.map((entry) => [entry.fileName, entry]));
  const index = {
    name: REPO_NAME,
    plugins: built.map((entry) => ({
      id: entry.manifest.id,
      name: localize(entry.manifest.name, entry.locale),
      version: entry.manifest.version,
      description: localize(entry.manifest.description, entry.locale),
      url: `${BASE_URL}/${entry.fileName}`,
      sha256: entry.sha256,
      ...(entry.manifest.minApp ? { minApp: entry.manifest.minApp } : {}),
    })),
  };

  const indexCheck = validateRepository(index);
  if (!indexCheck.valid) {
    console.error(`✗ 生成的 index.json 不符合 repository.schema.json：\n  - ${indexCheck.errors.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }

  if (checkMode) {
    let stale = false;
    const committedIndex = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, 'utf8') : null;
    if (committedIndex !== `${JSON.stringify(index, null, 2)}\n`) {
      console.error('✗ index.json 与源码不一致，请运行 npm run build');
      stale = true;
    }
    const existing = fs.existsSync(DIST_DIR)
      ? fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.d3plugin'))
      : [];
    for (const [fileName, entry] of wanted) {
      const target = path.join(DIST_DIR, fileName);
      const actual = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (!actual || !actual.equals(entry.buffer)) {
        console.error(`✗ dist/${fileName} 与源码不一致，请运行 npm run build`);
        stale = true;
      }
    }
    for (const extra of existing) {
      if (!wanted.has(extra)) {
        console.error(`✗ dist/${extra} 没有对应的插件源码，请运行 npm run build`);
        stale = true;
      }
    }
    if (stale) process.exitCode = 1;
    else console.log(`✓ 产物已是最新（${built.length} 个插件，base ${BASE_URL}）`);
    return;
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  for (const extra of fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.d3plugin'))) {
    if (!wanted.has(extra)) fs.rmSync(path.join(DIST_DIR, extra));
  }
  for (const [fileName, entry] of wanted) {
    fs.writeFileSync(path.join(DIST_DIR, fileName), entry.buffer);
  }
  fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);

  console.log(`index.json  name=${REPO_NAME}  plugins=${built.length}  base=${BASE_URL}`);
  for (const entry of built) {
    const { manifest, locale, fileName, sha256, buffer } = entry;
    console.log(
      `  ${manifest.id}@${manifest.version}  ${localize(manifest.name, locale)}  ` +
        `${(buffer.length / 1024).toFixed(1)} KB  sha256=${sha256.slice(0, 12)}…  dist/${fileName}`,
    );
  }
}

await build();
