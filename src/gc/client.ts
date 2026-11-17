import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMsgGCCStrike15_v2_ClientLogonFatalErrorSchema } from "../gen/csgo/cstrike15_gcmessages_pb.js";
import type { CMClient } from "../cm/client.js";
import { EMsg } from "../frames.js";
import { GCMsg } from "../emsg.js";
import { writeVarint } from "../varint.js";
import { wrapClientToGC, wrapClientToGCNonProto, parseClientFromGC } from "./envelope.js";
import { SOCache, toHex } from "./so-cache.js";
import { STORAGE_UNIT_DEF, type DomainItem } from "../types.js";
import { CMsgCasketItemSchema, CMsgGCItemCustomizationNotificationSchema } from "../gen/csgo/econ_gcmessages_pb.js";
import { CMsgClientHelloSchema } from "../gen/csgo/gcsdk_gcmessages_pb.js";
import { CMsgModifyItemStringAttrSchema } from "../gen/csgo/base_gcmessages_pb.js";
import { FALLBACK_CS2_VERSION } from "../client-version.js";

const DEBUG = (): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CS2_WEB_CLIENT_DEBUG;

const CS2_APPID = 730;
// The GC rejects a wrong or missing version with ClientLogonFatalError errorcode=4: pass the live one
// (fetchClientVersion) as clientVersion; this baked build is only the fallback.
const CS2_CLIENT_VERSION = FALLBACK_CS2_VERSION;
const HELLO_REPEAT_MS = 2500;
const CASKET_POLL_MS = 10;
const CASKET_FORM_MS = 3000;

/** What identifies one skin across a change of id. */
export type SkinPrint = Pick<DomainItem, "defIndex" | "paintIndex" | "paintSeed" | "paintWear" | "isStatTrak">;

export type MutationIntent =
  | import("./agent-patches.js").PatchIntent
  | { kind: "swapStatTrak"; itemId: string; otherItemId: string; toolItemId: string; expectedCount: number; expectedOtherCount: number; was?: SkinPrint; otherWas?: SkinPrint }
  | { kind: "deposit"; itemId: string; casketId: string }
  | { kind: "withdraw"; itemId: string; casketId: string }
  | { kind: "rename"; itemId: string; expectedName: string }
  | { kind: "destroy"; itemId: string }
  // Item actions (sent and judged in item-ops.ts). `itemId` is the item the action changes;
  // `was` is that item before the send, filled from the live cache, so a re-created item is found again.
  | { kind: "scrapeSticker"; itemId: string; slot: number; wearBefore: number | null; target?: number; was?: SkinPrint }
  | { kind: "applySticker"; itemId: string; stickerItemId: string; slot: number; offsetX: number; offsetY: number; rotation: number; wear?: number; stickersBefore?: number; was?: SkinPrint }
  | { kind: "applyCharm"; itemId: string; charmItemId: string; offset: [number, number, number] | null; was?: SkinPrint }
  | { kind: "removeCharm"; itemId: string; was?: SkinPrint }
  | { kind: "nameTag"; itemId: string; nameTagItemId: string; name: string; was?: SkinPrint }
  | { kind: "removeNameTag"; itemId: string; was?: SkinPrint }
  | { kind: "open"; itemId: string; keyItemId: string | null }
  // `itemId` is the active terminal; `offerItemId` the offer inside it, filled from the live cache.
  | { kind: "declineOffer"; itemId: string; offerCounter: number; offerItemId: string | null }
  /** CS2's End on a terminal's final offer: the same UseToolWithIntArg with the final counter; the GC destroys the terminal. */
  | { kind: "endTerminal"; itemId: string; offerCounter: number }
  | { kind: "firstOffer"; itemId: string }
  // `itemId` names no item ("armory"); `starsBefore` is filled from the live cache.
  | { kind: "redeemArmory"; itemId: string; campaignId: number; redeemId: number; stars: number; starsBefore: number | null }
  | { kind: "craft"; itemId: string; itemIds: string[]; recipe: number }
  // `itemId` is the slab: an empty Sticker Slab to seal `stickerItemId` in, or a filled one to crack open.
  | { kind: "slabSticker"; itemId: string; stickerItemId: string }
  | { kind: "crackSlab"; itemId: string }
  // `itemId` is an Armory Pass (def 1354), consumed into Armory stars.
  | { kind: "activatePass"; itemId: string }
  // `itemId` names no item ("carepackage"); `itemIds` are the picked rewards; `cost`, `generationTime` and `balanceBefore` are filled from the live cache.
  | { kind: "claimRewards"; itemId: string; itemIds: string[]; cost: number; generationTime: number | null; balanceBefore: number | null };

