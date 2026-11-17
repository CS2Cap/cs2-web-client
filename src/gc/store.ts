import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMsgStoreGetUserDataResponseSchema, CMsgStoreGetUserDataSchema } from "../gen/csgo/base_gcmessages_pb.js";
import { readBinaryKv, type KV } from "../kv.js";
import { valveLzmaDecode } from "../lzma.js";
import type { GCClient } from "./client.js";

const GC_STORE_GET_USER_DATA = 2500;
const GC_STORE_GET_USER_DATA_RESPONSE = 2501;

/** Steam's ECurrencyCode, as the price sheet keys its prices. */
const CURRENCIES: Record<number, string> = {
  1: "USD", 2: "GBP", 3: "EUR", 4: "CHF", 5: "RUB", 6: "PLN", 7: "BRL", 8: "JPY", 9: "NOK", 10: "IDR", 11: "MYR", 12: "PHP",
  13: "SGD", 14: "THB", 15: "VND", 16: "KRW", 17: "TRY", 18: "UAH", 19: "MXN", 20: "CAD", 21: "AUD", 22: "NZD", 23: "CNY",
  24: "INR", 25: "CLP", 26: "PEN", 27: "COP", 28: "ZAR", 29: "HKD", 30: "TWD", 31: "SAR", 32: "AED", 34: "ARS", 35: "ILS",
  37: "KZT", 38: "KWD", 39: "QAR", 40: "CRC", 41: "UYU",
};

/** One thing CS2's store sells, priced in the wallet's currency (cents). `itemLink` is its items_game name. */
export interface StoreEntry { name: string; itemLink: string; category: string; priceCents: number }
/** The sheet's currency table: `local` units of the wallet currency to `usd` units. Terminal offers (US cents) bill ceil(usd × local / usd) (live 2026-10-28). */
export interface SheetRate { usd: number; local: number }
export interface StoreSheet { currency: number; currencyCode: string; version: number; entries: StoreEntry[]; usdRate: SheetRate | null }

export function sheetRate(sheet: KV, currencyCode: string): SheetRate | null {
  const table = ((sheet.store as KV | undefined)?.currencies ?? {}) as KV;
  // Steam stores currency units as 64-bit integers in the binary price sheet.
  const usd = typeof table.USD === "bigint" ? Number(table.USD) : table.USD;
  const value = table[currencyCode];
  const local = typeof value === "bigint" ? Number(value) : value;
  return typeof usd === "number" && typeof local === "number" && usd > 0 && local > 0 ? { usd, local } : null;
}

/** The store's entries priced in `currency`, from the decoded price sheet; entries with no price there are left out. */
export function storeEntries(sheet: KV, currencyCode: string): StoreEntry[] {
  const entries = ((sheet.store as KV | undefined)?.entries ?? {}) as KV;
  return Object.entries(entries).flatMap(([name, raw]) => {
    const e = raw as KV;
    const price = (e.prices as KV | undefined)?.[currencyCode];
    if (typeof price !== "number") return [];
    return [{ name, itemLink: String(e.item_link ?? name), category: String(e.category_tags ?? ""), priceCents: price }];
  });
}

/** Asks the GC for the store, as CS2's store screen does (2500 → 2501), and prices it in the wallet's currency. */
export async function readStore(gc: GCClient, currency: number, timeoutMs: number): Promise<StoreSheet> {
  const currencyCode = CURRENCIES[currency];
  if (!currencyCode) throw new Error(`unknown wallet currency ${currency}`);
  const body = await new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("timeout waiting for the store")); }, timeoutMs);
    const off = gc.onGcMessage((type, b) => {
      if (type !== GC_STORE_GET_USER_DATA_RESPONSE) return;
      clearTimeout(timer);
      off();
      resolve(b);
    });
    gc.sendRaw(GC_STORE_GET_USER_DATA, toBinary(CMsgStoreGetUserDataSchema, create(CMsgStoreGetUserDataSchema, { currency })), { proto: true, job: true });
  });
  const r = fromBinary(CMsgStoreGetUserDataResponseSchema, body);
  if (r.result !== 1 || !r.priceSheet?.length) throw new Error(`the store answered ${r.result}`);
  const { kv } = readBinaryKv(valveLzmaDecode(r.priceSheet));
  return { currency, currencyCode, version: r.priceSheetVersion, entries: storeEntries(kv, currencyCode), usdRate: sheetRate(kv, currencyCode) };
}
