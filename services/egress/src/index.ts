// @pistachio/egress — see docs/cloud-sync-design.md §9
export {
  Authenticator,
  DevVerifier,
  RevocationSet,
  SharedSecretVerifier,
  authFailureStatus,
  credentialPassword,
  parseCredentialUsername,
  parseProxyAuthorization,
  parseSecretHex,
  type AuthFailure,
  type AuthResult,
  type AuthenticatorOptions,
  type ParsedCredential,
  type PresentedCredential,
  type TokenVerifier,
} from "./auth.js";
export {
  CREDENTIAL_PREFIX,
  DEFAULT_DEV_LISTEN,
  DEFAULT_LISTEN,
  ENV,
  HEAD_READ_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_HEAD_BYTES,
  MAX_TUNNELS_PER_DEVICE,
  MAX_TUNNELS_PER_USER,
  PROXY_AUTH_REALM,
  consoleLogger,
  silentLogger,
  type Logger,
} from "./config.js";
export { ControlClient, ControlRequestError, type ControlClientOptions, type FetchLike } from "./control.js";
export { LimitsPoller, parseLimits, type LimitsPollerOptions, type ThrottleSource, type UserLimits } from "./limits.js";
export {
  EgressMetrics,
  MetricsFlusher,
  type ConnectionSample,
  type MetricsFlusherOptions,
  type UsageReport,
  type UserTotals,
} from "./metrics.js";
export {
  CREDENTIAL_TTL_SECONDS,
  basicProxyAuthorization,
  bearerProxyAuthorization,
  mintCredential,
  type MintOptions,
  type MintedCredential,
} from "./mint.js";
export {
  dialAny,
  resolveTarget,
  systemLookup,
  tcpDial,
  unbracket,
  type DialFn,
  type LookupFn,
  type ResolvedAddress,
  type TargetPolicyOptions,
  type TargetResolution,
} from "./policy.js";
export {
  RevocationPoller,
  parseRevocationFeed,
  type RevocationEntry,
  type RevocationFeed,
  type RevocationPollerOptions,
} from "./revocation.js";
export {
  EgressServer,
  createEgressServer,
  parseConnectTarget,
  runGateway,
  type ConnectTarget,
  type EgressLimits,
  type EgressServerEvents,
  type EgressServerOptions,
  type EgressTimeouts,
  type RunningGateway,
  type TunnelClosedEvent,
} from "./server.js";
export {
  StartupError,
  isLoopbackLiteral,
  parseExtraPorts,
  parseListen,
  resolveStartup,
  type ListenAddress,
  type StartupConfig,
  type StartupEnv,
  type StartupIo,
} from "./startup.js";
export { Tunnel, TunnelRegistry, type TunnelIdentity } from "./tunnels.js";
