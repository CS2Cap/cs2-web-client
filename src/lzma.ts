// LZMA decoder for Valve's "LZMA" blobs (the GC store price sheet). A port of Igor Pavlov's public-domain LzmaSpec.

const PROB_INIT = 1024;
const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const ALIGN_BITS = 4;
const START_POS_MODEL = 4;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL >> 1);
const MATCH_MIN_LEN = 2;

const probs = (n: number) => new Uint16Array(n).fill(PROB_INIT);

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  constructor(private buf: Uint8Array, public pos: number) {
    if (buf[pos++] !== 0) throw new Error("LZMA: bad range coder start");
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[pos++]) >>> 0;
    this.pos = pos;
    if (this.code === this.range) throw new Error("LZMA: bad range coder start");
  }

  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
  }

  direct(numBits: number): number {
    let res = 0;
    while (numBits--) {
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const t = this.code >>> 31 ? 0xffffffff : 0; // code went "negative"
      this.code = (this.code + (this.range & t)) >>> 0;
      res = ((res << 1) + (t ? 0 : 1)) >>> 0;
      this.normalize();
    }
    return res;
  }

  bit(p: Uint16Array, i: number): number {
    const v = p[i];
    const bound = (this.range >>> 11) * v;
    let symbol: number;
    if (this.code < bound) {
      p[i] = v + ((2048 - v) >>> 5);
      this.range = bound >>> 0;
      symbol = 0;
    } else {
      p[i] = v - (v >>> 5);
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      symbol = 1;
    }
    this.normalize();
    return symbol;
  }

  tree(p: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(p, base + m);
    return m - (1 << numBits);
  }

  reverseTree(p: Uint16Array, base: number, numBits: number): number {
    let m = 1, symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(p, base + m);
      m = (m << 1) + b;
      symbol |= b << i;
    }
    return symbol;
  }
}

class LenDecoder {
  private choice = probs(2);
  private low = probs(16 << 3);
  private mid = probs(16 << 3);
  private high = probs(256);
  decode(rc: RangeDecoder, posState: number): number {
    if (!rc.bit(this.choice, 0)) return rc.tree(this.low, posState << 3, 3);
    if (!rc.bit(this.choice, 1)) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

/** Decodes raw LZMA1 data with the 5 property bytes and a known unpacked size. */
export function lzmaDecode(props: Uint8Array, data: Uint8Array, unpackSize: number): Uint8Array {
  let d = props[0];
  if (d >= 9 * 5 * 5) throw new Error("LZMA: bad properties");
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  const out = new Uint8Array(unpackSize);
  let outPos = 0;
  const rc = new RangeDecoder(data, 0);

  const literal = probs(0x300 << (lc + lp));
  const posSlot = probs(LEN_TO_POS_STATES << 6);
  const posDecoders = probs(1 + FULL_DISTANCES - END_POS_MODEL);
  const align = probs(1 << ALIGN_BITS);
  const isMatch = probs(STATES << POS_BITS_MAX);
  const isRep = probs(STATES);
  const isRepG0 = probs(STATES);
  const isRepG1 = probs(STATES);
  const isRepG2 = probs(STATES);
  const isRep0Long = probs(STATES << POS_BITS_MAX);
  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0, state = 0;
  const byteAt = (dist: number) => out[outPos - dist - 1];

  const decodeDistance = (len: number): number => {
    const lenState = Math.min(len, LEN_TO_POS_STATES - 1);
    const slot = rc.tree(posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirect = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
    if (slot < END_POS_MODEL) return (dist + rc.reverseTree(posDecoders, dist - slot, numDirect)) >>> 0;
    dist = (dist + (rc.direct(numDirect - ALIGN_BITS) << ALIGN_BITS)) >>> 0;
    return (dist + rc.reverseTree(align, 0, ALIGN_BITS)) >>> 0;
  };

  while (outPos < unpackSize) {
    const posState = outPos & pbMask;
    if (!rc.bit(isMatch, (state << POS_BITS_MAX) + posState)) {
      const prev = outPos > 0 ? out[outPos - 1] : 0;
      const base = 0x300 * (((outPos & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = byteAt(rep0);
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
      out[outPos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len: number;
    if (rc.bit(isRep, state)) {
      if (outPos === 0) throw new Error("LZMA: rep match at start");
      if (!rc.bit(isRepG0, state)) {
        if (!rc.bit(isRep0Long, (state << POS_BITS_MAX) + posState)) {
          state = state < 7 ? 9 : 11;
          out[outPos] = byteAt(rep0);
          outPos++;
          continue;
        }
      } else {
        let dist: number;
        if (!rc.bit(isRepG1, state)) dist = rep1;
        else {
          if (!rc.bit(isRepG2, state)) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xffffffff) break; // end marker
      if (rep0 >= outPos) throw new Error("LZMA: distance past start");
    }
    len += MATCH_MIN_LEN;
    for (let i = 0; i < len && outPos < unpackSize; i++) { out[outPos] = byteAt(rep0); outPos++; }
  }
  if (outPos !== unpackSize) throw new Error("LZMA: data ended early");
  return out;
}

/** Valve's container: "LZMA", u32 unpacked size, u32 packed size, 5 property bytes, packed data. */
export function valveLzmaDecode(blob: Uint8Array): Uint8Array {
  if (blob.length < 17 || String.fromCharCode(...blob.subarray(0, 4)) !== "LZMA") throw new Error("not a Valve LZMA blob");
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const size = dv.getUint32(4, true);
  return lzmaDecode(blob.subarray(12, 17), blob.subarray(17), size);
}
