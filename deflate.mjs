// deflate.mjs — optimal-parsing DEFLATE (zopfli-style), pure JS, stdlib-free.
// Compresses one filtered PNG byte stream into a zlib stream.
// Deterministic: no clock, no randomness, effort scaled by input kind only.
// Algorithm follows zopfli (Apache 2.0, google/zopfli): hash-chain longest
// match, forward DP optimal parse ("squeeze"), entropy cost model from a
// lazy greedy parse, katajainen length-limited Huffman, dynamic blocks with
// cost-based splitting. This is an independent JS implementation.

export const MAX_MATCH = 258;
export const MIN_MATCH = 3;
export const WINDOW_SIZE = 32768;
export const WINDOW_MASK = WINDOW_SIZE - 1;

// ---- deflate tables (RFC 1951) ----
export const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
export const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
export const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
export const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

export function lenSymbol(len) {
  // Length 3..258 -> symbol 257..285: largest LEN_BASE entry <= len.
  let s = 257;
  for (let i = 0; i < LEN_BASE.length; i++) {
    if (LEN_BASE[i] <= len) s = 257 + i;
    else break;
  }
  return s;
}
export function lenExtraBits(len) {
  return LEN_EXTRA[lenSymbol(len) - 257];
}
export function lenExtraValue(len) {
  return len - LEN_BASE[lenSymbol(len) - 257];
}
export function distSymbol(dist) {
  if (dist < 5) return dist - 1;
  if (dist < 9) return 4 + ((dist - 5) >> 1);
  if (dist < 17) return 6 + ((dist - 9) >> 2);
  if (dist < 33) return 8 + ((dist - 17) >> 3);
  if (dist < 65) return 10 + ((dist - 33) >> 4);
  if (dist < 129) return 12 + ((dist - 65) >> 5);
  if (dist < 257) return 14 + ((dist - 129) >> 6);
  if (dist < 513) return 16 + ((dist - 257) >> 7);
  if (dist < 1025) return 18 + ((dist - 513) >> 8);
  if (dist < 2049) return 20 + ((dist - 1025) >> 9);
  if (dist < 4097) return 22 + ((dist - 2049) >> 10);
  if (dist < 8193) return 24 + ((dist - 4097) >> 11);
  if (dist < 16385) return 26 + ((dist - 8193) >> 12);
  return 28 + ((dist - 16385) >> 13);
}
export function distExtraBits(dist) {
  return DIST_EXTRA[distSymbol(dist)];
}
export function distExtraValue(dist) {
  return dist - DIST_BASE[distSymbol(dist)];
}

// ---- length-limited Huffman code lengths (katajainen boundary package-merge) ----
// Port of zopfli's katajainen.c LengthLimitedCodeLengths, with plain objects
// instead of a node pool (GC handles the few thousand nodes).
export function lengthLimitedCodeLengths(frequencies, n, maxbits) {
  const bitlengths = new Array(n).fill(0);
  const leaves = [];
  for (let i = 0; i < n; i++) if (frequencies[i]) leaves.push({ weight: frequencies[i], count: i });
  const numsymbols = leaves.length;
  if ((1 << maxbits) < numsymbols) return { error: 1, bitlengths };
  if (numsymbols === 0) return { error: 0, bitlengths };
  if (numsymbols === 1) { bitlengths[leaves[0].count] = 1; return { error: 0, bitlengths }; }
  leaves.sort((a, b) => a.weight - b.weight);
  // lists[i] = [chain0, chain1]; a chain is {weight, count, tail}
  const lists = [];
  const node0 = { weight: leaves[0].weight, count: 1, tail: null };
  const node1 = { weight: leaves[1].weight, count: 2, tail: null };
  for (let i = 0; i < maxbits; i++) lists.push([node0, node1]);
  const boundaryPM = (index, final) => {
    const lastcount = lists[index][1].count;
    if (index === 0 && lastcount >= numsymbols) return;
    const oldchain = lists[index][1];
    let newchain;
    if (index === 0) {
      newchain = { weight: leaves[lastcount].weight, count: lastcount + 1, tail: null };
    } else {
      const sum = lists[index - 1][0].weight + lists[index - 1][1].weight;
      if (lastcount < numsymbols && sum > leaves[lastcount].weight) {
        newchain = { weight: leaves[lastcount].weight, count: lastcount + 1, tail: oldchain.tail };
      } else {
        newchain = { weight: sum, count: lastcount, tail: lists[index - 1][1] };
        if (!final) {
          lists[index][0] = oldchain;
          lists[index][1] = newchain;
          boundaryPM(index - 1, false);
          boundaryPM(index - 1, false);
          return;
        }
      }
    }
    lists[index][0] = oldchain;
    lists[index][1] = newchain;
  };
  const numRuns = 2 * numsymbols - 4;
  for (let i = 0; i < numRuns; i++) boundaryPM(maxbits - 1, i === numRuns - 1);
  // extract bit lengths from the last chain of the last list
  for (let node = lists[maxbits - 1][1]; node; node = node.tail) {
    for (let i = 0; i < node.count; i++) bitlengths[leaves[i].count]++;
  }
  return { error: 0, bitlengths };
}

