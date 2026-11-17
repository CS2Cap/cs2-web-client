import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, unpackMulti, EMsg } from "../src/frames.js";
import { CMsgMultiSchema } from "../src/gen/steam/steammessages_base_pb.js";
import { create, toBinary } from "@bufbuild/protobuf";
import { gzipSync } from "node:zlib";

describe("frames", () => {
  it("round-trips a proto frame header+body", () => {
    const header = new Uint8Array([1, 2, 3]);
    const body = new Uint8Array([9, 8, 7]);
    const f = encodeFrame(EMsg.ClientLogon, header, body);
    const d = decodeFrame(f);
    expect(d.emsg).toBe(EMsg.ClientLogon);
    expect(d.isProto).toBe(true);
    expect([...d.header]).toEqual([1, 2, 3]);
    expect([...d.body]).toEqual([9, 8, 7]);
  });

  it("unpacks a gzip Multi containing two size-prefixed sub-messages", async () => {
    const a = new Uint8Array([0xaa]);
    const b = new Uint8Array([0xbb, 0xcc]);
    const concat = new Uint8Array(4 + a.length + 4 + b.length);
    const dv = new DataView(concat.buffer);
    dv.setUint32(0, a.length, true);
    concat.set(a, 4);
    dv.setUint32(4 + a.length, b.length, true);
    concat.set(b, 8 + a.length);
    const gz = gzipSync(Buffer.from(concat));
    const multi = toBinary(
      CMsgMultiSchema,
      create(CMsgMultiSchema, { sizeUnzipped: concat.length, messageBody: new Uint8Array(gz) }),
    );
    const parts = await unpackMulti(multi);
    expect(parts.map((p) => [...p])).toEqual([[0xaa], [0xbb, 0xcc]]);
  });
});
