import type { AuthVariables } from "./auth.js";
import type { ValidatedVariables } from "./validate.js";

/** Hono environment shared by every control route and middleware. */
export type AppEnv = { Variables: AuthVariables & ValidatedVariables };
