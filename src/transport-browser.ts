import type { Transport } from "./transport.js";

export class BrowserWsTransport implements Transport {
  private ws: WebSocket | null = null;
  private msgCb: ((f: Uint8Array) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private cancelConnect: (() => void) | null = null;
  constructor(private url: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let opened = false;
      const fail = (message: string) => {
        clearTimeout(timer);
        this.cancelConnect = null;
        if (this.ws === ws) this.ws = null;
        reject(new Error(message));
        ws.close();
      };
      const timer = setTimeout(() => fail("Steam WebSocket handshake timed out; check the connection and Origin rewrite"), 15000);
      this.cancelConnect = () => fail("Steam WebSocket connection cancelled");
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { if (this.ws !== ws) return; opened = true; clearTimeout(timer); this.cancelConnect = null; resolve(); };
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.msgCb?.(new Uint8Array(e.data)); };
      ws.onerror = () => { if (!opened && this.ws === ws) fail("Steam WebSocket handshake failed: origin rewrite not active or Steam server unreachable"); };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        if (!opened) fail(`Steam WebSocket closed before open (${e.code}): origin rewrite not active or Steam server unreachable`);
        else { this.ws = null; this.closeCb?.(e.code, e.reason); }
      };
    });
  }
  send(frame: Uint8Array): void { this.ws?.send(frame as Uint8Array<ArrayBuffer>); }
  onMessage(cb: (f: Uint8Array) => void): void { this.msgCb = cb; }
  onClose(cb: (code: number, reason: string) => void): void { this.closeCb = cb; }
  close(): void {
    if (this.cancelConnect) { this.cancelConnect(); return; }
    const ws = this.ws; this.ws = null; ws?.close();
  }
}