// Canonical Huffman codes from code lengths.
export function lengthsToSymbols(lengths, n, maxbits) {
  const symbols = new Array(n).fill(0);
  const blCount = new Array(maxbits + 1).fill(0);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Array(maxbits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxbits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len !== 0) symbols[i] = nextCode[len]++;
  }
  return symbols;
}

// Reverse the low `len` bits of a code (deflate writes Huffman codes MSB-first).
export function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | ((code >> i) & 1); }
  return r;
}

// Fixed Huffman tree lengths (RFC 1951).
export function fixedTreeLengths() {
  const ll = new Array(288);
  const d = new Array(32).fill(5);
  for (let i = 0; i < 144; i++) ll[i] = 8;
  for (let i = 144; i < 256; i++) ll[i] = 9;
  for (let i = 256; i < 280; i++) ll[i] = 7;
  for (let i = 280; i < 288; i++) ll[i] = 8;
  return { ll, d };
}

// Entropy (ideal fractional) bit lengths from symbol counts, as zopfli does.
export function entropyLengths(count, n) {
  const kInvLog2 = 1.4426950408889;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += count[i];
  const log2sum = (sum === 0 ? Math.log(n) : Math.log(sum)) * kInvLog2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (count[i] === 0) out[i] = log2sum;
    else {
      out[i] = log2sum - Math.log(count[i]) * kInvLog2;
      if (out[i] < 0 && out[i] > -1e-5) out[i] = 0;
    }
  }
  return out;
}

// ---- LZ77 match finder: hash chains over a 32 KiB window ----
// 16-bit multiplicative hash of 3 bytes (fewer collisions than zopfli's
// 15-bit XOR hash, so chains hold fewer false candidates; true candidates —
// identical first 3 bytes — always share a hash, so quality is unchanged).
function hash3(d, i) {
  return (((d[i] * 0x9e3779b1) ^ (d[i + 1] << 8) ^ d[i + 2]) >>> 0) & 65535;
}

