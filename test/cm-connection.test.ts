import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { NodeWsTransport } from "../src/transport-node.js";
import { CMConnection } from "../src/cm/connection.js";
import { encodeFrame, decodeFrame, EMsg } from "../src/frames.js";
import { CMsgMultiSchema, CMsgProtoBufHeaderSchema } from "../src/gen/steam/steammessages_base_pb.js";

async function server(onFrame: (ws: any, d: ReturnType<typeof decodeFrame>) => void) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const port = (wss.address() as any).port;
  wss.on("connection", (ws) => {
    ws.on("message", (m: Buffer) => onFrame(ws, decodeFrame(new Uint8Array(m.buffer, m.byteOffset, m.byteLength))));
  });
  return { wss, url: `ws://127.0.0.1:${port}` };
}

describe("CMConnection", () => {
  it("rejects pending message and service waits immediately when the connection ends", async () => {
    const { wss, url } = await server(() => {});
    const conn = new CMConnection(new NodeWsTransport(url));
    await conn.open();
    const message = conn.waitFor(EMsg.ClientLogOnResponse, 60000);
    const service = conn.callService("Pending.Call#1", new Uint8Array(), 60000);
    const assertions = [expect(message).rejects.toThrow(/session ended/), expect(service).rejects.toThrow(/session ended/)];
    conn.close();
    try { await Promise.all(assertions); }
    finally { wss.close(); }
  });
  it("resolves waitFor when the scripted server replies with that EMsg", async () => {
    const { wss, url } = await server((ws, d) => {
      if (d.emsg === EMsg.ClientLogon) ws.send(encodeFrame(EMsg.ClientLogOnResponse, new Uint8Array(0), new Uint8Array([0x08, 0x01])));
    });
    const conn = new CMConnection(new NodeWsTransport(url));
    await conn.open();
    conn.sendMessage(EMsg.ClientLogon, new Uint8Array(0));
    const resp = await conn.waitFor(EMsg.ClientLogOnResponse, 2000);
    expect(resp.length).toBeGreaterThan(0);
    conn.close(); wss.close();
  });

  it("matches callService by jobid and rejects on non-OK eresult", async () => {
    const { wss, url } = await server((ws, d) => {
      const h = fromBinary(CMsgProtoBufHeaderSchema, d.header);
      if (d.emsg !== EMsg.ServiceMethodCallFromClient) return;
      const eresult = h.targetJobName === "Bad.Call#1" ? 2 : 1;
      const rh = toBinary(CMsgProtoBufHeaderSchema, create(CMsgProtoBufHeaderSchema, { jobidTarget: h.jobidSource, eresult, errorMessage: "nope" }));
      ws.send(encodeFrame(EMsg.ServiceMethodResponse, rh, d.body));
    });
    const conn = new CMConnection(new NodeWsTransport(url));
    await conn.open();
    const ok = await conn.callService("Good.Call#1", new Uint8Array([1, 2]), 2000);
    expect([...ok]).toEqual([1, 2]);
    await expect(conn.callService("Bad.Call#1", new Uint8Array(0), 2000)).rejects.toThrow(/eresult 2.*nope/);
    conn.close(); wss.close();
  });

  it("sends heartbeats and identity in the header; waitFor times out", async () => {
    const seen: number[] = [];
    let sid = 0;
    const { wss, url } = await server((_ws, d) => {
      seen.push(d.emsg);
      sid = fromBinary(CMsgProtoBufHeaderSchema, d.header).clientSessionid;
    });
    const conn = new CMConnection(new NodeWsTransport(url));
    await conn.open();
    conn.setIdentity(76561198000000000n, 42);
    conn.setHeartbeat(0.05);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toContain(EMsg.ClientHeartBeat);
    expect(sid).toBe(42);
    await expect(conn.waitFor(EMsg.ClientLogOnResponse, 50)).rejects.toThrow(/timeout/);
    conn.close(); wss.close();
  });

  it("delivers Multi sub-frames before a following plain frame, and drops bad frames", async () => {
    let onMsg: (f: Uint8Array) => void = () => {};
    const fake = {
      connect: async () => {},
      send: () => {},
      onMessage: (cb: (f: Uint8Array) => void) => { onMsg = cb; },
      onClose: () => {},
      close: () => {},
    };
    const conn = new CMConnection(fake);
    await conn.open();
    const order: string[] = [];
    const a = conn.waitFor(EMsg.ClientLogOnResponse, 1000).then(() => order.push("A"));
    const b = conn.waitFor(EMsg.ClientHeartBeat, 1000).then(() => order.push("B"));
    const sub = encodeFrame(EMsg.ClientLogOnResponse, new Uint8Array(0), new Uint8Array(0));
    const packed = new Uint8Array(4 + sub.length);
    new DataView(packed.buffer).setUint32(0, sub.length, true);
    packed.set(sub, 4);
    const multi = toBinary(CMsgMultiSchema, create(CMsgMultiSchema, { sizeUnzipped: 0, messageBody: packed }));
    onMsg(new Uint8Array([1, 2, 3]));
    onMsg(encodeFrame(EMsg.Multi, new Uint8Array(0), multi));
    onMsg(encodeFrame(EMsg.ClientHeartBeat, new Uint8Array(0), new Uint8Array(0)));
    await Promise.all([a, b]);
    expect(order).toEqual(["A", "B"]);
  });
});
