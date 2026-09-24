/**
 * Egress-gateway credential (§7.2, §9). The gateway is a separate plane
 * running no user code; it authenticates to control with the operator's
 * shared secret `EGRESS_GATEWAY_TOKEN` and is the only writer control
 * believes about proxied bytes. Never a device token, never a service token.
 */

import type { MiddlewareHandler } from "hono";
import { bearerService, secretEquals } from "./auth.js";
import type { AppEnv } from "./env.js";

export { secretEquals };

/** Reads EGRESS_GATEWAY_TOKEN. */
export type GatewayEnv = Record<string, string | undefined>;

export const GATEWAY_TOKEN_ENV = "EGRESS_GATEWAY_TOKEN";

/**
 * Bearer auth for gateway-facing routes. The env is read per request (not
 * captured at boot) so rotating the secret does not need a restart. With no
 * secret configured the routes are CLOSED (503), not open.
 */
export function bearerGateway(env: GatewayEnv): MiddlewareHandler<AppEnv> {
  return bearerService(() => env[GATEWAY_TOKEN_ENV], "gateway_auth_unconfigured");
}
