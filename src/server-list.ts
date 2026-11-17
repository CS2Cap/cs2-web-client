// Steam's websocket connection servers. The list changes rarely, so a cold connect never depends on one request.
const SERVER_LIST_URL = "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0&cmtype=websockets";
const KEY = "cm_server_list";
// A list older than this is not trusted as a fallback.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPTS = 3;
const RETRY_MS = 300;

export interface ServerListDeps {
  fetch: typeof fetch;
  storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

async function readList(fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(SERVER_LIST_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`server list HTTP ${res.status}`);
  const json = (await res.json()) as { response?: { serverlist?: Array<{ endpoint: string; type: string }> } };
  const urls = (json.response?.serverlist ?? []).filter((s) => s.type === "websockets").map((s) => `wss://${s.endpoint}/cmsocket/`);
  if (urls.length === 0) throw new Error("server list empty");
  return urls;
}

/** Fresh list when Steam answers (retried: a just-woken worker's first fetch can fail), else the last good one. */
export async function getServerList(deps: ServerListDeps): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const urls = await readList(deps.fetch);
      try { await deps.storage.set({ [KEY]: { urls, fetchedAt: deps.now() } }); } catch { /* the fresh list still serves */ }
      return urls;
    } catch (e) {
      if (attempt < ATTEMPTS) { await deps.wait(RETRY_MS); continue; }
      let cached: { urls?: unknown; fetchedAt?: unknown } | undefined;
      try { cached = (await deps.storage.get(KEY))[KEY] as typeof cached; } catch { /* no fallback */ }
      const fresh = typeof cached?.fetchedAt === "number" && deps.now() - cached.fetchedAt < MAX_AGE_MS;
      if (fresh && Array.isArray(cached?.urls) && cached.urls.length > 0 && cached.urls.every((u) => typeof u === "string")) {
        return cached.urls as string[];
      }
      throw new Error(`Steam server list unavailable (${(e as Error)?.message ?? "error"})`);
    }
  }
}
