import { describe, expect, it } from "vitest";
import { scrub } from "../tools/scrub.js";

const TEST_ID = 76561198000000001n;
const OTHER_ID = 76561198123456789n;
const TOKEN = "eyJhbGciOiJFZERTQSJ9.secretpayload.sig";

function varint(v: bigint): number[] {
  const out: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
function fixed64(v: bigint): number[] {
  return [...new Uint8Array(new BigUint64Array([v]).buffer)];
}
const opts = { steamId: TEST_ID, secrets: [TOKEN] };

describe("scrub", () => {
  it("zeroes the token string", () => {
    const buf = new Uint8Array([1, 2, ...Buffer.from(TOKEN), 3]);
    const out = scrub(buf, opts);
    expect(Buffer.from(out).includes(TOKEN)).toBe(false);
    expect([...out.slice(0, 2)]).toEqual([1, 2]);
    expect(out.at(-1)).toBe(3);
  });

  it("zeroes a foreign fixed64 SteamID and keeps the test one", () => {
    const buf = new Uint8Array([0x09, ...fixed64(OTHER_ID), 0x11, ...fixed64(TEST_ID)]);
    const out = scrub(buf, opts);
    expect([...out.slice(1, 9)]).toEqual(Array(8).fill(0));
    expect([...out.slice(10, 18)]).toEqual(fixed64(TEST_ID));
  });

  it("neutralises a foreign varint SteamID (nested field) and keeps the test one", () => {
    const other = varint(OTHER_ID);
    const test = varint(TEST_ID);
    expect(other.length).toBe(9);
    const inner = [0x08, ...other, 0x10, ...test];
    const buf = new Uint8Array([0x0a, inner.length, ...inner]);
    const out = scrub(buf, opts);
    expect(out.length).toBe(buf.length);
    expect([...out.slice(3, 11)]).toEqual(Array(8).fill(0x80));
    expect(out[11]).toBe(0);
    expect([...out.slice(13, 22)]).toEqual(test);
    expect(Buffer.from(out).includes(Buffer.from(other))).toBe(false);
  });

  it("leaves unrelated bytes alone", () => {
    const buf = new Uint8Array([8, 150, 1, 18, 3, 97, 98, 99, ...varint(123456789012n)]);
    expect([...scrub(buf, opts)]).toEqual([...buf]);
  });
});
