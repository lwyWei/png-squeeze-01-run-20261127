// png-squeeze-01 entry: losslessly re-encode 1280x720 RGBA screenshots into
// the smallest PNG. Node 22, stdlib only. Deterministic: no clock, no
// randomness, no environment reads; effort is scaled by the image's form.
//
// Pipeline per instance: decode the stored PNG to RGBA, choose a colour form
// (palette when <=256 colours, else grey / grey+alpha / RGB / RGBA, with a
// tRNS key when one transparent value exists), choose a per-row filter by a
// cheap compressibility score, then compress the filtered stream with an
// optimal-parsing deflate (./deflate.mjs, zopfli-style). Falls back to
// copying the input bytes if anything fails, so the instance stays answered.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { deflateZlib } from './deflate.mjs';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  dv.setUint32(8 + data.length, crc);
  return out;
}

function ihdrOf(width, height, colourType) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return ihdr;
}

function pngOf(chunks) {
  const total = 8 + chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Decode a PNG (bit depth 8, colour types 0/2/3/4/6, filters 0-4) to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  let at = 8;
  let width = 0, height = 0, colourType = 0;
  let plte = null, trns = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      if (data[8] !== 8 || data[12] !== 0) return null;
      colourType = data[9];
      if (!(colourType in CHANNELS)) return null;
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else {
      return null; // unknown chunk: not a PNG this contest reads
    }
    at += 12 + len;
  }
  if (!width || !height) return null;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const rawLen = height * (1 + stride);
  const idatLen = idat.reduce((a, c) => a + c.length, 0);
  const z = new Uint8Array(idatLen);
  let off = 0;
  for (const c of idat) { z.set(c, off); off += c.length; }
  const raw = inflateSync(z);
  if (raw.length !== rawLen) return null;
  // Unfilter into samples.
  const samples = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowOut = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? rowOut[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = i >= bpp && prev ? prev[i - bpp] : 0;
      let v = rowIn[i];
      if (f === 1) v = (v + left) & 0xff;
      else if (f === 2) v = (v + up) & 0xff;
      else if (f === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (f === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        v = (v + pred) & 0xff;
      } else if (f !== 0) return null;
      rowOut[i] = v;
    }
  }
  // Expand samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp, o = i * 4;
    if (colourType === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = samples[s];
      rgba[o + 3] = trns && samples[s] === trns[1] ? 0 : 255;
    } else if (colourType === 2) {
      rgba[o] = samples[s]; rgba[o + 1] = samples[s + 1]; rgba[o + 2] = samples[s + 2];
      rgba[o + 3] = trns && samples[s] === trns[1] && samples[s + 1] === trns[3] && samples[s + 2] === trns[5] ? 0 : 255;
    } else if (colourType === 3) {
      const v = samples[s];
      if (!plte || v * 3 + 2 >= plte.length) return null;
      rgba[o] = plte[v * 3]; rgba[o + 1] = plte[v * 3 + 1]; rgba[o + 2] = plte[v * 3 + 2];
      rgba[o + 3] = trns && v < trns.length ? trns[v] : 255;
    } else if (colourType === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = samples[s];
      rgba[o + 3] = samples[s + 1];
    } else {
      rgba[o] = samples[s]; rgba[o + 1] = samples[s + 1]; rgba[o + 2] = samples[s + 2]; rgba[o + 3] = samples[s + 3];
    }
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------- filters

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed (-128 to 127), absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

import { deflateSync } from 'node:zlib';
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filtered data for `samples` by `choice` (filter 0-4, 'minsum', 'pairs',
// 'brute'), each row behind its filter byte.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- forms

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel, or null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

const FILTERS = {
  palette: [0],
  paletteByLuminance: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
};

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks.map(([t, d]) => chunk(t, d)));
}

// ---------------------------------------------------------------- driver

const IDS = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];

function encodeOne(inputPath, outputPath) {
  const input = new Uint8Array(readFileSync(inputPath));
  try {
    const dec = decodePng(input);
    if (dec === null) throw new Error('input does not decode');
    const { rgba, width, height } = dec;
    // Screen every form/filter by the size of its zlib stream at level 6 —
    // the same screen the kit uses (a weaker level mis-ranks filter 0
    // against brute force) — and compress the winner with the optimal deflate.
    let best = null;
    for (const form of formsOf(rgba)) {
      const chunks = chunkBytes(form);
      for (const choice of form.filters) {
        const data = filtered(form.samples, width, height, form.bpp, choice);
        const bytes = deflateSync(data, { level: 6, memLevel: 8 }).length + chunks;
        if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
      }
    }
    const effort = best.form.colourType === 3 ? 'high' : best.form.colourType === 0 ? 'med' : 'low';
    let idat = deflateZlib(best.data, { effort });
    // Safety net: the custom deflate is tuned for these screenshots, but if
    // it ever loses to the platform deflate on an unseen image, take the
    // smaller stream so the entry can only improve on the baseline.
    const plain = deflateSync(best.data, { level: 9, memLevel: 9 });
    if (plain.length < idat.length) idat = plain;
    const png = pngOfForm(width, height, best.form, idat);
    mkdirSync(outputPath.slice(0, outputPath.lastIndexOf('/')), { recursive: true });
    writeFileSync(outputPath, png);
  } catch {
    // Fall back to the input bytes themselves: the stored PNG is a valid
    // (if large) PNG of the same image, so the instance stays answered.
    mkdirSync(outputPath.slice(0, outputPath.lastIndexOf('/')), { recursive: true });
    writeFileSync(outputPath, input);
  }
}

for (const id of IDS) {
  encodeOne(`/input/${id}/image.png`, `/output/${id}/image.png`);
}