export class MatchFinder {
  constructor(data, opts = {}) {
    this.d = data;
    this.n = data.length;
    this.maxChain = opts.maxChain ?? 256;
    this.goodLength = opts.goodLength ?? 32;
    this.maxLazy = opts.maxLazy ?? 258;
    this.head = new Int32Array(65536).fill(-1);
    this.prev = new Int32Array(this.n).fill(-1);
    // same[i] = run length of data[i] starting at i (capped at 65535).
    const same = new Uint16Array(this.n + 1);
    const d = data;
    let run = 0;
    for (let i = this.n - 1; i >= 0; i--) {
      if (i + 1 < this.n && d[i] === d[i + 1]) { run = run + 1 > 65535 ? 65535 : run + 1; }
      else run = 1;
      same[i] = run;
    }
    this.same = same;
    this.sublen = new Uint16Array(MAX_MATCH + 1);
    this.foundLen = 0;
    this.foundDist = 0;
  }
  insert(pos) {
    const h = (pos + 2 < this.n) ? hash3(this.d, pos) : this.tailHash(pos);
    this.prev[pos] = this.head[h];
    this.head[h] = pos;
    return h;
  }
  tailHash(pos) {
    // Hash for positions near the end (fewer than 3 bytes left): pad with 0.
    const d = this.d;
    const b0 = d[pos];
    const b1 = pos + 1 < this.n ? d[pos + 1] : 0;
    const b2 = pos + 2 < this.n ? d[pos + 2] : 0;
    return (((b0 * 0x9e3779b1) ^ (b1 << 8) ^ b2) >>> 0) & 65535;
  }
  // Longest match at pos, capped at `limit` bytes and `end`. Fills sublen[k]
  // = smallest distance achieving a match of length >= k, for 3..length.
  // Returns the length; the distance is in this.foundDist. Requires
  // pos + 3 <= end. Chain walk is pruned zlib-style: once a match of
  // >= goodLength is found the remaining chain budget drops to a quarter,
  // and at >= maxLazy the walk stops.
  find(pos, end, limit) {
    const goodLength = this.goodLength;
    const maxLazy = this.maxLazy;
    const d = this.d;
    const sublen = this.sublen;
    let bestLen = 1;
    let bestDist = 0;
    const h = (pos + 2 < this.n) ? hash3(d, pos) : this.tailHash(pos);
    let p = this.head[h];
    // Note: head[h] is `pos` itself if insert(pos) was just called; the chain
    // starts at prev[pos]. Callers insert(pos) before find(), so start at prev.
    p = p === pos ? this.prev[pos] : p;
    let chain = this.maxChain; // remaining chain budget (zlib-style)
    const lim = Math.min(limit, end - pos);
    while (p >= 0 && pos - p <= WINDOW_SIZE && chain > 0) {
      const dist = pos - p;
      // Quick test: the byte at bestLen must match (and first byte must match,
      // guarding against hash collisions).
      if (d[p] === d[pos] && (pos + bestLen >= end || d[p + bestLen] === d[pos + bestLen])) {
        const len = this.getMatch(pos, p, pos + lim);
        if (len > bestLen) {
          for (let k = bestLen + 1; k <= len; k++) sublen[k] = dist;
          bestLen = len;
          bestDist = dist;
          if (len >= lim) break;
          if (len >= maxLazy) break;
          if (len >= goodLength) chain >>= 2; // good match: quarter the rest
        }
      }
      p = this.prev[p];
      chain--;
    }
    this.foundLen = bestLen;
    this.foundDist = bestDist;
    return bestLen;
  }
  // Match length of data[pos..] vs data[match..], capped at end.
  getMatch(pos, match, end) {
    const d = this.d;
    const same = this.same;
    let s = pos;
    let m = match;
    const skip = Math.min(same[s], same[m], end - s);
    if (skip > 2) { s += skip; m += skip; }
    // Unrolled byte compare, 8 at a time.
    while (s + 8 <= end) {
      if (d[s] !== d[m] || d[s + 1] !== d[m + 1] || d[s + 2] !== d[m + 2] || d[s + 3] !== d[m + 3] ||
          d[s + 4] !== d[m + 4] || d[s + 5] !== d[m + 5] || d[s + 6] !== d[m + 6] || d[s + 7] !== d[m + 7]) break;
      s += 8; m += 8;
    }
    while (s < end && d[s] === d[m]) { s++; m++; }
    return s - pos;
  }
}

// Length value used by lazy matching: long distances penalise short lengths.
function lengthValue(length, dist) {
  return dist > 1024 ? length - 1 : length;
}

