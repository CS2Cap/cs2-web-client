import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  CMsgGCStorePurchaseCancelResponseSchema,
  CMsgGCStorePurchaseCancelSchema,
  CMsgGCStorePurchaseFinalizeResponseSchema,
  CMsgGCStorePurchaseFinalizeSchema,
  CMsgGCStorePurchaseInitResponseSchema,
  CMsgGCStorePurchaseInitSchema,
} from "../gen/csgo/base_gcmessages_pb.js";
import type { CMClient } from "../cm/client.js";
import type { GCClient } from "./client.js";
import { readBinaryKv, type KV } from "../kv.js";

// Store purchases as CS2 makes them (captured live 2026-10-28).
const GC_PURCHASE_INIT = 2510;
const GC_PURCHASE_INIT_RESPONSE = 2511;
const GC_PURCHASE_FINALIZE = 2504;
const GC_PURCHASE_FINALIZE_RESPONSE = 2505;
const GC_PURCHASE_CANCEL = 2506;
const GC_PURCHASE_CANCEL_RESPONSE = 2507;
const CM_MICROTXN_AUTH_REQUEST = 5504;
const CM_MICROTXN_AUTHORIZE = 5505;
const CM_MICROTXN_AUTHORIZE_RESPONSE = 5506;

export type MicroTxn = {
  /** Steam's payment id: names the transaction on the checkout page and in the client's authorization (5505). */
  transId: string;
  /** The GC's own id for the purchase (2511 `txn_id`): what finalize names. */
  gcTxnId?: string;
  currency: number;
  /** Cents in the wallet currency, tax included. */
  total: number;
  tax: number;
  lines: Array<{ defIndex: number; description: string; amount: number; quantity: number }>;
  /** Spendable wallet balance in cents; null when Steam sent none. */
  wallet: number | null;
};

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0);

/** CM 5504: a lead byte, then the transaction and the wallet as two binary KeyValues "MessageObject"s. */
export function parseMicroTxnAuthRequest(body: Uint8Array): MicroTxn {
  const objects: KV[] = [];
  let i = 0;
  for (;;) {
    const start = indexOfObject(body, i);
    if (start < 0) break;
    const { kv, end } = readBinaryKv(body, start);
    objects.push(kv);
    i = end;
  }
  const txn = objects[0]?.MessageObject as KV | undefined;
  if (!txn || txn.transid === undefined) throw new Error("no transaction in the authorization request");
  const wallet = objects[1]?.MessageObject as KV | undefined;
  const lineItems = (txn.lineitems ?? {}) as KV;
  return {
    transId: BigInt(txn.transid as bigint).toString(),
    currency: num(txn.currency),
    total: num(txn.total),
    tax: num(txn.Tax),
    lines: Object.values(lineItems).map((l) => {
      const line = l as KV;
      return { defIndex: num(line.gameitemid), description: String(line.description ?? ""), amount: num(line.amount), quantity: num(line.quantity) };
    }),
    wallet: wallet && num(wallet.HasWallet) ? num(wallet.nAmount) : null,
  };
}

const MARKER = new TextEncoder().encode("\x00MessageObject\x00");
function indexOfObject(buf: Uint8Array, from: number): number {
  outer: for (let i = from; i + MARKER.length <= buf.length; i++) {
    for (let j = 0; j < MARKER.length; j++) if (buf[i + j] !== MARKER[j]) continue outer;
    return i;
  }
  return -1;
}

/** `txnId`: the GC transaction an init refusal names, when it names one. */
export class PurchaseRefused extends Error {
  constructor(public step: "init" | "authorize" | "finalize", public result: number, public txnId?: string) {
    super(`Steam refused the purchase at ${step} (result ${result})${txnId ? ` txn ${txnId}` : ""}`);
    this.name = "PurchaseRefused";
  }
}

export type PurchaseLine = { defIndex: number; quantity: number; costCents: number; supplemental?: string };

