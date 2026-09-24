/**
 * Dedicated integrations: a third-party service the agent reaches through
 * its API with a token the person granted, rather than by driving the site
 * in a tab. Gmail was the first and Google Calendar the second; the shapes here are the part every party
 * shares in the clear — which provider a connection is for, which account,
 * how much it may do — so that adding the next provider is a catalog entry
 * and a tool family, not a new storage design.
 *
 * A connection belongs to a Space, like a vault entry (D28): the refresh
 * token is sealed under the Space seal key by the device that obtained it,
 * control stores the ciphertext with this metadata, and only devices
 * holding the Space key (the person's Mac, the assigned cloud device) can
 * open it to mint an access token. The token itself never appears in these
 * shapes and never reaches the model.
 */

export const INTEGRATION_PROVIDERS = ["gmail", "google_calendar"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/**
 * How much of the service the agent may use, from least to most. A level
 * includes every level before it. The names are shared across providers so
 * a settings page and a prompt can speak of them uniformly; what each level
 * means for a provider — which OAuth scopes it needs, which tools it
 * unlocks — is the provider's catalog entry.
 */
export const INTEGRATION_ACCESS_LEVELS = ["read", "write", "send"] as const;
export type IntegrationAccess = (typeof INTEGRATION_ACCESS_LEVELS)[number];

/**
 * A connection's standing. `connected` is usable. `reconnect_required` is a
 * grant the provider refused for good: the person must consent again.
 * `revoke_pending` is a disconnect asked for by a device that holds no
 * Space key (the web app): the row is kept as a tombstone, unusable, until
 * a device that can open the grant revokes it at the provider and deletes
 * the row. A tombstone is never replaced or resurrected.
 */
export const INTEGRATION_CONNECTION_STATUSES = ["connected", "reconnect_required", "revoke_pending"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

/** One access level as the catalog describes it. */
export interface IntegrationAccessLevel {
  id: IntegrationAccess;
  label: string;
  /** What the agent can do at this level, in a sentence for the settings page. */
  note: string;
  /** The OAuth scopes this level needs. A level's scopes cover every level below it. */
  scopes: readonly string[];
}

/** The OAuth 2.0 endpoints a provider's authorization-code flow uses. */
export interface IntegrationOAuthEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  /** Extra query parameters on the authorization request, e.g. Google's `access_type=offline`. */
  authorizationParams: Readonly<Record<string, string>>;
}

export interface IntegrationCatalogEntry {
  id: IntegrationProvider;
  name: string;
  /** One line for the settings page. */
  description: string;
  oauth: IntegrationOAuthEndpoints;
  /** Least to most, in `INTEGRATION_ACCESS_LEVELS` order; a provider may offer a subset. */
  accessLevels: readonly IntegrationAccessLevel[];
  /**
   * Scopes a broader scope stands in for: a grant of the key satisfies a
   * level asking for any of the values. Google's `gmail.modify` covers
   * everything `gmail.readonly` allows without naming it.
   */
  scopeImplies: Readonly<Record<string, readonly string[]>>;
}

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
// Everything but permanent deletion: reading, drafts, labels, archiving,
// and — because Google offers no drafts-without-send scope — sending. The
// `write` level takes this scope and Pistachio withholds the send tool.
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_EVENTS_READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_LIST_READONLY = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CALENDAR_METADATA_READONLY = "https://www.googleapis.com/auth/calendar.calendars.readonly";
const CALENDAR_FREEBUSY = "https://www.googleapis.com/auth/calendar.events.freebusy";
const CALENDAR_COMMON_SCOPES = [CALENDAR_LIST_READONLY, CALENDAR_METADATA_READONLY, CALENDAR_FREEBUSY];
// Retained only to recognize existing grants. New connections never need
// permission to create/delete calendars or change their sharing settings.
const CALENDAR_FULL = "https://www.googleapis.com/auth/calendar";

export const INTEGRATION_CATALOG: Readonly<Record<IntegrationProvider, IntegrationCatalogEntry>> = {
  gmail: {
    id: "gmail",
    name: "Gmail",
    description: "Read your inbox, search mail, write drafts, and send email through the Gmail API.",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      // `offline` is what yields a refresh token; `consent` makes Google
      // issue one again on reconnect instead of silently reusing a grant
      // whose refresh token this device does not hold.
      authorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    accessLevels: [
      {
        id: "read",
        label: "Read only",
        note: "Search and read your mail. Nothing is created, changed, or sent.",
        scopes: [GMAIL_READONLY],
      },
      {
        id: "write",
        label: "Read and draft",
        note: "Everything above, plus writing drafts for you to review and tidying — archiving, labels, marking read. It never sends.",
        scopes: [GMAIL_MODIFY],
      },
      {
        id: "send",
        label: "Read, draft, and send",
        note: "Everything above, plus sending email as you when you ask it to.",
        scopes: [GMAIL_MODIFY],
      },
    ],
    scopeImplies: { [GMAIL_MODIFY]: [GMAIL_READONLY] },
  },
  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    description: "See your schedule, find free time, and create, change, and answer events through the Google Calendar API.",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      // No `include_granted_scopes` here: an operator may register one
      // Google client for every Google integration, and a calendar grant
      // that silently picked up the mail scopes granted earlier would be a
      // calendar connection able to read mail.
      authorizationParams: { access_type: "offline", prompt: "consent" },
    },
    accessLevels: [
      {
        id: "read",
        label: "Read only",
        note: "See your calendars, events, and free time. Nothing is created or changed.",
        scopes: [...CALENDAR_COMMON_SCOPES, CALENDAR_EVENTS_READONLY],
      },
      {
        id: "write",
        label: "Read and edit",
        note: "Everything above, plus creating, changing, and deleting your own events and answering invitations. Events with other guests are left as they are, and nobody is emailed.",
        scopes: [...CALENDAR_COMMON_SCOPES, CALENDAR_EVENTS],
      },
      {
        id: "send",
        label: "Read, edit, and invite",
        note: "Everything above, plus meetings with other people: inviting guests, and moving or cancelling events they are on, with Google emailing them when you ask it to.",
        scopes: [...CALENDAR_COMMON_SCOPES, CALENDAR_EVENTS],
      },
    ],
    scopeImplies: {
      [CALENDAR_FULL]: [CALENDAR_READONLY, CALENDAR_EVENTS, CALENDAR_EVENTS_READONLY, ...CALENDAR_COMMON_SCOPES],
      [CALENDAR_EVENTS]: [CALENDAR_EVENTS_READONLY],
      [CALENDAR_READONLY]: [CALENDAR_EVENTS_READONLY, ...CALENDAR_COMMON_SCOPES],
    },
  },
};