// ---- Lazy greedy LZ77 parse (zopfli's LZ77Greedy with LAZY_MATCHING) ----
// Returns {litlens, dists} arrays (dists 0 = literal). Used only to derive the
// entropy cost model; the optimal DP does the real parse.
export function greedyParse(data, mfOpts = {}) {
  const n = data.length;
  const mf = new MatchFinder(data, mfOpts);
  const litlens = [];
  const dists = [];
  let prevLen = 0, prevDist = 0, matchAvail = false;
  let i = 0;
  while (i < n) {
    mf.insert(i);
    let len = 0, dist = 0;
    if (i + MIN_MATCH <= n) {
      len = mf.find(i, n, MAX_MATCH);
      dist = mf.foundDist;
    }
    const lv = lengthValue(len, dist);
    if (matchAvail) {
      matchAvail = false;
      const plv = lengthValue(prevLen, prevDist);
      if (lv > plv + 1) {
        litlens.push(data[i - 1]); dists.push(0);
        if (lv >= MIN_MATCH && len < MAX_MATCH) {
          matchAvail = true; prevLen = len; prevDist = dist;
          i++;
          continue;
        }
      } else {
        len = prevLen; dist = prevDist;
        litlens.push(len); dists.push(dist);
        for (let j = 2; j < len; j++) { i++; mf.insert(i); }
        i++;
        continue;
      }
    } else if (lv >= MIN_MATCH && len < MAX_MATCH) {
      matchAvail = true; prevLen = len; prevDist = dist;
      i++;
      continue;
    }
    if (lv >= MIN_MATCH) {
      litlens.push(len); dists.push(dist);
    } else {
      len = 1;
      litlens.push(data[i]); dists.push(0);
    }
    for (let j = 1; j < len; j++) { i++; mf.insert(i); }
    i++;
  }
  return { litlens, dists };
}

// Symbol counts from a parse (lit/len symbols 0..287, dist symbols 0..31).
export function symbolCounts(litlens, dists) {
  const ll = new Float64Array(288);
  const dd = new Float64Array(32);
  for (let i = 0; i < litlens.length; i++) {
    if (dists[i] === 0) ll[litlens[i]]++;
    else { ll[lenSymbol(litlens[i])]++; dd[distSymbol(dists[i])]++; }
  }
  ll[256] = 1; // end symbol
  return { ll, dd };
}

