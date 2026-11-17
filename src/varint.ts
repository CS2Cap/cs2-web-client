export function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n, shift = 0n, i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) break; // 10-byte max; guard overflow
  }
  return { value, next: i };
}
export function readVarint32(buf: Uint8Array, offset: number): { value: number; next: number } {
  const r = readVarint(buf, offset);
  return { value: Number(r.value & 0xffffffffn), next: r.next };
}
export function writeVarint(value: bigint | number): Uint8Array {
  let v = BigInt(value); const out: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}