export function isIntegrationProvider(value: unknown): value is IntegrationProvider {
  return typeof value === "string" && (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

export function isIntegrationAccess(value: unknown): value is IntegrationAccess {
  return typeof value === "string" && (INTEGRATION_ACCESS_LEVELS as readonly string[]).includes(value);
}

/** Whether `granted` covers `required`: levels are ordered, and a level includes those before it. */
export function integrationAccessAllows(granted: IntegrationAccess, required: IntegrationAccess): boolean {
  return INTEGRATION_ACCESS_LEVELS.indexOf(granted) >= INTEGRATION_ACCESS_LEVELS.indexOf(required);
}

/** The catalog's description of one level of one provider, or null when the provider does not offer it. */
export function integrationAccessLevel(provider: IntegrationProvider, access: IntegrationAccess): IntegrationAccessLevel | null {
  return INTEGRATION_CATALOG[provider].accessLevels.find((level) => level.id === access) ?? null;
}

/**
 * Whether a grant's scopes are enough for a level. A person who connected
 * at `write` may move to `send` without a new consent (Gmail's scope is
 * the same); moving up from `read` needs the consent screen again.
 */
export function integrationScopesCover(provider: IntegrationProvider, granted: readonly string[], access: IntegrationAccess): boolean {
  const level = integrationAccessLevel(provider, access);
  if (level === null) return false;
  const implies = INTEGRATION_CATALOG[provider].scopeImplies;
  const effective = new Set(granted);
  for (const scope of granted) for (const implied of implies[scope] ?? []) effective.add(implied);
  return level.scopes.every((scope) => effective.has(scope));
}

/** A connection as control lists it: metadata plus the sealed token. */
export interface IntegrationConnection {
  id: string;
  spaceId: string;
  provider: IntegrationProvider;
  /** The account the grant is for — the Google account's email address for Gmail and Google Calendar. */
  accountLabel: string;
  access: IntegrationAccess;
  /** The OAuth scopes the provider actually granted. */
  scopes: string[];
  status: IntegrationConnectionStatus;
  /** Base64 of `seal(spaceSealKey, IntegrationConnectionPayload, integrationConnectionSealAad(spaceId, id))`. */
  sealedPayload: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** The plaintext a connection's sealed payload opens to. */
export interface IntegrationConnectionPayload {
  version: 1;
  /** The long-lived grant. Access tokens are minted from it and never stored. */
  refreshToken: string;
}

export const MAX_INTEGRATION_ACCOUNT_LABEL = 320;
export const MAX_INTEGRATION_SCOPES = 32;
export const MAX_INTEGRATION_PAYLOAD_BYTES = 16 * 1024;

/**
 * The OAuth client the operator registered with the provider, as control
 * hands it to enrolled devices. Every provider here uses an installed-app
 * client: the flow runs on the person's device against a loopback redirect,
 * and the provider does not treat such a client's secret as confidential
 * (Google's documentation says so in as many words), which is what lets the
 * cloud device refresh a token too. A confidential-client secret must never
 * be listed here.
 */
export interface IntegrationProviderConfig {
  id: IntegrationProvider;
  clientId: string;
  clientSecret: string | null;
}

/** Commands against a connected integration, for the run's tool trace. */
export type IntegrationToolRequest =
  | { name: "gmail.search"; query: string }
  | { name: "gmail.read"; id: string }
  | { name: "gmail.draft"; subject: string; to: string }
  | { name: "gmail.send"; subject: string; to: string }
  | { name: "gmail.modify"; id: string; action: string }
  | { name: "google_calendar.calendars" }
  | { name: "google_calendar.events"; query: string; from: string; to: string }
  | { name: "google_calendar.event"; id: string }
  | { name: "google_calendar.freebusy"; from: string; to: string }
  | { name: "google_calendar.create"; summary: string; start: string }
  | { name: "google_calendar.update"; id: string }
  | { name: "google_calendar.delete"; id: string }
  | { name: "google_calendar.respond"; id: string; response: string };

/** The provider a trace name belongs to, or null for names that are not an integration's. */
export function integrationOfToolName(name: string): IntegrationProvider | null {
  const dot = name.indexOf(".");
  if (dot === -1) return null;
  const prefix = name.slice(0, dot);
  return isIntegrationProvider(prefix) ? prefix : null;
}
