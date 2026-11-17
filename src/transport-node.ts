import WebSocket from "ws";
import type { Transport } from "./transport.js";

export class NodeWsTransport implements Transport {
  private ws: WebSocket | null = null;
  private msgCb: ((f: Uint8Array) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  constructor(private url: string, private headers: Record<string, string> = {}) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.headers });
      ws.binaryType = "arraybuffer";
      ws.on("open", () => { this.ws = ws; resolve(); });
      ws.on("message", (data: ArrayBuffer | Buffer) => {
        const u = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.msgCb?.(u);
      });
      ws.on("error", (e) => { if (!this.ws) reject(e); });
      ws.on("close", (code, reason) => this.closeCb?.(code, reason.toString()));
    });
  }
  send(frame: Uint8Array): void { this.ws?.send(frame); }
  onMessage(cb: (f: Uint8Array) => void): void { this.msgCb = cb; }
  onClose(cb: (code: number, reason: string) => void): void { this.closeCb = cb; }
  close(): void { this.ws?.close(); this.ws = null; }
}
