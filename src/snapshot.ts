import type { DomainItem } from "./types.js";
import type { GCClient } from "./gc/client.js";
import type { CarePackage, RawCapture } from "./gc/so-cache.js";
import { CasketLoadTimeout } from "./gc/client.js";
import { loadAttributeIds } from "./items/attributes.js";

const ATTRS = loadAttributeIds(null);

/** A unit's item count and modification date; the date moves on every add, remove and rename (live 2026-10-13). */
export interface UnitStamp { count: number; modified: number }

export function unitStamp(unit: DomainItem): UnitStamp | null {
  const raw = unit.unknownAttributes.find((a) => a.defindex === ATTRS.casketModifiedAt)?.rawValue;
  if (unit.containedItemCount === null || !raw || raw.length < 4) return null;
  return { count: unit.containedItemCount, modified: new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, true) };
}

export interface AccountSnapshot {
  steamId: string;
  snapshotId: string;
  capturedAt: string;
  complete: boolean;
  items: DomainItem[];
  /** Non-economy root items, apart from `items`; the holdings sync and item actions read both. */
  nonEconomy?: DomainItem[];
  /** Units left unread because `known` matched their stamp; the caller supplies their stored contents. */
  reused?: string[];
  stamps?: Record<string, UnitStamp>;
  /** Undecoded objects and messages, for item actions to study; never uploaded. */
  raw?: RawCapture[];
  /** Armory stars the account can spend; null before Steam sends the shop object. */
  armoryStars?: number | null;
  armoryTracks?: number[];
  /** The weekly care package; never uploaded. */
  carePackage?: CarePackage | null;
}

export async function buildSnapshot(
  gc: GCClient,
  opts: { steamId: bigint; loadTimeoutMs: number; known?: Record<string, UnitStamp> },
): Promise<AccountSnapshot> {
  const roots = gc.cache.rootItems();
  const items: DomainItem[] = [...roots];
  const reused: string[] = [];
  const stamps: Record<string, UnitStamp> = {};
  let complete = true;
  for (const unit of roots) {
    if (unit.containedItemCount === null) continue;
    const stamp = unitStamp(unit);
    if (stamp) stamps[unit.gcItemId] = stamp;
    const known = opts.known?.[unit.gcItemId];
    if (stamp && known && known.count === stamp.count && known.modified === stamp.modified) {
      reused.push(unit.gcItemId);
      continue;
    }
    try {
      items.push(...(await gc.loadCasketContents(unit.gcItemId, opts.loadTimeoutMs)));
    } catch (e) {
      if (!(e instanceof CasketLoadTimeout)) throw e;
      complete = false;
      items.push(...gc.cache.casketContents(unit.gcItemId));
    }
  }
  // An undecodable object was dropped from the cache; never claim this snapshot is complete.
  if (gc.cache.decodeFailures > 0) complete = false;
  return {
    steamId: opts.steamId.toString(),
    snapshotId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    complete,
    items,
    nonEconomy: gc.cache.nonEconomyItems(),
    reused,
    stamps,
    raw: gc.cache.raw,
    armoryStars: gc.cache.armoryStars,
    armoryTracks: gc.cache.armoryTracks,
    carePackage: gc.cache.carePackage(),
  };
}
