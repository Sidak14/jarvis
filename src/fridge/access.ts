import type { Context, MiddlewareHandler } from "hono";

// Who may open the home screen (/dashboard). There is no code any more. A request is let in if:
//   1. it comes from this Mac itself (127.0.0.1), or
//   2. it comes through the Cloudflare tunnel from the HOME network (its public IP is ours), or
//   3. it comes through the tunnel and Cloudflare Access logged in someone whose email is on DASHBOARD_EMAILS.
// Anything else gets 403. Cloudflare Access sits in front of Jarvis, so a tunnel request that carries an Access login was
// really logged in; the email comes from the header Cloudflare adds. (Never add a Bypass for everyone: the home-network
// rule is the only Bypass, and Jarvis checks the IP itself.)

export interface AccessDeps {
  /** Host headers we answer to for local use: 127.0.0.1:8080 and localhost:8080. */
  localHosts: string[];
  /** Our public hostname (the tunnel). */
  publicHost: string;
  /** Emails allowed after a Cloudflare login, lower case. */
  emails: string[];
  /** The public IPs that count as home (changes now and then, so this is a function). */
  homeIps: () => string[];
  log?: (message: string) => void;
}

export type Verdict = "local" | "home" | "email" | "denied";

export function checkAccess(c: Context, deps: AccessDeps): { verdict: Verdict; ip: string | null; email: string | null } {
  const host = c.req.header("host") ?? "";
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const viaCloudflare = Boolean(ip || c.req.header("cf-ray"));
  if (deps.localHosts.includes(host) && !viaCloudflare) return { verdict: "local", ip, email: null };
  if (host !== deps.publicHost || !ip) return { verdict: "denied", ip, email: null };
  if (deps.homeIps().includes(ip)) return { verdict: "home", ip, email: null };
  const email = c.req.header("cf-access-jwt-assertion") ? (c.req.header("cf-access-authenticated-user-email") ?? "").trim().toLowerCase() : "";
  if (email && deps.emails.includes(email)) return { verdict: "email", ip, email };
  return { verdict: "denied", ip, email: email || null };
}

export function dashboardLogin(deps: AccessDeps): MiddlewareHandler {
  return async (c, next) => {
    const result = checkAccess(c, deps);
    if (result.verdict === "denied") {
      deps.log?.(`refused ${c.req.method} ${new URL(c.req.url).pathname} from ${result.ip ?? "unknown ip"}${result.email ? ` (${result.email} is not on the list)` : ""}`);
      return c.text("Forbidden", 403);
    }
    await next();
  };
}

// ---- Which public IP is "home"?
// Anything on the home network reaches Cloudflare from the same public IP. Cloudflare's own trace page says which one
// that is, as seen from this Mac, so Jarvis asks it now and then (and on a restart). No guessing, nothing to configure.

const TRACE_URL = "https://1.1.1.1/cdn-cgi/trace";
const REFRESH_MS = 10 * 60_000;

export function createHomeIps(opts: { extra: string[]; fetchFn?: typeof fetch; now?: () => number; log?: (m: string) => void }): { get: () => string[]; refresh: () => Promise<void> } {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  let found: string | null = null;
  let last = 0;

  async function refresh(): Promise<void> {
    last = now();
    try {
      const res = await fetchFn(TRACE_URL, { signal: AbortSignal.timeout(5000) });
      const ip = /^ip=(\S+)$/m.exec(await res.text())?.[1] ?? null;
      if (ip && ip !== found) opts.log?.(`home network is ${ip}`);
      if (ip) found = ip; // a failed lookup keeps the last known one
    } catch {
      /* try again next time */
    }
  }

  return {
    get() {
      if (now() - last > REFRESH_MS) void refresh();
      return [...opts.extra, ...(found ? [found] : [])];
    },
    refresh,
  };
}
