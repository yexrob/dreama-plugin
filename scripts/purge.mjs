#!/usr/bin/env node
// Purges the jsDelivr cache for index.json and every dist/*.d3plugin.
//
// jsDelivr caches `@branch` refs for up to 12 hours, so a release would keep
// serving the previous index (and therefore the previous sha256) long after the
// push. Run this right after `git push`:
//
//   node scripts/purge.mjs
//
// It is best-effort: jsDelivr may still serve a stale edge for a short while,
// and a purge can report `finished` without the edge having flipped yet, so the
// script re-checks index.json and tells you whether the new content is live.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// jsDelivr resets undici connections from some networks (ECONNRESET), so plain
// HTTP goes through curl when available and falls back to fetch otherwise.
function httpGet(url, timeoutSec = 30) {
  try {
    return execFileSync('curl', ['-sS', '-m', String(timeoutSec), '-H', 'Cache-Control: no-cache', url], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.PUBLIC_BASE_URL || 'https://cdn.jsdelivr.net/gh/yexrob/dreama-plugin@main/dist')
  .replace(/\/+$/, '');
// .../gh/<user>/<repo>@<ref>/<dir>  →  .../gh/<user>/<repo>@<ref>
const repoRef = BASE.replace(/\/dist$/, '');

const files = [`${repoRef}/index.json`];
const distDir = path.join(repoRoot, 'dist');
if (fs.existsSync(distDir)) {
  for (const file of fs.readdirSync(distDir).filter((f) => f.endsWith('.d3plugin')).sort()) {
    files.push(`${BASE}/${file}`);
  }
}

const index = JSON.parse(fs.readFileSync(path.join(repoRoot, 'index.json'), 'utf8'));
const expected = JSON.stringify(index.plugins.map((p) => `${p.id}@${p.version}`));

async function purgeOnce(url) {
  const body = httpGet(`https://purge.jsdelivr.net/${url.replace(/^https?:\/\//, '')}`, 45);
  if (body === null) return false;
  try {
    return JSON.parse(body).status === 'finished';
  } catch {
    return false;
  }
}

let ok = true;
for (const url of files) {
  let purged = false;
  for (let attempt = 0; attempt < 6 && !purged; attempt++) {
    purged = await purgeOnce(url).catch(() => false);
    if (!purged) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`${purged ? 'purged' : 'failed'}  ${url}`);
  if (!purged) ok = false;
}

// Verify the index actually reflects the repository now.
let live = null;
for (let attempt = 0; attempt < 6 && !live; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 5000));
  const liveJson = httpGet(`${repoRef}/index.json`);
  let parsed = null;
  try {
    parsed = liveJson ? JSON.parse(liveJson) : null;
  } catch {
    parsed = null;
  }
  const ids = parsed ? JSON.stringify(parsed.plugins.map((p) => `${p.id}@${p.version}`)) : null;
  if (ids === expected) live = parsed;
}

if (!live) {
  const liveJson = httpGet(`${repoRef}/index.json`);
  try { live = liveJson ? JSON.parse(liveJson) : null; } catch { live = null; }
}

if (!live) {
  console.error('\n无法读取 CDN 上的 index.json（网络或缓存问题），稍后用浏览器确认。');
  process.exit(1);
}
const actual = JSON.stringify(live.plugins.map((p) => `${p.id}@${p.version}`));
if (actual === expected) {
  console.log(`\n✓ CDN index.json 已是最新：${expected}`);
} else {
  console.error(`\n✗ CDN 仍是旧内容：\n  期望 ${expected}\n  实际 ${actual}\n  jsDelivr 的 @branch 缓存最长 12 小时；再跑一次本脚本，或临时改用 commit/tag 引用。`);
  process.exit(1);
}
if (!ok) process.exit(1);
