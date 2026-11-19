import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { valveLzmaDecode } from "../src/lzma.js";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
// Packed by Python's lzma (FORMAT_ALONE, lc 3, lp 0, pb 2) and rewrapped in Valve's header.
const BLOB = "4c5a4d41a60200002d0100005d00000100002194c242a24f468381859b2bc52d63e06f0a89c562822f4ce9f38be78e87cf30312eec29f94771af6f932a5d3c7670db91969c0189bf790c7c39ec432c8f74854ca5f62d2cd51bd1beb05786518fcb1434672d7916d787c0f4ab1cbbcb75366b9a77b7700b04765e9aaa94eb5188956c3c36a6b665b0a54dc6dc7a250003d1eef57bc94d11599dab161f0a944a1a5d363286353bed5ff6a17f12369c7d9b55ae3e7a8f470fbc0c9be253ce997a3ea9baf0c6a86b044f4157c4c00e200d9baa0a4ecf5a05f1efb9cf517045bc4830d56478ae75310a41626dae972fea43265d9ae3875f757aa2de36a7d15ac0900fc1dc451be9b7b823f35d5511c529e8f063d65ce84379ece6d916704138c8da648400a77fc0512db53f7dcc85b0bb9d994426d08f9e914d52fffff245d000";
const PLAIN = "4353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e204353324361702073746f72652070726963652073686565742e20000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff537469636b657220536c616220537469636b657220536c616220436861726d204465746163686d656e74205061636b20537469636b657220536c616220537469636b657220536c616220436861726d204465746163686d656e74205061636b20537469636b657220536c616220537469636b657220536c616220436861726d204465746163686d656e74205061636b20537469636b657220536c616220537469636b657220536c616220436861726d204465746163686d656e74205061636b20537469636b657220536c616220537469636b657220536c616220436861726d204465746163686d656e74205061636b20";
// The GC price sheet captured 2026-10-28 (2501 price_sheet); local only, like every recording.
const REAL = "test/fixtures/price-sheet.lzma";

describe("valveLzmaDecode", () => {
  it("unpacks what Python's reference encoder packed", () => {
    expect(Buffer.from(valveLzmaDecode(hex(BLOB))).toString("hex")).toBe(PLAIN);
  });

  it("rejects a blob without Valve's header", () => {
    expect(() => valveLzmaDecode(hex(BLOB).subarray(4))).toThrow();
  });

  it.skipIf(!existsSync(REAL))("unpacks the real price sheet byte for byte", () => {
    const out = valveLzmaDecode(new Uint8Array(readFileSync(REAL)));
    expect(out.length).toBe(117310);
    expect(createHash("sha256").update(out).digest("hex")).toBe("c56ded815d2fb191757213a52448b2351fe104e9cd1433eb5c27b21b219c143e");
  });
});

describe("storeEntries", () => {
  it.skipIf(!existsSync(REAL))("prices the real sheet in CAD", async () => {
    const { readBinaryKv } = await import("../src/kv.js");
    const { storeEntries } = await import("../src/gc/store.js");
    const entries = storeEntries(readBinaryKv(valveLzmaDecode(new Uint8Array(readFileSync(REAL)))).kv, "CAD");
    expect(entries.find((e) => e.itemLink === "sticker_display_case")?.priceCents).toBe(65);
    expect(entries.find((e) => e.name === "Name Tag")?.priceCents).toBe(269);
    expect(entries.length).toBeGreaterThan(200);
  });

  it("prices a discounted entry at its sale price, the one Steam bills (live 2026-11-18: a pass pack at 2449, refused at its 2599 list price)", async () => {
    const { storeEntries } = await import("../src/gc/store.js");
    const sheet = { store: { entries: {
      pack: { item_link: "pack", category_tags: "Misc", prices: { CAD: 2599 }, sale_prices: { CAD: 2449 } },
      pass: { item_link: "pass", category_tags: "Misc", prices: { CAD: 1369 } },
    } } };
    expect(storeEntries(sheet, "CAD")).toEqual([
      { name: "pack", itemLink: "pack", category: "Misc", priceCents: 2449, listPriceCents: 2599 },
      { name: "pass", itemLink: "pass", category: "Misc", priceCents: 1369 },
    ]);
  });

  it("reads USD prices, which the sheet stores as 64-bit integers (live 2026-11-18)", async () => {
    const { storeEntries } = await import("../src/gc/store.js");
    const sheet = { store: { entries: { pack: { item_link: "pack", category_tags: "Misc", prices: { USD: 1899n }, sale_prices: { USD: 1799n } } } } };
    expect(storeEntries(sheet, "USD")).toEqual([{ name: "pack", itemLink: "pack", category: "Misc", priceCents: 1799, listPriceCents: 1899 }]);
  });
});

describe("sheetRate", () => {
  it("reads the 64-bit currency units decoded from Steam's price sheet", async () => {
    const { sheetRate } = await import("../src/gc/store.js");
    expect(sheetRate({ store: { currencies: { USD: 88888n, CAD: 126977n } } }, "CAD")).toEqual({ usd: 88888, local: 126977 });
  });

  it.skipIf(!existsSync(REAL))("reads the rate from the captured price sheet", async () => {
    const { readBinaryKv } = await import("../src/kv.js");
    const { sheetRate } = await import("../src/gc/store.js");
    const { kv } = readBinaryKv(valveLzmaDecode(new Uint8Array(readFileSync(REAL))));
    expect(sheetRate(kv, "CAD")).toEqual({ usd: 88888, local: 126977 });
  });

  // Terminal offers are priced in US cents; the GC bills ceil(usd × local / usd units) and refuses one cent less (live 2026-10-28: 26 → 38, not 37).
  it("reads the wallet currency's units against USD from the sheet's currency table", async () => {
    const { sheetRate } = await import("../src/gc/store.js");
    expect(sheetRate({ store: { currencies: { USD: 88888, CAD: 126977 } } }, "CAD")).toEqual({ usd: 88888, local: 126977 });
    expect(sheetRate({ store: { currencies: { USD: 88888 } } }, "CAD")).toBeNull();
    expect(sheetRate({ store: {} }, "CAD")).toBeNull();
  });
});
