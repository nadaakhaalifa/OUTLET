/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1 to 10 (up to 213 bytes).
 * Enough for an otpauth:// URI. Dependency-free so no package install is needed and nothing leaves the browser.
 * Returns a square matrix of dark modules, or null when the text does not fit.
 */

const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [0, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5];
const MAX_VERSION = 10;

const rawModules = (ver: number): number => {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
};
const dataCodewords = (ver: number): number =>
  Math.floor(rawModules(ver) / 8) - (ECC_PER_BLOCK_M[ver] ?? 0) * (BLOCKS_M[ver] ?? 0);

/* ---- Reed-Solomon over GF(256), polynomial 0x11D ---- */
const gfMul = (x: number, y: number): number => {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMul(coef, factor);
    });
  }
  return result;
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function buildCodewords(bytes: readonly number[], ver: number): number[] {
  const capacity = dataCodewords(ver);
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = capacity * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | (bits[i + j] ?? 0);
    data.push(v);
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const numBlocks = BLOCKS_M[ver] ?? 1;
  const eccLen = ECC_PER_BLOCK_M[ver] ?? 0;
  const rawCw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < shortLen + 1; i += 1) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(blk[i] ?? 0);
    });
  }
  return out;
}

function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = ver * 4 + 10; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

const bitAt = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

function maskFn(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length;
  let score = 0;
  const at = (x: number, y: number): boolean => m[y]?.[x] === true;
  for (const horizontal of [true, false]) {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        const same = horizontal ? at(b, a) === at(b - 1, a) : at(a, b) === at(a, b - 1);
        if (same) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
      // finder-like 1:1:3:1:1 patterns with 4 light modules on a side
      for (let b = 0; b + 10 < n + 0; b += 1) {
        const get = (k: number): boolean => (horizontal ? at(b + k, a) : at(a, b + k));
        const p = [true, false, true, true, true, false, true];
        const core = p.every((v, k) => get(k + 4) === v) || p.every((v, k) => get(k) === v);
        if (core && [0, 1, 2, 3].every((k) => !get(k)) && p.every((v, k) => get(k + 4) === v)) score += 40;
        else if (core && [7, 8, 9, 10].every((k) => !get(k)) && p.every((v, k) => get(k) === v)) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (at(x, y)) dark += 1;
      if (x + 1 < n && y + 1 < n && at(x, y) === at(x + 1, y) && at(x, y) === at(x, y + 1) && at(x, y) === at(x + 1, y + 1)) score += 3;
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export function encodeQr(text: string): boolean[][] | null {
  const bytes = utf8(text);
  let ver = 1;
  const need = (v: number): number => Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8);
  while (ver <= MAX_VERSION && need(ver) > dataCodewords(ver)) ver += 1;
  if (ver > MAX_VERSION) return null;

  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean): void => {
    const row = mods[y];
    const frow = fn[y];
    if (row === undefined || frow === undefined || x < 0 || x >= size) return;
    row[x] = dark;
    frow[x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = alignPositions(ver);
  ap.forEach((ay, i) => {
    ap.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });

  const drawFormat = (mask: number): void => {
    const data = (0 << 3) | mask; // level M = 0
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) set(8, i, bitAt(bits, i));
    set(8, 7, bitAt(bits, 6));
    set(8, 8, bitAt(bits, 7));
    set(7, 8, bitAt(bits, 8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bitAt(bits, i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bitAt(bits, i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bitAt(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bitAt(bits, i));
      set(b, a, bitAt(bits, i));
    }
  }

  const codewords = buildCodewords(bytes, ver);
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y]?.[x] !== true && bi < codewords.length * 8) {
          const row = mods[y];
          if (row !== undefined) row[x] = bitAt(codewords[bi >>> 3] ?? 0, 7 - (bi & 7));
          bi += 1;
        }
      }
    }
  }

  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const row = mods[y];
        if (row !== undefined && fn[y]?.[x] !== true && maskFn(mask, x, y)) row[x] = !row[x];
      }
    }
  };
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const s = penalty(mods);
    if (s < bestScore) {
      best = mask;
      bestScore = s;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return mods;
}

/** SVG path data ("M x y h1 v1 h-1z" per dark module) with a 4-module quiet zone; viewBox is `size + 8`. */
export function qrPath(matrix: readonly (readonly boolean[])[]): { readonly d: string; readonly viewBox: number } {
  let d = "";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    });
  });
  return { d, viewBox: matrix.length + 8 };
}
