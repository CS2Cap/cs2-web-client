import { fromBinary } from "@bufbuild/protobuf";
import { CMsgMultiSchema } from "./gen/steam/steammessages_base_pb.js";
import { PROTO_MASK } from "./emsg.js";
export { EMsg } from "./emsg.js";

const EXTENDED_HEADER = 36;

/** ExtendedClientMsgHdr: emsg, header size 36, version 2, target and source job "none", canary 239, SteamID, session id. */
export function encodeNonProtoFrame(emsg: number, steamId: bigint, sessionId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(EXTENDED_HEADER + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, emsg >>> 0, true);
  dv.setUint8(4, EXTENDED_HEADER);
  dv.setUint16(5, 2, true);
  dv.setBigUint64(7, 0xffffffffffffffffn, true);
  dv.setBigUint64(15, 0xffffffffffffffffn, true);
  dv.setUint8(23, 239);
  dv.setBigUint64(24, steamId, true);
  dv.setInt32(32, sessionId, true);
  out.set(body, EXTENDED_HEADER);
  return out;
}

export function encodeFrame(emsg: number, header: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + header.length + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, (emsg | PROTO_MASK) >>> 0, true);
  dv.setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(body, 8 + header.length);
  return out;
}

export function decodeFrame(buf: Uint8Array): {
  emsg: number;
  isProto: boolean;
  header: Uint8Array;
  body: Uint8Array;
} {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const raw = dv.getUint32(0, true);
  const isProto = (raw & PROTO_MASK) !== 0;
  const emsg = (raw & ~PROTO_MASK) >>> 0;
  // Non-proto CM messages (micro-transactions) carry a fixed 36-byte ExtendedClientMsgHdr.
  if (!isProto && emsg !== 1) return { emsg, isProto, header: buf.slice(4, EXTENDED_HEADER), body: buf.slice(EXTENDED_HEADER) };
  const headerLen = dv.getUint32(4, true);
  return { emsg, isProto, header: buf.slice(8, 8 + headerLen), body: buf.slice(8 + headerLen) };
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

export async function unpackMulti(body: Uint8Array): Promise<Uint8Array[]> {
  const multi = fromBinary(CMsgMultiSchema, body);
  let payload = multi.messageBody ?? new Uint8Array(0);
  if (multi.sizeUnzipped > 0) payload = await gunzip(payload);
  const parts: Uint8Array[] = [];
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let i = 0;
  while (i + 4 <= payload.length) {
    const len = dv.getUint32(i, true);
    i += 4;
    if (i + len > payload.length) break;
    parts.push(payload.slice(i, i + len));
    i += len;
  }
  return parts;
}
