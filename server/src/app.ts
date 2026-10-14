// The Sphere's HTTP API (spec/sphere-api.md section 2): routing and error answers.

import type { Deps, Env } from "./env.ts";
import { ApiError, INTERNAL_MESSAGE, apiError, errorResponse } from "./http.ts";
import { tokenEndpoint } from "./oauth.ts";
import { audit } from "./routes/audit.ts";
import { getMemberRoute, invite, listMembers, redeem, revoke, updateCard } from "./routes/members.ts";
import { ack, deliveries, send } from "./routes/messages.ts";
import { getPolicy, putPolicy } from "./routes/policy.ts";
import { createSphere, getSphereRoute, health } from "./routes/spheres.ts";

type Handler = (request: Request, env: Env, deps: Deps, ...params: string[]) => Promise<Response> | Response;

const SEGMENT = "([^/]+)";
const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/v0\.1\/health$/, health],
  ["POST", /^\/v0\.1\/spheres$/, createSphere],
  ["POST", /^\/v0\.1\/oauth\/token$/, tokenEndpoint],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}$`), getSphereRoute],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations$`), invite],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations/${SEGMENT}/redeem$`), redeem],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members$`), listMembers],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}$`), getMemberRoute],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}/card$`), updateCard],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}$`), revoke],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/policy$`), getPolicy],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/policy$`), putPolicy],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/messages$`), send],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/deliveries$`), deliveries],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/deliveries/ack$`), ack],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/audit$`), audit],
];

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    for (const [method, pattern, handler] of ROUTES) {
      const m = pattern.exec(path);
      if (!m || method !== request.method) continue;
      const params = m.slice(1).map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          throw apiError("not_found", "no such resource");
        }
      });
      return await handler(request, env, deps, ...params);
    }
    throw apiError("not_found", "no such endpoint");
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    // Never echo what failed: it may hold what a client sent. The cause stays in the Worker's own log.
    console.error("sphere: internal error", e instanceof Error ? e.name : typeof e);
    return errorResponse(apiError("internal", INTERNAL_MESSAGE));
  }
}
