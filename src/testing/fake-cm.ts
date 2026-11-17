import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CMsgClientWelcomeSchema, CMsgSOCacheSubscribedSchema } from "../gen/csgo/gcsdk_gcmessages_pb.js";
import { CMsgProtoBufHeaderSchema } from "../gen/steam/steammessages_base_pb.js";
import { CMsgClientAccountInfoSchema, CMsgClientLogonResponseSchema, CMsgClientLoggedOffSchema } from "../gen/steam/steammessages_clientserver_login_pb.js";
import { CMsgClientPlayingSessionStateSchema } from "../gen/steam/steammessages_clientserver_2_pb.js";
import type { Transport } from "../transport.js";
import { encodeFrame, decodeFrame } from "../frames.js";
import { EMsg, GCMsg } from "../emsg.js";
import { wrapClientToGC, parseClientFromGC } from "../gc/envelope.js";
import { buildSyntheticCacheSubscribed } from "./synthetic.js";

export type FakeOpts = {
  logonResult?: number;
  sessionId?: number;
  heartbeat?: number;
  playingBlocked?: boolean;
  /** False: stay silent after a CS2 claim. Steam answers one with the playing state. */
  answerClaim?: boolean;
  gcWelcomeWithCache?: boolean;
  /** Send ClientAccountInfo (EMsg 768) with this persona name right after a successful logon; omitted = never sent. */
  personaName?: string;
  /** Close the transport right after the fake sends this GC message type. */
  dropAfterGcMsg?: number;
};

const STEAM_ID = 76561198000000000n;

class FakeTransport implements Transport {
  msgCb: ((f: Uint8Array) => void) | null = null;
  closeCb: ((code: number, reason: string) => void) | null = null;
  closed = false;
  constructor(private onSend: (frame: Uint8Array) => void) {}
  async connect(): Promise<void> {}
  send(frame: Uint8Array): void { if (!this.closed) this.onSend(frame); }
  onMessage(cb: (f: Uint8Array) => void): void { this.msgCb = cb; }
  onClose(cb: (code: number, reason: string) => void): void { this.closeCb = cb; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(1000, "closed");
  }
  push(frame: Uint8Array): void {
    queueMicrotask(() => { if (!this.closed) this.msgCb?.(frame); });
  }
}

export class FakeCM {
  private t: FakeTransport | null = null;
  /** Raw frames the client sent, in order. */
  received: Uint8Array[] = [];
  private constructor(private opts: FakeOpts) {}

  static async start(opts: FakeOpts = {}): Promise<FakeCM> {
    return new FakeCM(opts);
  }

  transport(): Transport {
    this.t = new FakeTransport((f) => this.handle(f));
    return this.t;
  }

  receivedDecoded(): { emsg: number; header: Uint8Array; body: Uint8Array }[] {
    return this.received.map((f) => { const { emsg, header, body } = decodeFrame(f); return { emsg, header, body }; });
  }

  loggedOff(eresult: number): void {
    this.reply(757, toBinary(CMsgClientLoggedOffSchema, create(CMsgClientLoggedOffSchema, { eresult })));
  }

  playingState(playingBlocked: boolean): void {
    this.reply(EMsg.ClientPlayingSessionState, toBinary(CMsgClientPlayingSessionStateSchema, create(CMsgClientPlayingSessionStateSchema, { playingBlocked, playingApp: 730 })));
  }

  accountInfo(personaName: string): void {
    this.reply(EMsg.ClientAccountInfo, toBinary(CMsgClientAccountInfoSchema, create(CMsgClientAccountInfoSchema, { personaName, ipCountry: "US" })));
  }

  async stop(): Promise<void> {
    this.t?.close();
    this.t = null;
  }

  private header(): Uint8Array {
    return toBinary(CMsgProtoBufHeaderSchema, create(CMsgProtoBufHeaderSchema, {
      steamid: STEAM_ID,
      clientSessionid: this.opts.sessionId ?? 1,
    }));
  }

  private reply(emsg: number, body: Uint8Array): void {
    this.t?.push(encodeFrame(emsg, this.header(), body));
  }

  private replyGc(gcMsgType: number, body: Uint8Array): void {
    this.reply(EMsg.ClientFromGC, wrapClientToGC(gcMsgType, body));
    if (this.opts.dropAfterGcMsg === gcMsgType) {
      queueMicrotask(() => queueMicrotask(() => this.t?.close()));
    }
  }

  private handle(frame: Uint8Array): void {
    this.received.push(frame);
    const d = decodeFrame(frame);
    if (d.emsg === EMsg.ClientLogon) {
      this.reply(EMsg.ClientLogOnResponse, toBinary(CMsgClientLogonResponseSchema, create(CMsgClientLogonResponseSchema, {
        eresult: this.opts.logonResult ?? 1,
        heartbeatSeconds: this.opts.heartbeat ?? 9,
      })));
      if ((this.opts.logonResult ?? 1) === 1 && this.opts.personaName !== undefined) this.accountInfo(this.opts.personaName);
      if (this.opts.playingBlocked) {
        this.reply(EMsg.ClientPlayingSessionState, toBinary(CMsgClientPlayingSessionStateSchema,
          create(CMsgClientPlayingSessionStateSchema, { playingBlocked: true, playingApp: 730 })));
      }
    } else if (d.emsg === EMsg.ClientGamesPlayed && d.body.length > 0 && this.opts.answerClaim !== false) {
      this.playingState(this.opts.playingBlocked ?? false);
    } else if (d.emsg === EMsg.ClientToGC && this.opts.gcWelcomeWithCache) {
      if (parseClientFromGC(d.body).gcMsgType === GCMsg.ClientHello) {
        // Like real CS2, the SO cache rides inside ClientWelcome.outofdate_subscribed_caches.
        const cache = fromBinary(CMsgSOCacheSubscribedSchema, buildSyntheticCacheSubscribed());
        this.replyGc(GCMsg.ClientWelcome, toBinary(CMsgClientWelcomeSchema,
          create(CMsgClientWelcomeSchema, { outofdateSubscribedCaches: [cache] })));
      }
    }
  }
}
