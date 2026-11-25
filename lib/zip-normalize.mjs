// Makes a packed .d3plugin byte-reproducible.
//
// `packPluginToBuffer` (depth3d plugin-kit) stamps `manifest.json`, `main.js`,
// `icon.png` and `locales/*.json` with a fixed date, but the intermediate
// directory entry JSZip creates for `locales/` keeps the wall-clock time of the
// build. Two builds of identical sources therefore produce different bytes and a
// different sha256, which churns index.json and makes artifact verification
// impossible.
//
// This rewrites every DOS time/date field (local file headers and central
// directory entries) to the same fixed timestamp the kit uses, 2026-01-01
// 00:00 UTC. Only metadata is touched: CRCs cover file data, not headers, and
// entry order/sizes are unchanged, so the archive stays a valid zip and the
// kit's `inspectArchiveBuffer` still accepts it.

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const FIXED_DOS_TIME = 0x0000;
// ((2026 - 1980) << 9) | (1 << 5) | 1  → 2026-01-01
const FIXED_DOS_DATE = 0x5c21;

function findEocd(buf) {
  for (let pos = buf.length - 22; pos >= 0; pos--) {
    if (buf.readUInt32LE(pos) !== SIG_EOCD) continue;
    if (pos + 22 + buf.readUInt16LE(pos + 20) === buf.length) return pos;
  }
  return -1;
}

export function normalizeZipTimestamps(input) {
  const buf = Buffer.from(input);
  if (buf.length < 22) throw new Error('zip too small');

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('zip missing End of Central Directory');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cursor) !== SIG_CDH) {
      throw new Error(`central directory entry ${i} has a bad signature`);
    }
    buf.writeUInt16LE(FIXED_DOS_TIME, cursor + 12);
    buf.writeUInt16LE(FIXED_DOS_DATE, cursor + 14);

    const localOffset = buf.readUInt32LE(cursor + 42);
    if (buf.readUInt32LE(localOffset) !== SIG_LFH) {
      throw new Error(`local header for central entry ${i} has a bad signature`);
    }
    buf.writeUInt16LE(FIXED_DOS_TIME, localOffset + 10);
    buf.writeUInt16LE(FIXED_DOS_DATE, localOffset + 12);

    cursor += 46 + buf.readUInt16LE(cursor + 28) + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
  }

  return buf;
}
