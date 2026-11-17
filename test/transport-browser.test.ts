import { afterEach, describe, it, expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserWsTransport } from "../src/transport-browser.js";

describe("BrowserWsTransport", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("explains an origin-rewrite failure when Steam rejects the socket handshake", async () => {
    vi.stubGlobal("WebSocket", class {
      onerror: (() => void) | null = null;
      close() {}
      constructor() { queueMicrotask(() => this.onerror?.()); }
    });
    await expect(new BrowserWsTransport("wss://cm.steamserver.net/cmsocket/").connect()).rejects.toThrow(/origin rewrite not active/i);
  });
  it("times out a stalled handshake instead of leaving sync spinning", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", class { close() {} });
    const pending = new BrowserWsTransport("wss://cm.steamserver.net/cmsocket/").connect();
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });
  it("connects and round-trips binary over the global WebSocket", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(m)));
    const t = new BrowserWsTransport(`ws://127.0.0.1:${port}`);
    const got = new Promise<Uint8Array>((res) => t.onMessage(res));
    await t.connect();
    t.send(new Uint8Array([1, 2, 3]));
    expect([...(await got)]).toEqual([1, 2, 3]);
    t.close();
    wss.close();
  });
});
