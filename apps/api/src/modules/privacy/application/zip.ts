/**
 * Minimal ZIP writer (method 0, stored). Export bundles are JSON and text, so compression is not
 * worth a dependency. No ZIP64: more than 65,535 entries or 4 GiB is refused, never truncated.
 */
export interface ZipEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function buildZip(entries: readonly ZipEntry[], modifiedAtMs: number): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError("too many zip entries");
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(modifiedAtMs);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.path.startsWith("/") || e.path.includes("..") || e.path.includes("\\") || e.path.length === 0) {
      throw new RangeError(`unsafe zip path ${e.path}`);
    }
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, e.data);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + size;
    if (offset > 0xffffffff) throw new RangeError("zip exceeds 4 GiB");
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