export class CasketLoadTimeout extends Error {
  constructor(public loaded: number) {
    super(`storage unit load timed out with ${loaded} items`);
    this.name = "CasketLoadTimeout";
  }
}

/** No live Steam session: thrown before anything is sent, so the request did not happen. */
export class NoSessionError extends Error {
  constructor(message = "not connected") {
    super(message);
    this.name = "NoSessionError";
  }
}

export class MutationTimeout extends Error {
  constructor(public intent: MutationIntent) {
    super(`mutation did not confirm: ${intent.kind} ${intent.itemId}`);
    this.name = "MutationTimeout";
  }
}

export class CasketFullError extends Error {
  constructor(message = "storage unit or inventory is full") {
    super(message);
    this.name = "CasketFullError";
  }
}

export class GCClient {
  private readonly _cache = new SOCache();
  private casketFull: string | null = null;
  /** Unit the latest CasketAdded notification named. */
  private casketAdded: string | null = null;
  /** Item the latest NameItem notification named: a first naming re-creates the unit under a new id. */
  private named: string | null = null;
  private welcomed = false;
  private onWelcome: Array<() => void> = [];
  private observers: Array<(gcMsgType: number, body: Uint8Array) => void> = [];
  /** Judges item-action intents (item-ops.ts), set when the session opens. */
  itemApplied?: (cache: SOCache, intent: MutationIntent) => boolean;

  constructor(private cm: CMClient, private opts?: { clientVersion?: number }) {
    cm.connection.addHandler(EMsg.ClientFromGC, (body) => this.routeGc(body));
  }

  get cache(): SOCache { return this._cache; }
  get sessionClosed(): boolean { return this.cm.connection.isClosed; }

  private markWelcome(): void {
    this.welcomed = true;
    const cbs = this.onWelcome;
    this.onWelcome = [];
    for (const cb of cbs) cb();
  }

  /** Each apply is guarded so one malformed object cannot drop the rest of a batch. */
  private guarded(fn: () => void): void {
    try { fn(); } catch { /* malformed SO payload: skip it */ }
  }

  private routeGc(cmBody: Uint8Array): void {
    const { gcMsgType, body } = parseClientFromGC(cmBody);
    if (DEBUG()) {
      const hex = toHex(body);
      console.error(`[gc] recv ${gcMsgType} (${body.byteLength}b) ${hex}`);
      if (gcMsgType === 9187) {
        try {
          const e = fromBinary(CMsgGCCStrike15_v2_ClientLogonFatalErrorSchema, body);
          console.error(`[gc] FATAL logon error: errorcode=${e.errorcode} message=${JSON.stringify(e.message)} country=${JSON.stringify(e.country)}`);
        } catch (err) { console.error(`[gc] (could not decode fatal error: ${err})`); }
      }
    }
    switch (gcMsgType) {
      case GCMsg.ClientWelcome:
        this.guarded(() => this._cache.applyClientWelcome(body));
        this.markWelcome();
        break;
      case GCMsg.SOCacheSubscribed:
        this.guarded(() => this._cache.applyCacheSubscribed(body));
        this.markWelcome();
        break;
      case GCMsg.SOCreate: this.guarded(() => this._cache.applyCreate(body)); break;
      case GCMsg.SOUpdate: this.guarded(() => this._cache.applyUpdate(body)); break;
      case GCMsg.SODestroy: this.guarded(() => this._cache.applyDestroy(body)); break;
      case GCMsg.SOUpdateMultiple: this.guarded(() => this._cache.applyUpdateMultiple(body)); break;
      case GCMsg.ItemCustomizationNotification: this.guarded(() => this.noteCustomization(body)); break;
      // Terminal offers may arrive in messages nothing decodes yet: kept raw for study.
      default: this._cache.keepRaw(gcMsgType, "message", body);
    }
    for (const o of this.observers) this.guarded(() => o(gcMsgType, body));
  }

  private noteCustomization(body: Uint8Array): void {
    const n = fromBinary(CMsgGCItemCustomizationNotificationSchema, body);
    // 1011 CasketTooFull, 1015 CasketInvFull: the only two that mean "the move cannot happen".
    if (n.request === 1011 || n.request === 1015) this.casketFull = n.request === 1011 ? "storage unit is full" : "inventory is full";
    if (n.request === 1013) this.casketAdded = n.itemId[0]?.toString() ?? null; // CasketAdded
    if (n.request === 1006) this.named = n.itemId[0]?.toString() ?? null; // NameItem
  }

