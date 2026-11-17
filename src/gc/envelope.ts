import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMsgGCClientSchema } from "../gen/steam/steammessages_clientserver_2_pb.js";
import { CMsgProtoBufHeaderSchema } from "../gen/steam/steammessages_base_pb.js";
import { encodeFrame, decodeFrame } from "../frames.js";
import { PROTO_MASK } from "../emsg.js";

const CS2_APPID = 730;
// GC proto header carries only jobid_source = "no job" sentinel. Verified byte-identical to the
// working client's frames (prototype WASM output, 2026-10-05).
const NO_JOB = 0xffffffffffffffffn;

/**
 * GC framing shared by GCClient and the fake CM server.
 *
 * A proto GC message rides inside CMsgGCClient as: msgtype carries the GC id with the
 * 0x80000000 proto flag set, and payload is itself a frame
 * [gcMsgId|0x80000000][headerLen][CMsgProtoBufHeader{jobid_source}][gcBody] — the same layout as
 * a CM frame. This matches what real CS2 GC sends and accepts (verified live 2026-10-05).
 * parseClientFromGC unwraps both layers and returns the clean GC id + inner body; it ignores the
 * inner header, so it is robust to whatever routing fields Steam fills in.
 */
/** `sourceJob` names a reply the sender waits for; some GC requests (store purchases) are only answered when it is set. */
export function wrapClientToGC(gcMsgType: number, body: Uint8Array, sourceJob: bigint = NO_JOB): Uint8Array {
  const header = toBinary(CMsgProtoBufHeaderSchema, create(CMsgProtoBufHeaderSchema, { jobidSource: sourceJob }));
  const payload = encodeFrame(gcMsgType, header, body);
  return toBinary(
    CMsgGCClientSchema,
    create(CMsgGCClientSchema, { appid: CS2_APPID, msgtype: (gcMsgType | PROTO_MASK) >>> 0, payload }),
  );
}

// Non-proto GC messages (craft, legacy crate unlock) start with GCMsgHdr: uint16 version 1, uint64 target job, uint64 source job.
const NON_PROTO_HEADER = 18;

export function wrapClientToGCNonProto(gcMsgType: number, body: Uint8Array): Uint8Array {
  const payload = new Uint8Array(NON_PROTO_HEADER + body.byteLength);
  const v = new DataView(payload.buffer);
  v.setUint16(0, 1, true);
  v.setBigUint64(2, NO_JOB, true);
  v.setBigUint64(10, NO_JOB, true);
  payload.set(body, NON_PROTO_HEADER);
  return toBinary(CMsgGCClientSchema, create(CMsgGCClientSchema, { appid: CS2_APPID, msgtype: gcMsgType >>> 0, payload }));
}

export function parseClientFromGC(cmBody: Uint8Array): { gcMsgType: number; body: Uint8Array } {
  const m = fromBinary(CMsgGCClientSchema, cmBody);
  // Proto GC message: payload is a nested frame. Non-proto: payload is GCMsgHdr + body.
  if ((m.msgtype & PROTO_MASK) !== 0 && m.payload.byteLength >= 8) {
    const inner = decodeFrame(m.payload);
    return { gcMsgType: inner.emsg, body: inner.body };
  }
  return { gcMsgType: (m.msgtype & ~PROTO_MASK) >>> 0, body: m.payload.subarray(Math.min(NON_PROTO_HEADER, m.payload.byteLength)) };
}
