// CS2's current build, which the GC wants in ClientHello. Used only when the live read fails.
export const FALLBACK_CS2_VERSION = 2000924;
const STEAM_INF_URL = "https://raw.githubusercontent.com/SteamTracking/GameTracking-CS2/master/game/csgo/steam.inf";

/** The live ClientVersion from steam.inf; throws when it cannot be read. */
export async function readClientVersion(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(STEAM_INF_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`version HTTP ${res.status}`);
  const match = /^ClientVersion=(\d+)\s*$/m.exec(await res.text());
  const version = Number(match?.[1]);
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error("invalid client version");
  return version;
}

/** The live ClientVersion, or FALLBACK_CS2_VERSION when it cannot be read. */
export async function fetchClientVersion(fetchImpl: typeof fetch = fetch): Promise<number> {
  try { return await readClientVersion(fetchImpl); }
  catch { return FALLBACK_CS2_VERSION; }
}
