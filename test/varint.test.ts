import { describe, it, expect } from "vitest";
import { readVarint, writeVarint, readVarint32 } from "../src/varint.js";

describe("varint", () => {
  it("round-trips small and large values", () => {
    for (const v of [0n, 1n, 127n, 128n, 300n, 4294967295n, 4294967296n, 18446744073709551615n]) {
      const { value, next } = readVarint(writeVarint(v), 0);
      expect(value).toBe(v);
      expect(next).toBe(writeVarint(v).length);
    }
  });
  it("reads a 32-bit convenience value", () => {
    expect(readVarint32(writeVarint(300), 0).value).toBe(300);
  });
  it("stops at buffer end without looping on a truncated varint", () => {
    // 0x80 = continuation bit set, but buffer ends -> must not loop forever
    const { next } = readVarint(new Uint8Array([0x80]), 0);
    expect(next).toBe(1);
  });
});
