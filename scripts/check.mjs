#!/usr/bin/env node
// Runs the kit's full `d3plugin check` against every plugin in this repo:
// manifest schema, QuickJS load, sandbox/network probes, and live
// home -> browse -> detail -> playback + capability calls.
//
//   node scripts/check.mjs                      all plugins, default config
//   node scripts/check.mjs bilibili             one plugin (dir name or id)
//   node scripts/check.mjs bilibili --config '{"quality":"auto"}'
//
// This talks to the real services, so it needs network access. The offline
// regression tests (npm test) are the ones CI runs on every push.
import fs from 'node:fs';
import path from 'node:path';

import { checkPlugin, repoRoot } from '../lib/kit.mjs';

const PLUGINS_DIR = path.join(repoRoot, 'plugins');

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
const config = configIndex >= 0 ? JSON.parse(args[configIndex + 1] || '{}') : {};
const wanted = args.filter((arg, i) => !arg.startsWith('--') && i !== configIndex + 1);

const dirs = fs
  .readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(PLUGINS_DIR, entry.name))
  .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
  .filter((dir) => {
    if (wanted.length === 0) return true;
    const id = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id;
    const name = path.basename(dir);
    return wanted.includes(name) || wanted.includes(id);
  })
  .sort();

if (dirs.length === 0) {
  console.error('没有匹配的插件。');
  process.exit(1);
}

let failed = 0;
for (const dir of dirs) {
  const name = path.basename(dir);
  let result;
  try {
    result = await checkPlugin(dir, { config });
  } catch (err) {
    console.log(`\n✗ ${name}: ${err.message}`);
    failed++;
    continue;
  }
  console.log(`\n${result.ok ? 'PASS' : 'FAIL'}  ${name}  (${result.pluginId}@${result.version})`);
  for (const line of result.checks) console.log(`  [ok]   ${line}`);
  for (const line of result.errors) console.log(`  [err]  ${line}`);
  for (const line of result.warnings) console.log(`  [warn] ${line}`);
  if (!result.ok) failed++;
}

console.log(`\n${dirs.length - failed}/${dirs.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
