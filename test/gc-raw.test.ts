import { describe, it, expect } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { GCClient } from "../src/gc/client.js";
import { wrapClientToGC, wrapClientToGCNonProto, parseClientFromGC } from "../src/gc/envelope.js";
import { CMsgGCClientSchema } from "../src/gen/steam/steammessages_clientserver_2_pb.js";
import type { CMClient } from "../src/cm/client.js";

function offlineGc() {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const sent: Uint8Array[] = [];
  const fakeCm = { connection: {
    addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; },
    isClosed: false,
    sendMessage: (_e: number, body: Uint8Array) => { sent.push(body); },
  } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  return { gc, sent, feed: (cmBody: Uint8Array) => handlers.forEach((h) => h(cmBody)) };
}

describe("non-proto GC envelope", () => {
  it("carries the bare msgtype and an 18-byte GCMsgHdr (version 1, no jobs) before the body", () => {
    const body = new Uint8Array([1, 2, 3]);
    const m = fromBinary(CMsgGCClientSchema, wrapClientToGCNonProto(1002, body));
    expect(m.appid).toBe(730);
    expect(m.msgtype).toBe(1002);
    expect([...m.payload]).toEqual([1, 0, ...new Array(16).fill(0xff), 1, 2, 3]);
  });

  it("parseClientFromGC strips the GCMsgHdr from a non-proto reply", () => {
    const body = new Uint8Array([9, 8, 7]);
    expect(parseClientFromGC(wrapClientToGCNonProto(1003, body))).toEqual({ gcMsgType: 1003, body });
  });
});

describe("GCClient raw access", () => {
  it("sendRaw sends proto and non-proto bodies under the given id", () => {
    const { gc, sent } = offlineGc();
    gc.sendRaw(1086, new Uint8Array([5]), { proto: true });
    gc.sendRaw(1002, new Uint8Array([6]), { proto: false });
    expect(sent.map((s) => fromBinary(CMsgGCClientSchema, s).msgtype)).toEqual([(1086 | 0x80000000) >>> 0, 1002]);
  });

  it("onGcMessage observes every GC message until removed", () => {
    const { gc, feed } = offlineGc();
    const seen: number[] = [];
    const off = gc.onGcMessage((t) => seen.push(t));
    feed(wrapClientToGC(1090, new Uint8Array()));
    feed(wrapClientToGCNonProto(1003, new Uint8Array([1])));
    off();
    feed(wrapClientToGC(1090, new Uint8Array()));
    expect(seen).toEqual([1090, 1003]);
  });
});
