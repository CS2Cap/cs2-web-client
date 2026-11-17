// Browser-safe QR login (IAuthenticationService). No Node deps; fetch is injectable for tests.
const API = "https://api.steampowered.com/IAuthenticationService";
// platform_type=1 (SteamClient) with a plain form body is accepted by Steam (confirmed live 2026-10-05) and
// the refresh token logs on to the CM directly. If Steam later needs input_protobuf_encoded, change the body here only.
const PLATFORM_TYPE_STEAM_CLIENT = 1;

export interface QrChallenge { clientId: string; requestId: string; challengeUrl: string; interval: number }
export interface QrResult { steamId: string; accountName: string; refreshToken: string }

async function call(method: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, any>> {
  const res = await fetchImpl(`${API}/${method}/v1/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = (await res.json()) as { response?: Record<string, any> };
  return json.response ?? {};
}

/** `deviceName` is what Steam Mobile shows in the approval prompt and the account's authorized devices. */
export async function beginQr(fetchImpl: typeof fetch = fetch, deviceName = "cs2-web-client"): Promise<QrChallenge> {
  const r = await call("BeginAuthSessionViaQR", {
    device_friendly_name: deviceName,
    platform_type: String(PLATFORM_TYPE_STEAM_CLIENT),
  }, fetchImpl);
  return {
    clientId: String(r.client_id),
    requestId: String(r.request_id),
    challengeUrl: String(r.challenge_url),
    interval: Math.max(1, Number(r.interval) || 5),
  };
}

/** SteamID64 from the refresh-token JWT `sub` claim. */
export function steamIdFromJwt(jwt: string): string {
  const seg = jwt.split(".")[1];
  if (!seg) throw new Error("malformed refresh token");
  let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as { sub?: string };
  if (!payload.sub || !/^\d{17}$/.test(payload.sub)) throw new Error("refresh token has no valid sub claim");
  return payload.sub;
}

export type PollOutcome =
  | { status: "pending" }
  | { status: "done"; result: QrResult }
  | { status: "refresh"; challenge: QrChallenge };

/** Steam rotates the QR during polling (new_client_id/new_challenge_url): "refresh" carries the updated challenge. */
export async function pollQr(ch: QrChallenge, fetchImpl: typeof fetch = fetch): Promise<PollOutcome> {
  const r = await call("PollAuthSessionStatus", { client_id: ch.clientId, request_id: ch.requestId }, fetchImpl);
  if (r.refresh_token) {
    const refreshToken = String(r.refresh_token);
    return { status: "done", result: { steamId: steamIdFromJwt(refreshToken), accountName: String(r.account_name ?? ""), refreshToken } };
  }
  if (r.new_client_id && r.new_challenge_url) {
    return {
      status: "refresh",
      challenge: {
        clientId: String(r.new_client_id),
        requestId: r.request_id ? String(r.request_id) : ch.requestId,
        challengeUrl: String(r.new_challenge_url),
        interval: r.interval ? Math.max(1, Number(r.interval) || ch.interval) : ch.interval,
      },
    };
  }
  return { status: "pending" };
}
