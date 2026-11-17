import type { Context, MiddlewareHandler } from "hono";

// Who may open the home screen (/dashboard). There is no code any more. A request is let in if:
//   1. it comes from this Mac itself (127.0.0.1), or
//   2. it comes straight from a device on the HOME network (http://<this Mac's address>:8080/dashboard, no Cloudflare), or
//   3. it comes through the Cloudflare tunnel and Cloudflare Access logged in someone whose email is on DASHBOARD_EMAILS.
// Anything else gets 403. Cloudflare Access sits in front of the tunnel, so a tunnel request that carries an Access login
// was really logged in; the email comes from the header Cloudflare adds.

export interface AccessDeps {
  /** Host headers we answer to for local use: 127.0.0.1:8080 and localhost:8080. */
  localHosts: string[];
  /** Our public hostname (the tunnel). */
  publicHost: string;
  /** Emails allowed after a Cloudflare login, lower case. */
  emails: string[];
  log?: (message: string) => void;
}

export type Verdict = "local" | "lan" | "email" | "denied";

/** The address of the device on the other end of the connection (not what a header claims). */
export function remoteAddress(c: Context): string {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "";
}

/** A home-network address: 192.168.x.x, 10.x.x.x, 172.16-31.x.x, or the IPv6 equivalents. Not this Mac, not the internet. */
export function isHomeNetwork(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  if (/^(10\.|192\.168\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^(fe80|fc|fd)/i.test(ip);
}

/** A direct connection from a device on the home network: it did not come through Cloudflare. */
export function isHomeNetworkRequest(c: Context): boolean {
  return isHomeNetwork(remoteAddress(c)) && !c.req.header("cf-connecting-ip") && !c.req.header("cf-ray");
}

export function checkAccess(c: Context, deps: AccessDeps): { verdict: Verdict; ip: string | null; email: string | null } {
  const host = c.req.header("host") ?? "";
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const viaCloudflare = Boolean(ip || c.req.header("cf-ray"));
  if (deps.localHosts.includes(host) && !viaCloudflare) return { verdict: "local", ip, email: null };
  if (isHomeNetworkRequest(c)) return { verdict: "lan", ip: remoteAddress(c), email: null };
  if (host !== deps.publicHost || !ip) return { verdict: "denied", ip, email: null };
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