// ---- Optimal parse: forward DP ("squeeze"), as in zopfli's GetBestLengths ----
// llCost[288], dCost[32]: fractional bit costs per symbol (entropy model).
// Returns {litlens, dists} symbol arrays.
export function optimalParse(data, llCost, dCost, mfOpts = {}) {
  const n = data.length;
  const mf = new MatchFinder(data, mfOpts);
  // Precompute per-length and per-distance costs.
  const lenCost = new Float64Array(MAX_MATCH + 1);
  for (let k = MIN_MATCH; k <= MAX_MATCH; k++) {
    lenCost[k] = llCost[lenSymbol(k)] + lenExtraBits(k);
  }
  const distCost = new Float64Array(WINDOW_SIZE + 1);
  for (let d = 1; d <= WINDOW_SIZE; d++) {
    distCost[d] = dCost[distSymbol(d)] + distExtraBits(d);
  }
  let minLenCost = Infinity, minDistCost = Infinity;
  for (let k = MIN_MATCH; k <= MAX_MATCH; k++) if (lenCost[k] < minLenCost) minLenCost = lenCost[k];
  for (let d = 1; d <= WINDOW_SIZE; d++) if (distCost[d] < minDistCost) minDistCost = distCost[d];
  const minMatchCost = minLenCost + minDistCost;

  const costs = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) costs[i] = Infinity;
  costs[0] = 0;
  const choiceLen = new Uint16Array(n + 1);
  const choiceDist = new Uint16Array(n + 1);
  choiceLen[0] = 0;

  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    if (ci === Infinity) continue;
    mf.insert(i);
    // Literal first: it guarantees costs[i+1] is finite, so the cost chain
    // never breaks when the run shortcut below jumps ahead.
    const litC = ci + llCost[data[i]];
    if (litC < costs[i + 1]) { costs[i + 1] = litC; choiceLen[i + 1] = 1; }
    // Long repetition shortcut (zopfli's SHORTCUT_LONG_REPETITIONS): inside
    // a run of identical bytes longer than 2*258, the optimal path uses
    // length-258 matches at distance 1. Seed the costs 258 ahead and skip
    // the match search for the run's interior positions.
    if (mf.same[i] > MAX_MATCH * 2 && i > MAX_MATCH + 1 && i + MAX_MATCH * 2 + 1 < n && mf.same[i - MAX_MATCH] > MAX_MATCH) {
      const sc = lenCost[MAX_MATCH] + distCost[1];
      for (let k = 0; k < MAX_MATCH; k++) {
        const src = i + k, dst = i + MAX_MATCH + k;
        if (dst <= n && costs[dst] > costs[src] + sc) {
          costs[dst] = costs[src] + sc;
          choiceLen[dst] = MAX_MATCH;
          choiceDist[dst] = 1;
        }
      }
      for (let p = i + 1; p <= i + MAX_MATCH && p < n; p++) mf.insert(p);
      i += MAX_MATCH;
      continue;
    }
    if (i + MIN_MATCH > n) continue;
    const leng = mf.find(i, n, MAX_MATCH);
    const sublen = mf.sublen;
    for (let k = MIN_MATCH; k <= leng && i + k <= n; k++) {
      if (costs[i + k] - ci <= minMatchCost) continue;
      const c = ci + lenCost[k] + distCost[sublen[k]];
      if (c < costs[i + k]) { costs[i + k] = c; choiceLen[i + k] = k; choiceDist[i + k] = sublen[k]; }
    }
  }
  // Trace back from n to 0.
  const litlens = [];
  const dists = [];
  let idx = n;
  while (idx > 0) {
    const len = choiceLen[idx];
    if (len === 0) {
      // Defensive fallback (should not happen): treat as a literal so the
      // traceback always terminates.
      litlens.push(data[idx - 1]); dists.push(0); idx -= 1;
    } else if (len === 1) { litlens.push(data[idx - 1]); dists.push(0); idx -= 1; }
    else { litlens.push(len); dists.push(choiceDist[idx]); idx -= len; }
  }
  litlens.reverse();
  dists.reverse();
  return { litlens, dists, cost: costs[n] };
}

// ---- Bit writer (LSB-first packing; Huffman codes emitted MSB-first via reversal) ----
export class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  // Write the low `len` bits of value, bit 0 first.
  writeBits(value, len) {
    this.acc |= (value << this.nbits) >>> 0;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeBit(b) { this.writeBits(b, 1); }
  // Write a Huffman code (canonical code, `len` bits), most significant first.
  writeHuffman(code, len) {
    this.writeBits(reverseBits(code, len), len);
  }
  finish() {
    if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
    return new Uint8Array(this.bytes);
  }
}

