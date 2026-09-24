"use client";

import {
  ArrowRight,
  Check,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  credentialCaptureSealAad,
  fromBase64,
  sealCredentialCapturePayload,
  toBase64,
  utf8,
} from "@pistachio/sync-protocol";
import { isVaultStorableField } from "@pistachio/protocol";
import {
  ControlError,
  type CredentialCapture,
  getCredentialCapture,
  submitCredentialCapture,
} from "./control";

export interface CredentialCaptureTransport {
  load(captureId: string): Promise<{ capture: CredentialCapture }>;
  submit(captureId: string, sealedPayload: string): Promise<unknown>;
}

const NUMERIC_AUTOCOMPLETE = new Set([
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "transaction-amount",
]);

/** Thrown when this browser could not encrypt the entries locally; nothing was sent. */
class LocalSealError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "sealing failed", { cause });
    this.name = "LocalSealError";
  }
}

function captureError(error: unknown): string {
  if (error instanceof LocalSealError) {
    return "This browser couldn't encrypt your entries, so nothing was sent. Update it, or try a current version of Safari, Chrome, or Firefox.";
  }
  if (error instanceof ControlError) {
    if (error.code === "not_found") return "This request is not available.";
    if (error.code === "expired")
      return "This request has expired. Ask the agent to create a new one.";
    if (error.code === "already_submitted")
      return "These details were already sent.";
    if (error.code === "not_ready")
      return "The handoff is still being prepared. Wait a moment, then try again.";
    // Control answered, but with something this page does not understand.
    return "The secure handoff could not be completed. Your entries are still only on this device.";
  }
  // No answer at all: offline, blocked, or a timeout. The entries never left.
  return "Couldn't reach Pistachio's servers, so nothing was sent. Check your connection and try again.";
}

function hostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function StateCard({
  icon,
  eyebrow,
  title,
  body,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  body: string;
}): ReactNode {
  return (
    <section className="credential-card credential-state-card" role="status">
      <span className="credential-state-icon">{icon}</span>
      <p className="credential-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function CredentialForm({
  capture,
  onSubmitted,
  controlUrl,
  transport,
}: {
  capture: CredentialCapture;
  onSubmitted: () => void;
  controlUrl?: string;
  transport?: CredentialCaptureTransport;
}): ReactNode {
  // Controlled inputs necessarily retain plaintext in the DOM and React state
  // so a failed network submission can be retried. Only the encoded byte copy
  // below can be explicitly wiped; never persist or log either representation.
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  // Whether the cloud browser may keep these values (sealed under the Space
  // key, never readable by the agent) for the next run on this site. The
  // choice travels inside the sealed payload; control never sees it. A form
  // made only of one-time codes has nothing worth keeping, so it is not asked.
  const keepable = capture.fields.some(isVaultStorableField);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this browser can mask a plain text input with CSS. When it can,
  // secrets are never rendered as `type="password"`, which is the one signal
  // every password manager keys on; without it there is no login form to
  // fill from, and nothing to offer saving under pistachio's origin. Decided
  // after mount so the server render (which falls back to a real password
  // input) matches the first client render.
  const [maskable, setMaskable] = useState(false);
  useEffect(() => {
    setMaskable(
      typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports("-webkit-text-security", "disc"),
    );
  }, []);
  const deadline = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(capture.expiresAt)),
    [capture.expiresAt],
  );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    if (capture.fields.some((field) => (values[field.id] ?? "") === "")) {
      setError("Complete every requested field.");
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const plaintext = utf8(
          JSON.stringify({
            version: 1,
            fields: values,
            remember: keepable && remember,
          }),
        );
        let sealedPayload: string;
        try {
          sealedPayload = toBase64(
            await sealCredentialCapturePayload(
              fromBase64(capture.encryptionPublicKey),
              plaintext,
              credentialCaptureSealAad(capture.runId, capture.id),
            ),
          );
        } catch (cause) {
          throw new LocalSealError(cause);
        } finally {
          plaintext.fill(0);
        }
        if (transport === undefined)
          await submitCredentialCapture(capture.id, sealedPayload, controlUrl);
        else await transport.submit(capture.id, sealedPayload);
        setValues({});
        onSubmitted();
      } catch (cause) {
        setError(captureError(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section className="credential-card">
      <div className="credential-card-head">
        <span className="credential-key-icon">
          <KeyRound aria-hidden="true" />
        </span>
        <div>
          <p className="credential-eyebrow">Secure information requested</p>
          <h2>
            Continue on <bdi>{hostname(capture.siteOrigin)}</bdi>
          </h2>
        </div>
      </div>

      <div
        className="credential-destination"
        data-testid="credential-destination"
      >
        <span className="credential-site-dot" aria-hidden="true">
          {hostname(capture.siteOrigin).slice(0, 1).toUpperCase()}
        </span>
        <span>
          <small>Destination origin</small>
          <strong dir="ltr">{capture.siteOrigin}</strong>
        </span>
      </div>

      {/* This page asks for another site's secrets while sitting on
          pistachio's origin, so a browser that reads it as a login form
          offers the reader their pistachio credentials and then offers to
          save the site's under this origin. `autoComplete="off"` alone does
          not stop that: Chrome and Safari ignore it on password inputs. So
          the form is kept from looking like a login form at all:
          - secrets are plain text inputs masked with CSS wherever the
            browser supports it, and `new-password` (which Chrome honours by
            not offering saved logins) only where it does not;
          - emails are plain text inputs too, with the keyboard set by
            `inputMode`, so the address autofill has no `type="email"` hook;
          - ids and names are positional rather than "email"/"password", so
            attribute heuristics find nothing to match;
          - the extension hints tell 1Password, LastPass, Bitwarden and
            Dashlane to leave these fields alone. */}
      <form
        onSubmit={submit}
        className="credential-form"
        autoComplete="off"
        data-testid="credential-capture-form"
        data-form-type="other"
      >
        {capture.fields.map((field, index) => {
          const secret = field.type === "password";
          const revealed = visible[field.id] === true;
          const numericInput =
            field.type === "otp" ||
            (field.autocomplete !== undefined &&
              NUMERIC_AUTOCOMPLETE.has(field.autocomplete));
          const masked = secret && !revealed;
          const inputType = masked && !maskable ? "password" : "text";
          const inputId = `${formId}-cf-${index + 1}`;
          return (
            <div key={field.id} className="credential-field">
              <label htmlFor={inputId}>{field.label}</label>
              <span className="credential-input-wrap">
                <input
                  id={inputId}
                  name={`cf-${index + 1}`}
                  disabled={busy}
                  type={inputType}
                  className={
                    masked && maskable ? "credential-masked" : undefined
                  }
                  inputMode={
                    numericInput
                      ? "numeric"
                      : field.type === "email"
                        ? "email"
                        : "text"
                  }
                  // The runner's autocomplete purpose shapes the keyboard
                  // above, never the browser's password manager: only a
                  // one-time code is safe to hint, because it is filled from
                  // the message that carried it and never from a saved login.
                  // A real password input (the no-CSS-masking fallback) gets
                  // `new-password`, the one value Chrome will not fill a
                  // saved login into.
                  autoComplete={
                    field.type === "otp"
                      ? "one-time-code"
                      : inputType === "password"
                        ? "new-password"
                        : "off"
                  }
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={4096}
                  required
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-bwignore=""
                  data-form-type="other"
                  value={values[field.id] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.id]: event.target.value,
                    }))
                  }
                />
                {secret ? (
                  <button
                    type="button"
                    aria-label={
                      revealed ? `Hide ${field.label}` : `Show ${field.label}`
                    }
                    onClick={() =>
                      setVisible((current) => ({
                        ...current,
                        [field.id]: !revealed,
                      }))
                    }
                  >
                    {revealed ? (
                      <EyeOff aria-hidden="true" />
                    ) : (
                      <Eye aria-hidden="true" />
                    )}
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}

        {keepable ? (
          <label className="credential-remember">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>
              <strong>Keep in my Pistachio vault</strong>
              <small>
                So the agent can sign in to{" "}
                <bdi>{hostname(capture.siteOrigin)}</bdi> next time without
                asking. Encrypted with your Space key; the agent never sees the
                values. One-time codes are never kept. You can view or remove it
                under Settings → Vault.
              </small>
            </span>
          </label>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="credential-error">
            <TriangleAlert aria-hidden="true" /> {error}
          </p>
        )}

        <div className="credential-form-actions">
          <button
            type="button"
            className="credential-clear"
            disabled={busy}
            onClick={() => {
              setValues({});
              setVisible({});
              setError(null);
            }}
          >
            Clear form
          </button>
          <button
            type="submit"
            className="credential-submit"
            data-testid="credential-submit"
            disabled={busy}
          >
            {busy ? "Encrypting…" : "Encrypt & send"}
            {busy ? (
              <span className="credential-spinner" aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
          </button>
        </div>
      </form>

      <div className="credential-privacy-note">
        <LockKeyhole aria-hidden="true" />
        <p>
          <strong>Private by design.</strong> Encrypted on this device, used
          once, then deleted. The agent only learns whether insertion succeeded.
        </p>
      </div>
      <p className="credential-expiry">
        <Clock3 aria-hidden="true" /> This request expires at {deadline}
      </p>
    </section>
  );
}

function ReadyCapture({
  captureId,
  controlUrl,
  transport,
}: {
  captureId: string;
  controlUrl?: string;
  transport?: CredentialCaptureTransport;
}): ReactNode {
  const [capture, setCapture] = useState<CredentialCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (
      transport === undefined
        ? getCredentialCapture(captureId, controlUrl)
        : transport.load(captureId)
    ).then(
      ({ capture: loaded }) => {
        if (!cancelled) setCapture(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setError(captureError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [captureId, controlUrl, transport]);

  if (error !== null) {
    return (
      <StateCard
        icon={<TriangleAlert aria-hidden="true" />}
        eyebrow="Request unavailable"
        title="This handoff can’t be opened"
        body={error}
      />
    );
  }
  if (capture === null) {
    return (
      <section className="credential-card credential-loading" role="status">
        <span className="credential-spinner" /> Loading secure form…
      </section>
    );
  }
  if (
    submitted ||
    capture.status === "submitted" ||
    capture.status === "consumed"
  ) {
    return (
      <StateCard
        icon={<Check aria-hidden="true" />}
        eyebrow="Handoff complete"
        title="Sent securely"
        body="Your details were sent securely. The agent will continue when they have been entered."
      />
    );
  }
  if (capture.status === "expired") {
    return (
      <StateCard
        icon={<Clock3 aria-hidden="true" />}
        eyebrow="Request expired"
        title="Request a fresh handoff"
        body="For safety, sign-in links work for only 15 minutes. Return to the run and ask the agent to try again."
      />
    );
  }
  return (
    <CredentialForm
      capture={capture}
      controlUrl={controlUrl}
      transport={transport}
      onSubmitted={() => setSubmitted(true)}
    />
  );
}

/** A request change unmounts the old form, including all plaintext field state. */
export function CredentialCapture({
  captureId,
  controlUrl,
  transport,
  inline = false,
}: {
  captureId: string;
  controlUrl?: string;
  transport?: CredentialCaptureTransport;
  inline?: boolean;
}): ReactNode {
  return (
    <div className={inline ? "credential-inline" : undefined}>
      <ReadyCapture
        key={`${controlUrl ?? "default"}:${captureId}`}
        captureId={captureId}
        controlUrl={controlUrl}
        transport={transport}
      />
    </div>
  );
}