  /**
   * The offer an active terminal is showing: an item inside the terminal, as in a storage unit. Loaded the way CS2's
   * terminal screen loads it (PerformItemCasketTransaction(0, terminal, terminal)); read only, no offer is taken or passed.
   */
  /** The casket-free form first (field 4 = offer counter, captured live 2026-10-27); CS2's casket form, which only works while Steam still holds the offer in memory, after 3 s. */
  async loadTerminalOffer(terminalId: string, timeoutMs: number, counter: number | null): Promise<{ items: DomainItem[]; loadedBy: "casket" | "counter" | null }> {
    const id = BigInt(terminalId);
    const deadline = Date.now() + timeoutMs;
    if (counter != null) {
      this.sendGc(GCMsg.VolatileItemLoadContents, Uint8Array.from([0x10, ...writeVarint(id), 0x20, ...writeVarint(counter)]));
      const items = await this.terminalContents(terminalId, Math.min(deadline, Date.now() + CASKET_FORM_MS));
      if (items.length) return { items, loadedBy: "counter" };
    }
    this.sendGc(GCMsg.VolatileItemLoadContents, toBinary(CMsgCasketItemSchema, create(CMsgCasketItemSchema, { casketItemId: id, itemItemId: id })));
    const items = await this.terminalContents(terminalId, deadline);
    return { items, loadedBy: items.length ? "casket" : null };
  }

  private async terminalContents(terminalId: string, until: number): Promise<DomainItem[]> {
    for (;;) {
      if (this.cm.connection.isClosed) throw new Error("Steam session ended during terminal read");
      const items = this._cache.casketContents(terminalId);
      if (items.length || Date.now() >= until) return items;
      await new Promise((r) => setTimeout(r, CASKET_POLL_MS));
    }
  }

  private nextJob = 1n;

  private sendGc(gcMsgId: number, body: Uint8Array, job = false): void {
    if (this.cm.connection.isClosed) throw new NoSessionError("Steam session ended before the request was sent");
    if (DEBUG()) console.error(`[gc] send ${gcMsgId} (${body.byteLength}b)`);
    this.cm.connection.sendMessage(EMsg.ClientToGC, wrapClientToGC(gcMsgId, body, job ? this.nextJob++ : undefined), { routingAppid: CS2_APPID });
  }

  /** Item actions and the dev probe tool send messages GCClient has no method for. */
  sendRaw(gcMsgId: number, body: Uint8Array, opts: { proto: boolean; job?: boolean }): void {
    if (opts.proto) { this.sendGc(gcMsgId, body, opts.job); return; }
    if (this.cm.connection.isClosed) throw new NoSessionError("Steam session ended before the request was sent");
    if (DEBUG()) console.error(`[gc] send ${gcMsgId} non-proto (${body.byteLength}b)`);
    this.cm.connection.sendMessage(EMsg.ClientToGC, wrapClientToGCNonProto(gcMsgId, body), { routingAppid: CS2_APPID });
  }

  /** Sees every GC message after GCClient has applied it; returns the remover. */
  onGcMessage(cb: (gcMsgType: number, body: Uint8Array) => void): () => void {
    this.observers.push(cb);
    return () => { this.observers = this.observers.filter((o) => o !== cb); };
  }

