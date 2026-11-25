// Resolves the depth3d plugin-kit (`tools/plugin-kit` in the depth3d repo).
//
// The kit is the authoritative implementation of the v1 plugin protocol: the
// same QuickJS runtime, network policy, schemas and packer the headset uses.
// It is not published to npm, so this repo looks for a checkout next to itself.
//
// Resolution order:
//   1. $DREAMA_KIT (or $DEPTH3D_KIT)     (absolute path, used by CI)
//   2. ../dreama/tools/plugin-kit        (recommended local layout)
//   3. ../depth3d-bilibili/tools/plugin-kit (this repo's dev worktree)
//   4. ./node_modules/@depth3d/plugin-kit  (npm-link / file: install)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  process.env.DREAMA_KIT,
  process.env.DEPTH3D_KIT,
  path.resolve(repoRoot, '../dreama/tools/plugin-kit'),
  path.resolve(repoRoot, '../depth3d/tools/plugin-kit'),
  path.resolve(repoRoot, '../depth3d-bilibili/tools/plugin-kit'),
  path.resolve(repoRoot, 'node_modules/@depth3d/plugin-kit'),
].filter(Boolean);

export function resolveKitDir() {
  for (const dir of CANDIDATES) {
    if (fs.existsSync(path.join(dir, 'src/check.js')) && fs.existsSync(path.join(dir, 'src/pack.js'))) {
      return dir;
    }
  }
  throw new Error(
    [
      '找不到 depth3d 的 plugin-kit。',
      '请把 Dreama 仓库与本仓库放在同一目录（../dreama），或用环境变量指定：',
      '  DEPTH3D_KIT=/path/to/dreama/tools/plugin-kit npm test',
      '已尝试：',
      ...CANDIDATES.map((dir) => `  - ${dir}`),
    ].join('\n'),
  );
}

export const kitDir = resolveKitDir();

const load = (rel) => import(pathToFileURL(path.join(kitDir, rel)).href);

const check = await load('src/check.js');
const schema = await load('src/schema.js');
const runtime = await load('src/runtime.js');
const storage = await load('src/storage.js');
const pack = await load('src/pack.js');

export const { checkPlugin, loadPluginSource } = check;
export const { validateManifest, validateProtocolType, validateRepository } = schema;
export const { PluginCallError, QuickJsPluginHost } = runtime;
export const { PluginStorage } = storage;
export const { packPluginToFile, packPluginToBuffer, sha256Hex, inspectArchiveBuffer } = pack;
