// Dev-only QR login as the Steam *client* (IAuthenticationService over HTTPS). Not shipped.
// Reference implementation: the exact platform_type / website_id and the claim that a bare refresh
// token logs on directly via CMsgClientLogon.access_token (spec §3) are VALIDATED by the user's live run.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import qrcode from "qrcode-terminal";

const API = "https://api.steampowered.com/IAuthenticationService";
// EAuthTokenPlatformType_SteamClient: yields a CLIENT-audience refresh token usable for CM logon.
const PLATFORM_TYPE_STEAM_CLIENT = 1;
const REPO_ROOT = resolve(import.meta.dirname, "..");
const SAVE_ROOT = resolve(REPO_ROOT, ".local"); // gitignored

export interface QrLogin { steamId: bigint; accountName: string; refreshToken: string }

export function requireDev(): void {
  if (process.env.CS2_WEB_CLIENT_LIVE !== "1") {
    console.error("This is a live Steam tool. Set CS2_WEB_CLIENT_LIVE=1 to run live.");
    process.exit(0);
  }
}

async function call(method: string, form: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(`${API}/${method}/v1/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = (await res.json()) as { response?: Record<string, any> };
  return json.response ?? {};
}

/** SteamID64 from the refresh token JWT `sub` claim (middle segment, base64url JSON). */
export function steamIdFromJwt(token: string): bigint {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub?: string };
  if (!payload.sub) throw new Error("refresh token has no sub claim");
  return BigInt(payload.sub);
}

export function assertGitignoredPath(path: string): string {
  const abs = resolve(path);
  const rel = relative(SAVE_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    throw new Error(`refusing to save outside gitignored ${SAVE_ROOT}: ${abs}`);
  }
  return abs;
}

export async function qrLogin(opts: { saveTokenPath?: string } = {}): Promise<QrLogin> {
  requireDev();
  // Validate the save path up front so a bad flag fails before the user scans.
  const savePath = opts.saveTokenPath ? assertGitignoredPath(opts.saveTokenPath) : undefined;

  const begin = await call("BeginAuthSessionViaQR", {
    device_friendly_name: "dev-harness",
    platform_type: String(PLATFORM_TYPE_STEAM_CLIENT),
  });
  let clientId = String(begin.client_id);
  const requestId = String(begin.request_id); // base64 bytes, passed back verbatim
  const intervalMs = Math.max(1, Number(begin.interval) || 5) * 1000;

  const show = (url: string) => {
    qrcode.generate(url, { small: true });
    console.log(`QR challenge URL: ${url}`);
  };
  show(String(begin.challenge_url));

  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await call("PollAuthSessionStatus", { client_id: clientId, request_id: requestId });
    if (poll.new_client_id) clientId = String(poll.new_client_id);
    if (poll.new_challenge_url) show(String(poll.new_challenge_url));
    if (poll.refresh_token) {
      const refreshToken = String(poll.refresh_token);
      const result: QrLogin = {
        steamId: steamIdFromJwt(refreshToken),
        accountName: String(poll.account_name ?? ""),
        refreshToken,
      };
      if (savePath) {
        mkdirSync(dirname(savePath), { recursive: true });
        writeFileSync(savePath, JSON.stringify({ ...result, steamId: result.steamId.toString() }), { mode: 0o600 });
        console.log(`token saved to ${savePath}`);
      }
      return result;
    }
  }
}