/** Asks the GC to sell `lines` (2510); resolves with the transaction Steam asks this client to authorize (5504). */
export async function startPurchase(cm: CMClient, gc: GCClient, lines: PurchaseLine[], currency: number, timeoutMs: number): Promise<MicroTxn> {
  const conn = cm.connection;
  const auth = conn.waitFor(CM_MICROTXN_AUTH_REQUEST, timeoutMs);
  let gcTxnId: string | undefined;
  const refused = new Promise<never>((_, reject) => {
    const off = gc.onGcMessage((type, body) => {
      if (type !== GC_PURCHASE_INIT_RESPONSE) return;
      off();
      const r = fromBinary(CMsgGCStorePurchaseInitResponseSchema, body);
      if (r.result !== 1) reject(new PurchaseRefused("init", r.result, r.txnId > 0n ? r.txnId.toString() : undefined));
      else gcTxnId = r.txnId.toString();
    });
    // Steam's request often arrives first: keep listening for the GC's id a little longer.
    auth.then(() => setTimeout(off, 5000), off);
  });
  gc.sendRaw(GC_PURCHASE_INIT, toBinary(CMsgGCStorePurchaseInitSchema, create(CMsgGCStorePurchaseInitSchema, {
    currency,
    lineItems: lines.map((l) => ({
      itemDefId: l.defIndex,
      quantity: l.quantity,
      costInLocalCurrency: BigInt(l.costCents),
      ...(l.supplemental ? { supplementalData: BigInt(l.supplemental) } : {}),
    })),
  })), { proto: true, job: true });
  const txn = parseMicroTxnAuthRequest(await Promise.race([auth, refused]));
  // Steam's request can beat the GC's reply by a few milliseconds.
  for (let i = 0; gcTxnId === undefined && i < 200; i++) await new Promise((r) => setTimeout(r, 20));
  if (gcTxnId === undefined) throw new Error("the GC did not name the transaction");
  return { ...txn, gcTxnId };
}

/** Authorizes (or declines) the transaction as the Steam client does (5505: u64 transid, u32 approve); resolves with Steam's result. */
export async function authorizePurchase(cm: CMClient, transId: string, approve: boolean, timeoutMs: number): Promise<number> {
  const body = new Uint8Array(12);
  const dv = new DataView(body.buffer);
  dv.setBigUint64(0, BigInt(transId), true);
  dv.setUint32(8, approve ? 1 : 0, true);
  const reply = cm.connection.waitFor(CM_MICROTXN_AUTHORIZE_RESPONSE, timeoutMs);
  cm.connection.sendNonProto(CM_MICROTXN_AUTHORIZE, body);
  const r = await reply;
  return new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(0, true);
}

/** Tells the GC to complete an authorized transaction (2504, named by the GC's own id); resolves with the ids of the items it created. */
export async function finalizePurchase(gc: GCClient, gcTxnId: string, timeoutMs: number): Promise<string[]> {
  const reply = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("timeout waiting for the purchase to finish")); }, timeoutMs);
    const off = gc.onGcMessage((type, body) => {
      if (type !== GC_PURCHASE_FINALIZE_RESPONSE) return;
      clearTimeout(timer);
      off();
      const r = fromBinary(CMsgGCStorePurchaseFinalizeResponseSchema, body);
      if (r.result !== 1) reject(new PurchaseRefused("finalize", r.result));
      else resolve(r.itemIds.map(String));
    });
  });
  gc.sendRaw(GC_PURCHASE_FINALIZE, toBinary(CMsgGCStorePurchaseFinalizeSchema, create(CMsgGCStorePurchaseFinalizeSchema, { txnId: BigInt(gcTxnId) })), { proto: true, job: true });
  return reply;
}

/** Tells the GC a transaction is off (2506), as Steam's own clients do when its payment is declined; resolves with the GC's result, null unanswered. */
export async function cancelPurchase(gc: GCClient, gcTxnId: string, timeoutMs: number): Promise<number | null> {
  const reply = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    const off = gc.onGcMessage((type, body) => {
      if (type !== GC_PURCHASE_CANCEL_RESPONSE) return;
      clearTimeout(timer);
      off();
      resolve(fromBinary(CMsgGCStorePurchaseCancelResponseSchema, body).result);
    });
  });
  gc.sendRaw(GC_PURCHASE_CANCEL, toBinary(CMsgGCStorePurchaseCancelSchema, create(CMsgGCStorePurchaseCancelSchema, { txnId: BigInt(gcTxnId) })), { proto: true, job: true });
  return reply;
}
