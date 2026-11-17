import { describe, it, expect } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { FakeCM } from "../src/testing/fake-cm.js";
import { CMConnection } from "../src/cm/connection.js";
import { decodeFrame, encodeFrame } from "../src/frames.js";
import { CMsgProtoBufHeaderSchema } from "../src/gen/steam/steammessages_base_pb.js";
import { EMsg, GCMsg } from "../src/emsg.js";
import { wrapClientToGC, parseClientFromGC } from "../src/gc/envelope.js";
import { CMsgClientLogonResponseSchema } from "../src/gen/steam/steammessages_clientserver_login_pb.js";
import { CMsgClientPlayingSessionStateSchema } from "../src/gen/steam/steammessages_clientserver_2_pb.js";
import { CMsgClientWelcomeSchema } from "../src/gen/csgo/gcsdk_gcmessages_pb.js";

describe("FakeCM self-test", () => {
  it("answers a logon with the scripted EResult", async () => {
    const fake = await FakeCM.start({ logonResult: 1, sessionId: 7 });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const p = conn.waitFor(EMsg.ClientLogOnResponse, 1000);
    conn.sendMessage(EMsg.ClientLogon, new Uint8Array(0));
    const resp = await p;
    expect(resp.length).toBeGreaterThan(0);
    expect(fromBinary(CMsgClientLogonResponseSchema, resp).eresult).toBe(1);
    await fake.stop();
  });

  it("puts sessionId in the CM header and eresult in the body; captures client frames", async () => {
    const fake = await FakeCM.start({ logonResult: 1, sessionId: 7 });
    const t = fake.transport();
    const got: Uint8Array[] = [];
    t.onMessage((f) => got.push(f));
    await t.connect();
    t.send(encodeFrame(EMsg.ClientLogon, new Uint8Array(0), new Uint8Array(0)));
    await new Promise((r) => setTimeout(r, 10));
    const d = decodeFrame(got[0]);
    expect(d.emsg).toBe(EMsg.ClientLogOnResponse);
    expect(fromBinary(CMsgProtoBufHeaderSchema, d.header).clientSessionid).toBe(7);
    expect(fromBinary(CMsgClientLogonResponseSchema, d.body).eresult).toBe(1);
    expect(fake.receivedDecoded().some((m) => m.emsg === EMsg.ClientLogon)).toBe(true);
    expect(fake.received.length).toBe(1);
    await fake.stop();
  });

  it("pushes playing-session-state when playingBlocked", async () => {
    const fake = await FakeCM.start({ playingBlocked: true });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const p = conn.waitFor(EMsg.ClientPlayingSessionState, 1000);
    conn.sendMessage(EMsg.ClientLogon, new Uint8Array(0));
    const s = fromBinary(CMsgClientPlayingSessionStateSchema, await p);
    expect(s.playingBlocked).toBe(true);
    await fake.stop();
  });

  it("replies to GC ClientHello with a welcome carrying the cache", async () => {
    const fake = await FakeCM.start({ gcWelcomeWithCache: true });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const a = conn.waitFor(EMsg.ClientFromGC, 1000);
    conn.sendMessage(EMsg.ClientToGC, wrapClientToGC(GCMsg.ClientHello, new Uint8Array(0)));
    const w = parseClientFromGC(await a);
    expect(w.gcMsgType).toBe(GCMsg.ClientWelcome);
    expect(fromBinary(CMsgClientWelcomeSchema, w.body).outofdateSubscribedCaches).toHaveLength(1);
    await fake.stop();
  });

  it("GC envelope round-trips", () => {
    const body = new Uint8Array([1, 2, 3, 250]);
    const r = parseClientFromGC(wrapClientToGC(GCMsg.ClientHello, body));
    expect(r.gcMsgType).toBe(GCMsg.ClientHello);
    expect(Array.from(r.body)).toEqual([1, 2, 3, 250]);
  });
});