  /** `stall.reclaim` runs once if no welcome came within `stall.afterMs`: a GC that ignores hellos usually answers a fresh claim. */
  async waitForWelcome(timeoutMs: number, stall?: { afterMs: number; reclaim: () => Promise<void> }): Promise<void> {
    if (this.welcomed) return;
    await new Promise<void>((resolve, reject) => {
      let iv: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let removeClose: (() => void) | undefined;
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearInterval(iv);
        clearTimeout(timer);
        clearTimeout(stallTimer);
        removeClose?.();
        this.onWelcome = this.onWelcome.filter((cb) => cb !== done);
      };
      const done = () => { cleanup(); resolve(); };
      const fail = (err: Error) => { cleanup(); reject(err); };
      removeClose = this.cm.connection.onClose(() => fail(new Error("Steam session ended before GC welcome")));
      if (this.cm.connection.isClosed) return;
      const helloBody = toBinary(
        CMsgClientHelloSchema,
        create(CMsgClientHelloSchema, { version: this.opts?.clientVersion ?? CS2_CLIENT_VERSION, clientSessionNeed: 0, clientLauncher: 0, steamLauncher: 0 }),
      );
      const hello = () => {
        try { this.sendGc(GCMsg.ClientHello, helloBody); }
        catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
      };
      this.onWelcome.push(done);
      timer = setTimeout(() => fail(new Error("timeout waiting for GC welcome")), timeoutMs);
      if (stall) stallTimer = setTimeout(() => { stall.reclaim().then(() => { if (!settled) hello(); }, fail); }, stall.afterMs);
      iv = setInterval(hello, HELLO_REPEAT_MS);
      hello();
    });
  }

  async loadCasketContents(casketId: string, timeoutMs: number): Promise<DomainItem[]> {
    const body = toBinary(CMsgCasketItemSchema, create(CMsgCasketItemSchema, { casketItemId: BigInt(casketId) }));
    this.sendGc(GCMsg.CasketItemLoadContents, body);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.cm.connection.isClosed) throw new Error("Steam session ended during storage read");
      const expected = this._cache.get(casketId)?.containedItemCount ?? null;
      const items = this._cache.casketContents(casketId);
      if (expected !== null && items.length >= expected) return items;
      if (Date.now() >= deadline) throw new CasketLoadTimeout(items.length);
      await new Promise((r) => setTimeout(r, CASKET_POLL_MS));
    }
  }

  /** No-blind-retry primitive: has the intended transition already landed in the SO cache? */
  async reconcileAfter(intent: MutationIntent): Promise<"applied" | "not-applied"> {
    const item = this._cache.get(intent.itemId);
    // Absence only means "done" on a live cache; before welcome it is unknown, so default to not-applied.
    const live = this.welcomed;
    let applied: boolean;
    switch (intent.kind) {
      case "deposit": applied = !!item && item.casketId === intent.casketId; break;
      case "withdraw": applied = !!item && item.casketId === null; break; // absence or another unit does not prove it reached the inventory
      // A first naming re-creates the unit under a new id, so on a live cache a unit carrying the name stands in for the gone original.
      case "rename": applied = item ? item.customName === intent.expectedName : live && this.unitNamed(intent.expectedName); break;
      case "destroy": applied = !item && live; break;
      default: applied = !!this.itemApplied?.(this._cache, intent);
    }
    return applied ? "applied" : "not-applied";
  }

  private unitNamed(name: string): boolean {
    return this._cache.rootItems().some((i) => i.defIndex === STORAGE_UNIT_DEF && i.customName === name);
  }

  /** A first naming confirms on the re-created unit the NameItem notification names. */
  private namedAnew(intent: MutationIntent): boolean {
    return intent.kind === "rename" && this.named !== null && this.named !== intent.itemId && this._cache.get(this.named)?.customName === intent.expectedName;
  }

  /** A unit whose contents are not loaded takes the item out of the cache: Steam destroys it and names the unit in CasketAdded. */
  private depositedOutOfCache(intent: MutationIntent): boolean {
    return intent.kind === "deposit" && this.casketAdded === intent.casketId && !this._cache.get(intent.itemId);
  }

  /** Confirm a sent casket move landed in the SO cache (no blind retry). */
  private async confirmMutation(intent: MutationIntent, timeoutMs: number): Promise<void> {
    this.casketFull = null;
    this.casketAdded = null;
    this.named = null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.casketFull) { const m = this.casketFull; this.casketFull = null; throw new CasketFullError(m); }
      // Read before the cache: what it shows once the session has closed is final, and a change that arrived first stands.
      const closed = this.cm.connection.isClosed;
      if ((await this.reconcileAfter(intent)) === "applied" || this.depositedOutOfCache(intent) || this.namedAnew(intent)) return;
      if (closed || Date.now() >= deadline) throw new MutationTimeout(intent); // ambiguous: dropped, or no transition in time
      await new Promise((r) => setTimeout(r, CASKET_POLL_MS));
    }
  }

  async depositItem(itemId: string, casketId: string, timeoutMs: number): Promise<void> {
    const body = toBinary(CMsgCasketItemSchema, create(CMsgCasketItemSchema, { casketItemId: BigInt(casketId), itemItemId: BigInt(itemId) }));
    this.sendGc(GCMsg.CasketItemAdd, body);
    await this.confirmMutation({ kind: "deposit", itemId, casketId }, timeoutMs);
  }

  async withdrawItem(itemId: string, casketId: string, timeoutMs: number): Promise<void> {
    const body = toBinary(CMsgCasketItemSchema, create(CMsgCasketItemSchema, { casketItemId: BigInt(casketId), itemItemId: BigInt(itemId) }));
    this.sendGc(GCMsg.CasketItemExtract, body);
    await this.confirmMutation({ kind: "withdraw", itemId, casketId }, timeoutMs);
  }

  async renameItem(itemId: string, newName: string, timeoutMs: number): Promise<void> {
    // Since the CS2 update of 2026-10-08 the GC ignores the legacy raw NameItem body and takes
    // CMsgModifyItemStringAttr under the same id. tool_item_id 0 is a free storage unit rename;
    // attr_def stays unset, since with 111 (custom name) the GC does not answer.
    const body = toBinary(CMsgModifyItemStringAttrSchema, create(CMsgModifyItemStringAttrSchema, { toolItemId: 0n, subjectItemId: BigInt(itemId), attrValue: newName }));
    this.sendGc(GCMsg.NameItem, body);
    await this.confirmMutation({ kind: "rename", itemId, expectedName: newName }, timeoutMs);
  }
}
