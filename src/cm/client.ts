import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMConnection } from "./connection.js";
import { EMsg } from "../frames.js";
import { CMsgClientAccountInfoSchema, CMsgClientLogonSchema, CMsgClientLogonResponseSchema } from "../gen/steam/steammessages_clientserver_login_pb.js";

import { CMsgClientChangeStatusSchema } from "../gen/steam/steammessages_clientserver_friends_pb.js";
import { CMsgClientGamesPlayedSchema, CMsgClientWalletInfoUpdateSchema } from "../gen/steam/steammessages_clientserver_pb.js";
import { CMsgClientPlayingSessionStateSchema } from "../gen/steam/steammessages_clientserver_2_pb.js";

export { CMConnection } from "./connection.js";

const PROTOCOL_VERSION = 65580;
const LOGON_TIMEOUT_MS = 15000;
const DEFAULT_HEARTBEAT_S = 9;
const CS2_APPID = 730n;

export class AccountBusyError extends Error {
  constructor() {
    super("Steam account is playing another game (playing session blocked)");
    this.name = "AccountBusyError";
  }
}

export class SteamLogonError extends Error {
  constructor(public eresult: number) {
    super(`Steam logon failed: EResult ${eresult}`);
    this.name = "SteamLogonError";
  }
}

export class CMClient {
  private _sessionId = 0;
  private _steamId = 0n;
  // Armed before logon is sent: Steam pushes the playing-state right behind the logon response,
  // so a waiter registered afterwards could miss it. null result = timed out / never armed.
  private playingState: Promise<Uint8Array | null> | null = null;
  private _personaName: string | null = null;
  private _wallet: { balanceCents: number; pendingCents: number; currency: number } | null = null;

  constructor(private conn: CMConnection) {
    conn.addHandler(EMsg.ClientLoggedOff, () => conn.close());
    // Steam pushes ClientAccountInfo after logon; captured opportunistically, never awaited.
    conn.addHandler(EMsg.ClientAccountInfo, (body) => {
      const name = fromBinary(CMsgClientAccountInfoSchema, body).personaName;
      if (name) this._personaName = name;
    });
    // Steam pushes the wallet right after logon and again after every purchase.
    conn.addHandler(EMsg.ClientWalletInfoUpdate, (body) => {
      const w = fromBinary(CMsgClientWalletInfoUpdateSchema, body);
      this._wallet = w.hasWallet ? { balanceCents: Number(w.balance64 || BigInt(w.balance)), pendingCents: Number(w.balance64Delayed || BigInt(w.balanceDelayed)), currency: w.currency } : null;
    });
  }

  get connection(): CMConnection { return this.conn; }
  get sessionId(): number { return this._sessionId; }
  get steamId(): bigint { return this._steamId; }
  /** The Steam Wallet in its own currency (Steam's ECurrencyCode); null until Steam reports it, or with no wallet. */
  get wallet(): { balanceCents: number; pendingCents: number; currency: number } | null { return this._wallet; }
  /** The Steam profile name, not the login name; null until Steam reports it. */
  get personaName(): string | null { return this._personaName; }

  async logon(opts: { steamId: bigint; accountName: string; refreshToken: string }): Promise<void> {
    const body = toBinary(CMsgClientLogonSchema, create(CMsgClientLogonSchema, {
      accountName: opts.accountName,
      accessToken: opts.refreshToken,
      protocolVersion: PROTOCOL_VERSION,
    }));
    const pending = this.conn.waitFor(EMsg.ClientLogOnResponse, LOGON_TIMEOUT_MS);
    this.playingState = this.conn.waitFor(EMsg.ClientPlayingSessionState, LOGON_TIMEOUT_MS).catch(() => null);
    this.conn.sendMessage(EMsg.ClientLogon, body, { steamId: opts.steamId });
    const resp = fromBinary(CMsgClientLogonResponseSchema, await pending);
    if (resp.eresult !== 1) throw new SteamLogonError(resp.eresult);
    const sessionId = this.conn.sessionId;
    this.conn.setIdentity(opts.steamId, sessionId);
    this.conn.setHeartbeat(resp.heartbeatSeconds || resp.legacyOutOfGameHeartbeatSeconds || DEFAULT_HEARTBEAT_S);
    this._steamId = opts.steamId;
    this._sessionId = sessionId;
  }

  /** Fails fast with AccountBusyError if Steam reports another session is playing; a quiet wire means not blocked. */
  async assertNotPlaying(timeoutMs: number): Promise<void> {
    const pending = this.playingState ?? this.conn.waitFor(EMsg.ClientPlayingSessionState, timeoutMs).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = await Promise.race([
      pending,
      new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (body && fromBinary(CMsgClientPlayingSessionStateSchema, body).playingBlocked) throw new AccountBusyError();
  }

  /** Calls back whenever Steam reports another session holds the playing session; returns an unsubscribe. */
  onPlayingBlocked(cb: () => void): () => void {
    return this.conn.addHandler(EMsg.ClientPlayingSessionState, (body) => {
      if (fromBinary(CMsgClientPlayingSessionStateSchema, body).playingBlocked) cb();
    });
  }

  /** Claims CS2 and waits for Steam's answer, the playing state: a GC hello sent before it is often dropped. A block rejects with AccountBusyError; silence past `timeoutMs` goes ahead. */
  claimCs2(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (fn: () => void) => { clearTimeout(timer); offState(); offClose(); fn(); };
      const offState = this.conn.addHandler(EMsg.ClientPlayingSessionState, (body) => {
        const blocked = fromBinary(CMsgClientPlayingSessionStateSchema, body).playingBlocked;
        settle(() => (blocked ? reject(new AccountBusyError()) : resolve()));
      });
      const offClose = this.conn.onClose(() => settle(() => reject(new Error("Steam session ended"))));
      const timer = setTimeout(() => settle(resolve), timeoutMs);
      this.sendGamesPlayed([CS2_APPID]);
    });
  }

  /** Steam ends the login this session logged on with: its refresh token stops working. */
  logOff(): void {
    this.conn.sendMessage(EMsg.ClientLogOff, new Uint8Array(0));
  }

  releaseGames(): void {
    this.sendGamesPlayed([]);
  }

  private sendGamesPlayed(ids: bigint[]): void {
    const body = toBinary(CMsgClientGamesPlayedSchema, create(CMsgClientGamesPlayedSchema, {
      gamesPlayed: ids.map((gameId) => ({ gameId })),
    }));
    this.conn.sendMessage(EMsg.ClientGamesPlayed, body);
  }

  /** Surfaces connection loss (incl. LoggedInElsewhere, best-effort). Callers must not auto-reconnect. */
  onKicked(cb: () => void): void {
    this.conn.onClose(() => cb());
  }

  setPersonaInvisible(): void {
    this.conn.sendMessage(
      EMsg.ClientChangeStatus,
      toBinary(CMsgClientChangeStatusSchema, create(CMsgClientChangeStatusSchema, { personaState: 7 })),
    );
  }
}
