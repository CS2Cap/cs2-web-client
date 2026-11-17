import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMsgProtoBufHeaderSchema } from "../gen/steam/steammessages_base_pb.js";
import { CMsgClientHeartBeatSchema } from "../gen/steam/steammessages_clientserver_login_pb.js";
import { encodeFrame, encodeNonProtoFrame, decodeFrame, unpackMulti, EMsg } from "../frames.js";
import type { Transport } from "../transport.js";

export type HeaderFields = {
  steamId?: bigint;
  sessionId?: number;
  sourceJobId?: bigint;
  targetJobName?: string;
  routingAppid?: number;
};

type Waiter = { emsg: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void };

export class CMConnection {
  private steamId = 0n;
  private sid = 0;
  private seenSessionId = 0;
  private nextJobId = 1n;
  private waiters = new Set<Waiter>();
  private handlers = new Set<{ emsg: number; cb: (body: Uint8Array) => void }>();
  private jobs = new Map<bigint, { resolve: (r: { eresult: number | undefined; errorMessage: string; body: Uint8Array }) => void; reject: (e: Error) => void }>();
  private closeCbs: Array<(code: number, reason: string) => void> = [];
  private chain: Promise<void> = Promise.resolve();
  private hb: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  get isClosed(): boolean { return this.closed; }

  constructor(private transport: Transport) {}

  /** Session id most recently seen in an inbound CM header (0 until one arrives). */
  get sessionId(): number { return this.seenSessionId; }

  async open(): Promise<void> {
    this.transport.onMessage((f) => {
      this.chain = this.chain.then(() => this.pump(f)).catch(() => {});
    });
    this.transport.onClose((code, reason) => {
      this.finishClose(code, reason);
    });
    await this.transport.connect();
  }

  private async pump(frame: Uint8Array): Promise<void> {
    const d = decodeFrame(frame);
    if (d.emsg === EMsg.Multi) {
      for (const sub of await unpackMulti(d.body)) await this.pump(sub);
      return;
    }
    if (!d.isProto) { this.deliver(d.emsg, d.body); return; }
    const h = fromBinary(CMsgProtoBufHeaderSchema, d.header);
    if (h.clientSessionid > 0) this.seenSessionId = h.clientSessionid;
    if (d.emsg === EMsg.ServiceMethodResponse) {
      const job = this.jobs.get(h.jobidTarget);
      if (job) {
        this.jobs.delete(h.jobidTarget);
        job.resolve({ eresult: h.eresult, errorMessage: h.errorMessage, body: d.body });
        return;
      }
    }
    this.deliver(d.emsg, d.body);
  }

  private deliver(emsg: number, body: Uint8Array): void {
    for (const w of this.waiters) {
      if (w.emsg === emsg) { this.waiters.delete(w); w.resolve(body); break; }
    }
    for (const h of [...this.handlers]) {
      if (h.emsg !== emsg) continue;
      try { h.cb(body); } catch { /* a bad handler must not drop the rest of a Multi */ }
    }
  }

  /** Persistent listener for every inbound message with this EMsg (in addition to one-shot waiters). Returns an unsubscribe. */
  addHandler(emsg: number, cb: (body: Uint8Array) => void): () => void {
    const h = { emsg, cb };
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }

  sendMessage(emsg: number, body: Uint8Array, header: Partial<HeaderFields> = {}): void {
    const h = create(CMsgProtoBufHeaderSchema, {
      steamid: header.steamId ?? this.steamId,
      clientSessionid: header.sessionId ?? this.sid,
      jobidSource: header.sourceJobId ?? 0n,
      targetJobName: header.targetJobName ?? "",
      ...(header.routingAppid !== undefined ? { routingAppid: header.routingAppid } : {}),
    });
    this.transport.send(encodeFrame(emsg, toBinary(CMsgProtoBufHeaderSchema, h), body));
  }

  /** Older non-protobuf CM messages (micro-transaction authorization). */
  sendNonProto(emsg: number, body: Uint8Array): void {
    this.transport.send(encodeNonProtoFrame(emsg, this.steamId, this.sid, body));
  }

  waitFor(emsg: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Steam session ended"));
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        emsg,
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timeout waiting for EMsg ${emsg}`));
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  callService(method: string, body: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Steam session ended"));
    const jobId = this.nextJobId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new Error(`timeout calling ${method}`));
      }, timeoutMs);
      this.jobs.set(jobId, { resolve: (r) => {
        clearTimeout(timer);
        if (r.eresult !== undefined && r.eresult !== 1) {
          reject(new Error(`${method} failed: eresult ${r.eresult}${r.errorMessage ? ` (${r.errorMessage})` : ""}`));
        } else resolve(r.body);
      }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sendMessage(EMsg.ServiceMethodCallFromClient, body, { sourceJobId: jobId, targetJobName: method });
    });
  }

  setIdentity(steamId: bigint, sessionId: number): void {
    this.steamId = steamId;
    this.sid = sessionId;
  }

  setHeartbeat(seconds: number): void {
    this.stopHeartbeat();
    const body = toBinary(CMsgClientHeartBeatSchema, create(CMsgClientHeartBeatSchema, {}));
    this.hb = setInterval(() => this.sendMessage(EMsg.ClientHeartBeat, body), seconds * 1000);
  }

  onClose(cb: (code: number, reason: string) => void): () => void {
    if (this.closed) { cb(1000, "Steam session ended"); return () => {}; }
    this.closeCbs.push(cb);
    return () => { this.closeCbs = this.closeCbs.filter(listener => listener !== cb); };
  }

  close(): void {
    if (this.closed) return;
    this.transport.close();
    this.finishClose(1000, "Steam session ended");
  }

  private finishClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    const error = new Error(reason || "Steam session ended");
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
    for (const cb of [...this.closeCbs]) cb(code, reason);
    this.closeCbs = [];
  }

  private stopHeartbeat(): void {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
  }
}
