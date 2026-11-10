import type { Context, MiddlewareHandler } from "hono";
import { config } from "./config";

// The dashboards show private data and can change things. They are served to this Mac, or
// through the Cloudflare tunnel. The tunnel is protected by Cloudflare Access, which logs me in
// before a request reaches Jarvis. As a second check we only serve tunnel requests that arrive
// on our own hostname and carry the Access header (presence only, not verified).
const LOCAL_HOSTS = [`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`];

function isLocalRequest(c: Context): boolean {
  const viaCloudflare = c.req.header("cf-connecting-ip") || c.req.header("cf-ray");
  return LOCAL_HOSTS.includes(c.req.header("host") ?? "") && !viaCloudflare;
}

function isAccessTunnelRequest(c: Context): boolean {
  return (
    c.req.header("host") === config.PUBLIC_HOST && Boolean(c.req.header("cf-access-jwt-assertion"))
  );
}

export const dashboardAccess: MiddlewareHandler = async (c, next) => {
  if (!isLocalRequest(c) && !isAccessTunnelRequest(c)) return c.text("Forbidden", 403);
  await next();
};
