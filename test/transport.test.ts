import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { NodeWsTransport } from "../src/transport-node.js";

describe("NodeWsTransport", () => {
  it("connects, sends binary, receives binary, and reports the Origin header", async () => {
    let seenOrigin = "";
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on("listening", r));
    const port = (wss.address() as any).port;
    wss.on("connection", (ws, req) => { seenOrigin = req.headers.origin ?? ""; ws.on("message", (m) => ws.send(m)); });

    const t = new NodeWsTransport(`ws://127.0.0.1:${port}`, { Origin: "https://steamcommunity.com" });
    const got = new Promise<Uint8Array>((res) => t.onMessage(res));
    await t.connect();
    t.send(new Uint8Array([1, 2, 3]));
    expect([...(await got)]).toEqual([1, 2, 3]);
    expect(seenOrigin).toBe("https://steamcommunity.com");
    t.close(); wss.close();
  });
});
