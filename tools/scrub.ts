const STEAMID_HIGH = 0x01100001n; // individual, public universe, desktop instance

/**
 * Neutralise secrets in place (same length, protobuf framing stays valid): known token strings,
 * and any SteamID64 other than the test account, whether fixed64 or varint-encoded.
 */
export function scrub(buf: Uint8Array, opts: { steamId: bigint; secrets: string[] }): Uint8Array {
  const out = new Uint8Array(buf);
  const text = Buffer.from(out);
  for (const s of opts.secrets.filter(Boolean)) {
    for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) out.fill(0, i, i + s.length);
  }
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 8 <= out.length; i++) {
    const v = dv.getBigUint64(i, true);
    if (v >> 32n === STEAMID_HIGH && v !== opts.steamId) out.fill(0, i, i + 8);
  }
  // A SteamID64 is 57 bits, so its varint is always 9 bytes. Rewrite as a non-canonical zero of the same length.
  for (let i = 0; i + 9 <= out.length; i++) {
    if (i > 0 && out[i - 1] >= 0x80) continue; // not a varint start
    let v = 0n;
    let n = 0;
    while (n < 9 && out[i + n] >= 0x80) { v |= BigInt(out[i + n] & 0x7f) << BigInt(7 * n); n++; }
    if (n !== 8 || out[i + 8] >= 0x80) continue;
    v |= BigInt(out[i + 8]) << 56n;
    if (v >> 32n === STEAMID_HIGH && v !== opts.steamId) {
      out.fill(0x80, i, i + 8);
      out[i + 8] = 0;
    }
  }
  return out;
}
