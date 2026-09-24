// @pistachio/control — see docs/cloud-sync-design.md §7
export {
  createApp,
  attachHub,
  affectedOriginsOnRevoke,
  parseAllowedOrigins,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  deviceView,
  wrapperView,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  WORKSPACE_SPACE_NAME,
  type ControlApp,
  type CreateAppOptions,
  type DeviceView,
  type MaintenanceResult,
  type WrapperView,
} from "./app.js";
export { createDb, createDbFromUrl, rowsOf, type Db } from "./db/client.js";
export { ensureSchema } from "./db/migrate.js";
export * as schema from "./db/schema.js";
export {
  authenticateToken,
  bearerAuth,
  bearerService,
  bearerToken,
  requireDevice,
  secretEquals,
  UUID_RE,
  type AuthenticatedToken,
  type AuthVariables,
} from "./auth.js";
export type { AppEnv } from "./env.js";
export { bearerGateway, GATEWAY_TOKEN_ENV, type GatewayEnv } from "./gateway.js";
export {
  createSigningKeys,
  generateSigningKeyEnv,
  generateSigningKeys,
  signingKeysFromEnv,
  type SigningKeyEnv,
  type SigningKeys,
} from "./keys-provider.js";
export { createIdp, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type Idp } from "./idp.js";
export {
  MAILER_DISABLED,
  MailerConfigError,
  logMailer,
  mailerFromEnv,
  resendMailer,
  type AuthOtpArgs,
  type AuthOtpType,
  type MailerOptions,
} from "./mailer.js";
export { setRecoveryWrapper, RECOVERY_CREDENTIAL_ID, RECOVERY_WRAPPER_KIND } from "./recovery.js";
export { ChallengeStore, CHALLENGE_TTL_MS, MAX_CHALLENGES_PER_DEVICE, MAX_CHALLENGES_TOTAL } from "./challenges.js";
export {
  BlueBubblesConnector,
  BLUEBUBBLES_TIMEOUT_MS,
  IMESSAGE_ONBOARDING_TTL_MS,
  IMESSAGE_OTP_MAX_ATTEMPTS,
  IMESSAGE_OTP_TTL_MS,
  blueBubblesOptionsFromEnv,
  formatIMessageCompletion,
  formatIMessageOnboarding,
  formatIMessageQuestion,
  maskPhoneNumber,
  normalizePhoneNumber,
  parseIMessageQuestionAnswer,
  toIMessagePlainText,
  type BlueBubblesInbound,
  type BlueBubblesOptions,
  type ParsedQuestionAnswer,
} from "./imessage.js";
export {
  PasswordAttemptLimiter,
  channelInboundLimiter,
  CHANNEL_INBOUND_LIMIT,
  PASSWORD_ATTEMPT_LIMIT,
  PASSWORD_RESET_REQUEST_LIMIT,
} from "./abuse.js";
export {
  SteerOutbox,
  MAX_OUTBOX_ATTEMPTS,
  httpRunnerClient,
  startOutboxDrain,
  type OutboxEntry,
  type OutboxFlushResult,
  type RunnerClient,
  type SteerBody,
} from "./outbox.js";
export {
  CREDENTIAL_PREFIX,
  CREDENTIAL_TTL_SECONDS,
  EGRESS_DISABLED,
  EgressConfigError,
  EgressProviderError,
  FlyEgressProvider,
  StaticEgressProvider,
  credentialPassword,
  credentialUsername,
  egressFromEnv,
  gatewaySecretFor,
  mintCredential,
  type EgressOptions,
  type EgressProvider,
  type EgressProviderKind,
  type FlyEgressConfig,
  type MintedCredential,
  type ProvisionedGateway,
} from "./egress.js";
export { createHubBinding, HUB_PATH, type HubBinding } from "./hub.js";
export { PostgresHostedRunStore, rowToRecord } from "./runs/store.js";
export {
  PostgresRunEventSink,
  RunEventBus,
  RunEventError,
  MAX_EVENT_BYTES,
  TERMINAL_STATUSES,
  controlRunSummary,
  isCommandEvent,
  listRunEvents,
  runEventInputSchema,
  runEventSchema,
  type AppendedBatch,
  type RunEventInputWire,
} from "./runs/events.js";
export { ControlAuthorityRevoker, type ControlRevokerDeps } from "./runs/revoker.js";
export {
  ChannelRouter,
  ChannelWebhookAdapter,
  OutboundUrlError,
  PostgresNotificationScheduleStore,
  WEBHOOK_TIMEOUT_MS,
  createChannelDispatcher,
  notificationFor,
  vetOutboundUrl,
  type ChannelRouterDeps,
  type ChannelWebhookOptions,
  type LookupFn,
  type VetOutboundOptions,
} from "./channels.js";
export {
  base64String,
  body,
  param,
  query,
  spaceIdSchema,
  spaceOrWorkspaceIdSchema,
  validate,
  validateParam,
  validateQuery,
  SPACE_ID_RE,
  SPACE_OR_WORKSPACE_ID_RE,
  type ValidatedVariables,
} from "./validate.js";
