import { describe, it, expect } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GCClient } from "../src/gc/client.js";
import { wrapClientToGC, parseClientFromGC } from "../src/gc/envelope.js";
import { CMsgGCCStrike15_v2_VolatileShopSubscribeSchema } from "../src/gen/csgo/cstrike15_gcmessages_pb.js";
import type { CMClient } from "../src/cm/client.js";
import { readShop, shopOffers, tokensLine } from "../src/gc/major-shop.js";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
// The Singapore 2026 souvenir container (def 5423) as the GC sent it, live 2026-11-18.
const SOUVENIRS = "4c5a4d419c000000600000005d000004000004011791003bae74a56ae25f8e4f5a359656b768b5fe0c6a0384483734dbfedba3468ff8653415007fb4ee429882d2401809b950de743a82bcd7c518a6336a8a2f6776618756410900a11af98e3eaf88b6e9d8071187b017612b968a6eacfc";

function offlineGc() {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const sent: Array<{ type: number; body: Uint8Array }> = [];
  const fakeCm = { connection: {
    addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; },
    get isClosed() { return false; },
    sendMessage: (_e: number, b: Uint8Array) => { const m = parseClientFromGC(b); sent.push({ type: m.gcMsgType, body: m.body }); },
  } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  const feed = (t: number, b: Uint8Array) => handlers.forEach((h) => h(wrapClientToGC(t, b)));
  return { gc, feed, sent };
}
const reply = (defidx: number, payload: string) => toBinary(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, create(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, { defidx, payload: hex(payload) }));

describe("shopOffers", () => {
  it("reads each offer's faux item id and token price (live 2026-11-18: the first two Singapore 2026 stickers, a foil and a gold)", () => {
    const list = hex("0804" + "121409b9049f2e000000f01096011800209601289601" + "121409b9048e30000000f010b817180020b81728b817");
    expect(shopOffers(list)).toEqual([
      { itemId: "17293822569884878009", defIndex: 1209, paintIndex: 11935, tokens: 150 },
      { itemId: "17293822569917318329", defIndex: 1209, paintIndex: 12430, tokens: 3000 },
    ]);
  });
});

describe("readShop", () => {
  it("subscribes to the container as CS2's VolatileShopSubscribe and unpacks its reply", async () => {
    const { gc, feed, sent } = offlineGc();
    const p = readShop(gc, 5423, 2000);
    expect(sent[0].type).toBe(9228);
    expect(fromBinary(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, sent[0].body).defidx).toBe(5423);
    feed(9228, reply(5416, SOUVENIRS));
    feed(9228, reply(5423, SOUVENIRS));
    const offers = await p;
    expect(offers.map((o) => o.tokens)).toEqual([300, 1250, 2500, 10000, 150, 5000, 625]);
    expect(offers[0]).toEqual({ itemId: "17293822569190655316", defIndex: 1364, paintIndex: 1342, tokens: 300 });
  });

  it("times out when the GC never answers for that container", async () => {
    const { gc, feed } = offlineGc();
    const p = readShop(gc, 5423, 30);
    feed(9228, reply(5416, SOUVENIRS));
    await expect(p).rejects.toThrow(/timeout/);
  });
});

describe("tokensLine", () => {
  it.each([
    [100, 135],
    [125, 169],
    [3000, 4050],
  ])("bills %i tokens as one line of %i cents with the count as supplemental data (live 2026-11-18, CAD at 135 per 100)", (tokens, costCents) => {
    expect(tokensLine(5409, tokens, 135)).toEqual({ defIndex: 5409, quantity: 1, costCents, supplemental: String(tokens) });
  });
});