// Adler-32 (zlib's checksum).
export function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- Dynamic Huffman tree emission (port of zopfli's AddDynamicTree) ----
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export function writeDynamicTree(bw, llLengths, dLengths) {
  let hlit = 29;
  while (hlit > 0 && llLengths[257 + hlit - 1] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && dLengths[1 + hdist - 1] === 0) hdist--;
  const lldTotal = hlit + 257 + hdist + 1;
  const lld = new Array(lldTotal);
  for (let i = 0; i < lldTotal; i++) lld[i] = i < 257 + hlit ? llLengths[i] : dLengths[i - 257 - hlit];
  // RLE of the code lengths.
  const rle = [], rleBits = [];
  for (let i = 0; i < lldTotal;) {
    let count = 0;
    for (let j = i; j < lldTotal && lld[i] === lld[j]; j++) count++;
    if (count >= 4 || (count >= 3 && lld[i] === 0)) {
      if (lld[i] === 0) {
        if (count > 10) {
          if (count > 138) count = 138;
          rle.push(18); rleBits.push(count - 11);
        } else {
          rle.push(17); rleBits.push(count - 3);
        }
      } else {
        let repeat = count - 1;
        rle.push(lld[i]); rleBits.push(0);
        while (repeat >= 6) { rle.push(16); rleBits.push(3); repeat -= 6; }
        if (repeat >= 3) { rle.push(16); rleBits.push(0); repeat -= 3; }
        while (repeat !== 0) { rle.push(lld[i]); rleBits.push(0); repeat--; }
      }
      i += count;
    } else {
      rle.push(lld[i]); rleBits.push(0);
      i++;
    }
  }
  const clCounts = new Array(19).fill(0);
  for (const s of rle) clCounts[s]++;
  const { bitlengths: clcl } = lengthLimitedCodeLengths(clCounts, 19, 7);
  const clSymbols = lengthsToSymbols(clcl, 19, 7);
  let hclen = 15;
  while (hclen > 0 && clCounts[CL_ORDER[hclen + 4 - 1]] === 0) hclen--;
  bw.writeBits(hlit, 5);
  bw.writeBits(hdist, 5);
  bw.writeBits(hclen, 4);
  for (let i = 0; i < hclen + 4; i++) bw.writeBits(clcl[CL_ORDER[i]], 3);
  for (let i = 0; i < rle.length; i++) {
    bw.writeHuffman(clSymbols[rle[i]], clcl[rle[i]]);
    if (rle[i] === 16) bw.writeBits(rleBits[i], 2);
    else if (rle[i] === 17) bw.writeBits(rleBits[i], 3);
    else if (rle[i] === 18) bw.writeBits(rleBits[i], 7);
  }
}

// Exact bit size of the dynamic tree as it will be encoded (by building it
// into a throwaway writer), as zopfli's CalculateTreeSize does.
export function treeBitSize(llLengths, dLengths) {
  const bw = new BitWriter();
  writeDynamicTree(bw, llLengths, dLengths);
  return bw.bytes.length * 8 + bw.nbits;
}

// Patch distance code lengths so at least two distance codes exist (zlib
// 1.2.1 bug workaround, as in zopfli's PatchDistanceCodesForBuggyDecoders).
function patchDistances(dLengths) {
  let num = 0;
  for (let i = 0; i < 30; i++) {
    if (dLengths[i]) num++;
    if (num >= 2) return;
  }
  if (num === 0) { dLengths[0] = 1; dLengths[1] = 1; }
  else if (num === 1) { dLengths[dLengths[0] ? 1 : 0] = 1; }
}

// Exact cost in bits of encoding symbols [lstart, lend) as one dynamic block
// (header 3 bits + tree + symbol bits + end symbol).
export function blockBitSize(litlens, dists, lstart, lend) {
  const llCounts = new Float64Array(288);
  const dCounts = new Float64Array(32);
  for (let i = lstart; i < lend; i++) {
    if (dists[i] === 0) llCounts[litlens[i]]++;
    else { llCounts[lenSymbol(litlens[i])]++; dCounts[distSymbol(dists[i])]++; }
  }
  llCounts[256] = 1;
  const { bitlengths: llLengths } = lengthLimitedCodeLengths(llCounts, 288, 15);
  const { bitlengths: dLengths } = lengthLimitedCodeLengths(dCounts, 32, 15);
  patchDistances(dLengths);
  let bits = 3 + treeBitSize(llLengths, dLengths);
  for (let i = lstart; i < lend; i++) {
    if (dists[i] === 0) bits += llLengths[litlens[i]];
    else bits += llLengths[lenSymbol(litlens[i])] + lenExtraBits(litlens[i]) + dLengths[distSymbol(dists[i])] + distExtraBits(dists[i]);
  }
  bits += llLengths[256];
  return bits;
}

// Exact cost in bits of encoding symbols [lstart, lend) as one fixed block.
export function fixedBlockBitSize(litlens, dists, lstart, lend) {
  const { ll, d } = fixedTreeLengths();
  let bits = 3;
  for (let i = lstart; i < lend; i++) {
    if (dists[i] === 0) bits += ll[litlens[i]];
    else bits += ll[lenSymbol(litlens[i])] + lenExtraBits(litlens[i]) + d[distSymbol(dists[i])] + distExtraBits(dists[i]);
  }
  bits += ll[256];
  return bits;
}

// Emit one block of symbols [lstart, lend) with a dynamic (btype 2) or fixed
// (btype 1) tree. `final` sets the BFINAL bit.
export function writeBlock(bw, litlens, dists, lstart, lend, final, btype) {
  bw.writeBit(final ? 1 : 0);
  bw.writeBit(btype & 1);
  bw.writeBit((btype & 2) >> 1);
  let llLengths, dLengths;
  if (btype === 1) {
    ({ ll: llLengths, d: dLengths } = fixedTreeLengths());
  } else {
    const llCounts = new Float64Array(288);
    const dCounts = new Float64Array(32);
    for (let i = lstart; i < lend; i++) {
      if (dists[i] === 0) llCounts[litlens[i]]++;
      else { llCounts[lenSymbol(litlens[i])]++; dCounts[distSymbol(dists[i])]++; }
    }
    llCounts[256] = 1;
    ({ bitlengths: llLengths } = lengthLimitedCodeLengths(llCounts, 288, 15));
    ({ bitlengths: dLengths } = lengthLimitedCodeLengths(dCounts, 32, 15));
    patchDistances(dLengths);
    writeDynamicTree(bw, llLengths, dLengths);
  }
  const llSymbols = lengthsToSymbols(llLengths, 288, 15);
  const dSymbols = lengthsToSymbols(dLengths, 32, 15);
  for (let i = lstart; i < lend; i++) {
    if (dists[i] === 0) {
      bw.writeHuffman(llSymbols[litlens[i]], llLengths[litlens[i]]);
    } else {
      const ls = lenSymbol(litlens[i]);
      bw.writeHuffman(llSymbols[ls], llLengths[ls]);
      bw.writeBits(lenExtraValue(litlens[i]), lenExtraBits(litlens[i]));
      const ds = distSymbol(dists[i]);
      bw.writeHuffman(dSymbols[ds], dLengths[ds]);
      bw.writeBits(distExtraValue(dists[i]), distExtraBits(dists[i]));
    }
  }
  bw.writeHuffman(llSymbols[256], llLengths[256]);
}

// ---- Top level: compress `data` (Uint8Array) into a zlib stream ----
// Effort is scaled by input kind (deterministic, never by the clock).
// `effort` is 'high' (repetitive palette/flat data: long chains, no chain
// pruning), 'med' (grey) or 'low' (large photographic RGB/RGBA: short
// chains, one pass, pruning on). `opts` may override any of maxChain /
// extraPass / goodLength / maxLazy directly.
export function deflateZlib(data, opts = {}) {
  const n = data.length;
  const effort = opts.effort ?? 'low';
  const maxChain = opts.maxChain ?? (effort === 'high' ? 2048 : effort === 'med' ? 512 : 128);
  const extraPass = opts.extraPass ?? false;
  const goodLength = opts.goodLength ?? (effort === 'high' ? 258 : 32);
  const maxLazy = opts.maxLazy ?? (effort === 'high' ? 258 : 128);
  const mfOpts = { maxChain, goodLength, maxLazy };
  if (n === 0) {
    // Empty input: one fixed empty block.
    const bw = new BitWriter();
    bw.writeBit(1); bw.writeBit(1); bw.writeBit(0);
    const { ll, d } = fixedTreeLengths();
    const llSymbols = lengthsToSymbols(ll, 288, 15);
    bw.writeHuffman(llSymbols[256], ll[256]);
    const body = bw.finish();
    const out = new Uint8Array(2 + body.length + 4);
    out[0] = 0x78; out[1] = 0x9c;
    out.set(body, 2);
    const a = adler32(data);
    out[2 + body.length] = (a >>> 24) & 0xff;
    out[3 + body.length] = (a >>> 16) & 0xff;
    out[4 + body.length] = (a >>> 8) & 0xff;
    out[5 + body.length] = a & 0xff;
    return out;
  }
  // 1) Lazy greedy parse -> entropy cost model.
  const g = greedyParse(data, mfOpts);
  const gc = symbolCounts(g.litlens, g.dists);
  const llEnt = entropyLengths(gc.ll, 288);
  const dEnt = entropyLengths(gc.dd, 32);
  // 2) Optimal DP with the entropy model.
  let parse = optimalParse(data, llEnt, dEnt, mfOpts);
  let best = { litlens: parse.litlens, dists: parse.dists, bits: Infinity };
  best.bits = totalBits(parse.litlens, parse.dists);
  // 3) Optional second DP with costs from the first parse.
  if (extraPass) {
    const c2 = symbolCounts(parse.litlens, parse.dists);
    const ll2 = entropyLengths(c2.ll, 288);
    const d2 = entropyLengths(c2.dd, 32);
    const parse2 = optimalParse(data, ll2, d2, mfOpts);
    const bits2 = totalBits(parse2.litlens, parse2.dists);
    if (bits2 < best.bits) best = { litlens: parse2.litlens, dists: parse2.dists, bits: bits2 };
  }
  // 4) Emit with the best block split.
  const bw = new BitWriter();
  const { litlens, dists } = best;
  const blocks = chooseSplit(litlens, dists);
  for (let b = 0; b < blocks.length; b++) {
    const [s, e] = blocks[b];
    const dyn = blockBitSize(litlens, dists, s, e);
    const fix = fixedBlockBitSize(litlens, dists, s, e);
    writeBlock(bw, litlens, dists, s, e, b === blocks.length - 1, dyn <= fix ? 2 : 1);
  }
  const body = bw.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  const a = adler32(data);
  out[2 + body.length] = (a >>> 24) & 0xff;
  out[3 + body.length] = (a >>> 16) & 0xff;
  out[4 + body.length] = (a >>> 8) & 0xff;
  out[5 + body.length] = a & 0xff;
  return out;
}

// Total bits of the best split (dynamic blocks, whole vs fixed symbol-count
// splits), used to compare parses.
export function totalBits(litlens, dists) {
  const blocks = chooseSplit(litlens, dists);
  let bits = 0;
  for (const [s, e] of blocks) {
    bits += Math.min(blockBitSize(litlens, dists, s, e), fixedBlockBitSize(litlens, dists, s, e));
  }
  return bits;
}

// Choose a block split of the symbol stream: whole, or fixed-size blocks of
// 65536 / 32768 / 16384 symbols; keep the cheapest by exact bit cost.
export function chooseSplit(litlens, dists) {
  const n = litlens.length;
  const whole = [[0, n]];
  let bestBlocks = whole;
  let bestBits = splitBits(litlens, dists, whole);
  for (const g of [65536, 32768, 16384]) {
    if (n <= g) continue;
    const blocks = [];
    for (let s = 0; s < n; s += g) blocks.push([s, Math.min(n, s + g)]);
    // A trailing block under 512 symbols is merged into the previous one.
    if (blocks.length > 1 && blocks[blocks.length - 1][1] - blocks[blocks.length - 1][0] < 512) {
      blocks[blocks.length - 2][1] = blocks[blocks.length - 1][1];
      blocks.pop();
    }
    const bits = splitBits(litlens, dists, blocks);
    if (bits < bestBits) { bestBits = bits; bestBlocks = blocks; }
  }
  return bestBlocks;
}

function splitBits(litlens, dists, blocks) {
  let bits = 0;
  for (const [s, e] of blocks) {
    bits += Math.min(blockBitSize(litlens, dists, s, e), fixedBlockBitSize(litlens, dists, s, e));
  }
  return bits;
}
