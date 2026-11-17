import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { cancelPurchase, parseMicroTxnAuthRequest, PurchaseRefused } from "../src/gc/purchase.js";
import { CMsgGCStorePurchaseCancelResponseSchema, CMsgGCStorePurchaseCancelSchema } from "../src/gen/csgo/base_gcmessages_pb.js";
import { decodeFrame, encodeNonProtoFrame } from "../src/frames.js";

// CM 5504 body Steam sent for a Charm Detachment Pack (C$1.35 + C$0.07 tax), captured 2026-10-28; ids replaced.
const AUTH_REQUEST = "01004d6573736167654f626a65637400006c696e656974656d7300003000016465736372697074696f6e00436861726d204465746163686d656e74205061636b000767616d656974656d69640056130000000000000a616d6f756e74008700000000000000027175616e7469747900010000000808077472616e7369640001008a5d78456301076f72646572696400010014bbf08ac60202617070696400da0200000263757272656e637900140000000256415400000000000a746f74616c008e000000000000000a546178000700000000000000026c616e677561676500000000000273616e64626f7800000000000242696c6c696e6743757272656e637900140000000a42696c6c696e67546f74616c008e0000000000000002537465616d5265616c6d0001000000025265717569726573436163686564506d744d6574686f64000000000002526566756e6461626c6500010000000808004d6573736167654f626a656374000248617357616c6c657400010000000a6e416d6f756e7400a103000000000000026543757272656e6379436f646500140000000a6e416d6f756e7444656c61796564007017000000000000026543757272656e6379436f646544656c61796564001400000002537465616d5265616c6d00010000000808";
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe("parseMicroTxnAuthRequest", () => {
  it("reads the transaction, its line and the wallet from a captured request", () => {
    expect(parseMicroTxnAuthRequest(hex(AUTH_REQUEST))).toEqual({
      transId: "100000000000000001",
      currency: 20,
      total: 142,
      tax: 7,
      lines: [{ defIndex: 4950, description: "Charm Detachment Pack", amount: 135, quantity: 1 }],
      wallet: 929,
    });
  });

  it("rejects a body with no transaction", () => {
    expect(() => parseMicroTxnAuthRequest(new Uint8Array([1, 0]))).toThrow();
  });
});

describe("non-proto frames", () => {
  it("round-trips an ExtendedClientMsgHdr message", () => {
    const body = Uint8Array.from([0x01, 0x00, 0x8a, 0x5d, 0x78, 0x45, 0x63, 0x01, 1, 0, 0, 0]);
    const frame = encodeNonProtoFrame(5505, 76561198000000042n, 1234, body);
    expect(frame.length).toBe(36 + 12);
    expect(frame[23]).toBe(239);
    const d = decodeFrame(frame);
    expect(d).toMatchObject({ emsg: 5505, isProto: false });
    expect([...d.body]).toEqual([...body]);
  });
});

describe("cancelPurchase", () => {
  it("sends 2506 { txn_id } with a source job and resolves with the GC's 2507 result", async () => {
    const sent: Array<{ type: number; body: Uint8Array; job?: boolean }> = [];
    let handler: ((type: number, body: Uint8Array) => void) | null = null;
    const gc = {
      sendRaw: (type: number, body: Uint8Array, opts: { job?: boolean }) => sent.push({ type, body, job: opts.job }),
      onGcMessage: (cb: (type: number, body: Uint8Array) => void) => { handler = cb; return () => { handler = null; }; },
    };
    const p = cancelPurchase(gc as never, "2673900001", 1000);
    expect(sent[0]).toMatchObject({ type: 2506, job: true });
    expect(fromBinary(CMsgGCStorePurchaseCancelSchema, sent[0].body).txnId).toBe(2673900001n);
    handler!(2507, toBinary(CMsgGCStorePurchaseCancelResponseSchema, create(CMsgGCStorePurchaseCancelResponseSchema, { result: 1 })));
    await expect(p).resolves.toBe(1);
  });

  it("resolves null when the GC never answers", async () => {
    const gc = { sendRaw: () => {}, onGcMessage: () => () => {} };
    await expect(cancelPurchase(gc as never, "1", 10)).resolves.toBeNull();
  });
});

describe("PurchaseRefused", () => {
  it("names the transaction an init refusal carries", () => {
    expect(new PurchaseRefused("init", 200, "2673900001").message).toBe("Steam refused the purchase at init (result 200) txn 2673900001");
    expect(new PurchaseRefused("init", 200).message).toBe("Steam refused the purchase at init (result 200)");
  });
});
