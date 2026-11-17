import { CasketLoadTimeout } from "../gc/client.js";
import type { DomainItem } from "../types.js";
import type { CarePackage } from "../gc/so-cache.js";

function item(gcItemId: string, casketId: string | null, containedItemCount: number | null): DomainItem {
  return {
    steamAssetId: gcItemId, gcItemId, defIndex: 1, quality: null, rarity: null,
    flags: 0, origin: null, customName: "", casketId, containedItemCount,
    paintIndex: null, paintSeed: null, paintWear: null,
    isStatTrak: false, isSouvenir: false, killEaterValue: null,
    stickers: [], charms: [], musicKitId: null, tradableAfter: null, unknownAttributes: [],
  };
}

export class FakeGC {
  private roots: DomainItem[] = [];
  private contents = new Map<string, DomainItem[]>();
  private timeouts = new Set<string>();
  private loaded = new Set<string>();

  loadedUnits(): string[] { return [...this.loaded]; }

  static with(o: { root: number; units: Record<string, number>; timeouts: string[]; modified?: Record<string, number> }): FakeGC {
    const gc = new FakeGC();
    for (let i = 0; i < o.root; i++) gc.roots.push(item(`r${i}`, null, null));
    for (const [id, n] of Object.entries(o.units)) {
      const unit = item(id, null, n);
      const at = o.modified?.[id];
      if (at !== undefined) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, at, true); unit.unknownAttributes.push({ defindex: 271, rawValue: b }); }
      gc.roots.push(unit);
      gc.contents.set(id, Array.from({ length: n }, (_, i) => item(`${id}-${i}`, id, null)));
    }
    gc.timeouts = new Set(o.timeouts);
    return gc;
  }

  nonEconomy: DomainItem[] = [];

  cache = {
    rootItems: () => this.roots,
    nonEconomyItems: () => this.nonEconomy,
    casketContents: (id: string) => (this.loaded.has(id) ? this.contents.get(id) ?? [] : []),
    decodeFailures: 0,
    armoryStars: null as number | null,
    armoryTracks: [] as number[],
    carePackage: (): CarePackage | null => null,
  };

  async loadCasketContents(id: string, _timeoutMs: number): Promise<DomainItem[]> {
    if (this.timeouts.has(id)) throw new CasketLoadTimeout(0);
    this.loaded.add(id);
    return this.contents.get(id) ?? [];
  }
}
