/** The most Steam servers one connect tries; each failure before open waits out the transport's own timeout. */
export const MAX_SERVER_ATTEMPTS = 3;

/**
 * Opens a connection on the first server that answers, so one dead or slow server does not fail the session.
 * `make` builds (and registers) the connection for a server; `cancelled` says the caller gave up meanwhile.
 */
export async function openFirstReachable<C extends { open(): Promise<void>; close(): void }>(
  urls: readonly string[],
  make: (url: string) => C,
  cancelled: (c: C) => boolean,
): Promise<C> {
  let last: unknown = new Error("no Steam server to connect to");
  for (const url of urls.slice(0, MAX_SERVER_ATTEMPTS)) {
    const c = make(url);
    try {
      await c.open();
      return c;
    } catch (e) {
      c.close();
      if (cancelled(c)) throw e;
      last = e;
    }
  }
  throw last;
}
