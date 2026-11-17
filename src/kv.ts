// Steam binary KeyValues (the micro-transaction request, the GC price sheet).
export type KV = { [key: string]: KV | string | number | bigint };

/** Steam binary KeyValues from `at`; returns the object and the offset after its end marker. */
export function readBinaryKv(buf: Uint8Array, at = 0): { kv: KV; end: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = new TextDecoder();
  let i = at;
  const cstr = () => { const j = buf.indexOf(0, i); if (j < 0) throw new Error("unterminated KeyValues string"); const s = text.decode(buf.subarray(i, j)); i = j + 1; return s; };
  const node = (): KV => {
    const out: KV = {};
    for (;;) {
      if (i >= buf.length) throw new Error("truncated KeyValues");
      const type = buf[i++];
      if (type === 8 || type === 11) return out;
      const key = cstr();
      switch (type) {
        case 0: out[key] = node(); break;
        case 1: out[key] = cstr(); break;
        case 2: out[key] = dv.getInt32(i, true); i += 4; break;
        case 3: out[key] = dv.getFloat32(i, true); i += 4; break;
        case 7: out[key] = dv.getBigUint64(i, true); i += 8; break;
        case 10: out[key] = dv.getBigInt64(i, true); i += 8; break;
        default: throw new Error(`KeyValues type ${type}`);
      }
    }
  };
  return { kv: node(), end: i };
}
