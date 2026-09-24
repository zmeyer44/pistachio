"use client";

/**
 * Everything before the app: signing in, and unlocking after a reload.
 *
 * These are two different asks and the copy says so. Signing in creates a
 * device for this browser. Unlocking derives the keys that read your data, and
 * is needed again after a reload because those keys are never written down.
 *
 * BOTH web apps mount this one gate (docs/web-browser-design.md §15), so it
 * carries its own skin (`./auth.css`) and its own markup rather than either
 * app's Tailwind utilities, and it never navigates: the dashboard shows its
 * rail the moment the session is ready, and the browser app shows the shell,
 * each at the address the reader is already on.
 *
 * One layout, two dresses, because the door opens onto two different rooms —
 * see `GateSkin` below.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useSession } from "./session";
import { MAX_PIN_ATTEMPTS, PIN_LENGTH, sanitizePinInput } from "./pin";
import { wrapIntoRing } from "./pin-motion";
import {
  playUnlockSound,
  playWrongSound,
  preloadPinSounds,
  primeUnlockSound,
  UNLOCK_CLICK_MS,
} from "./pin-sound";
import { REMEMBER_DAYS } from "./vault";

/**
 * Which room this door is standing in. The layout is the same either way —
 * masthead, one card in the middle, title, lede, form — and only the material
 * changes, in `auth.css`.
 *
 * `site` is `apps/www`: the door is the front door of the marketing site and
 * is dressed like it, cream and green and Inter over the same photograph the
 * early-access form uses. The neutral Geist surface starts on the other side.
 *
 * `shell` is `apps/web`, where the very next thing the reader sees is the
 * browser — and, on a new account, its first-run walkthrough, whose every step
 * floats on the theme's own gradient (§14). So the door stands on that same
 * ground in the same Geist material, and opening it changes what is in the
 * frame rather than which world the frame is in.
 */
export type GateSkin = "site" | "shell";

/**
 * The marketing site, for the two links the door carries. Empty on `www`,
 * where they are its own pages; the browser app sets
 * `NEXT_PUBLIC_PISTACHIO_WWW_URL` and they cross the origin.
 */
const SITE_URL = (process.env["NEXT_PUBLIC_PISTACHIO_WWW_URL"] ?? "").trim().replace(/\/+$/u, "");

const HOME_HREF = SITE_URL === "" ? "/" : SITE_URL;
const EARLY_ACCESS_HREF = `${SITE_URL}/early-access`;

/** The site's arrow, inline: the gate ships no icon dependency. */
function ArrowRight({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4 10h11M10.5 5.5 15 10l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Wordmark home, and the way in for anyone who does not have an account yet. */
function Masthead(): ReactNode {
  return (
    <header className="pa-auth-masthead">
      <a href={HOME_HREF} className="pa-auth-brand">
        {/* Mark is decorative — the wordmark beside it names the link. */}
        <span aria-hidden="true" className="pa-auth-mark" />
        <span className="pa-auth-wordmark">Pistachio</span>
      </a>
      <a href={EARLY_ACCESS_HREF} className="pa-auth-early">
        Get early access
      </a>
    </header>
  );
}

/**
 * The door's root element. On the site the door IS the page, so it is the
 * page's `<main>`; on the browser app the layout already owns that landmark
 * and the door is one pane inside it, so it is a plain box — two `<main>`
 * elements sharing an id would send the skip link to the wrong one.
 */
function Root({ skin, children }: { skin: GateSkin; children: ReactNode }): ReactNode {
  return skin === "shell" ? (
    <div className="pa-auth" data-skin="shell">
      {children}
    </div>
  ) : (
    <main id="main" className="pa-auth" data-skin="site">
      {children}
    </main>
  );
}

/**
 * Everything under the keypad, which stays in the layout when it goes.
 *
 * Unmounting it was the obvious thing and the wrong one: the stage is a
 * centred column, so taking three lines out of it re-centres what is left and
 * the keypad drops — 28 px on the unlock screen — at the exact moment it starts
 * to animate. Hidden, it still occupies its space, and the fade it was already
 * getting from `[data-leaving]` is now the whole of what happens to it.
 *
 * `inert` is what makes hidden mean hidden: opacity alone leaves the buttons
 * clickable and in the tab order, and a link nobody can see is worse than one
 * that is simply gone.
 */
function Tail({ hidden, children }: { hidden: boolean; children: ReactNode }): ReactNode {
  return (
    <div className="pa-auth-tail" inert={hidden}>
      {children}
    </div>
  );
}

function Frame({
  skin,
  title,
  lede,
  children,
}: {
  skin: GateSkin;
  title: string;
  lede: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Root skin={skin}>
      <Masthead />
      <div className="pa-auth-body">
        <div className="pa-auth-stage">
          {skin === "shell" ? null : <img src="/img/early-access-agent-desk.webp" alt="" className="pa-auth-photo" />}

          <div className="pa-auth-card">
            <div className="pa-auth-head">
              <h1 className="pa-auth-title">{title}</h1>
              <p className="pa-auth-lede">{lede}</p>
            </div>
            {children}
          </div>
        </div>
      </div>
    </Root>
  );
}

/**
 * The two PIN screens: no card, no form, just the ask and six circles on the
 * ground.
 *
 * A card is a container for a form, and this is not one — it is one question
 * with one answer that submits itself. Taking the card away is also what lets
 * the row roll up into a ring without a box for the ring to sit inside, which
 * is the whole point of the shape.
 */
function Bare({
  skin,
  title,
  lede,
  children,
  leaving,
}: {
  skin: GateSkin;
  title: string;
  lede: string;
  children: ReactNode;
  /** The unlock is playing; everything that is not the ring gets out of its way. */
  leaving?: boolean;
}): ReactNode {
  return (
    <Root skin={skin}>
      <Masthead />
      <div className="pa-auth-body">
        <div className="pa-auth-bare" data-leaving={leaving === true ? "" : undefined}>
          <div className="pa-auth-head">
            <h1 className="pa-auth-title">{title}</h1>
            <p className="pa-auth-lede">{lede}</p>
          </div>
          {children}
        </div>
      </div>
    </Root>
  );
}

/** A labelled input. Both skins dress it; only the material differs. */
function Field({
  label,
  help,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string }): ReactNode {
  const id = props.id ?? `f-${label.toLowerCase().replace(/[^a-z]+/gu, "-")}`;
  return (
    <div className="pa-auth-field">
      <label htmlFor={id} className="pa-auth-label">
        {label}
      </label>
      <input {...props} id={id} className="pa-auth-input" />
      {help === undefined ? null : <p className="pa-auth-help">{help}</p>}
    </div>
  );
}

/* ---------------------------------- the PIN -------------------------------- */

/**
 * How long the row takes to roll up into a ring, how long the ring is left
 * standing, and how long it takes to turn and go.
 *
 * The second half is deliberately the slow one. A ring that has just closed is
 * the thing the reader was working towards, so it holds for a beat before it
 * moves at all, and then leaves over the better part of a second rather than
 * being whipped off. Nothing is waiting on it — the keys were open before the
 * first frame — so the only job left is to feel unhurried.
 */
/**
 * The roll-up is exactly as long as the unlock sound takes to reach its click.
 * Derived rather than chosen: the file is the fixed thing — its scrape, its
 * gap and its latch are already in a particular relationship — so the ring
 * closes when the latch bites because it is the same number, not because two
 * numbers were tuned until they looked close.
 */
const WRAP_MS = UNLOCK_CLICK_MS;
const HOLD_MS = 150;
const LEAVE_MS = 980;

/**
 * How long the row shakes on a wrong PIN, and where its two hardest throws
 * land. Both come from the buzz `playWrongSound` plays over them: that file
 * has two lobes, at roughly 50 ms and 155 ms, with the second the stronger,
 * and it is done at 520 ms. The motion is on the same beats, so what the
 * reader gets is one event rather than a shake and a noise.
 */
const SHAKE_MS = 520;

/** How far the ring turns on its way out. */
const LEAVE_TURN = 184;

/**
 * The curve the ring turns on.
 *
 * An S, not an ease-out, and that is the whole point: the ring has been
 * standing still for `HOLD_MS`, so it has to get moving from rest. An ease-out
 * from a standstill is a kick — the first frame is already at speed — and
 * three ease-outs chained end to end, which is what this was, is three kicks
 * with a near-stop between each: the ring lurched round instead of turning.
 * One curve over the whole distance, and there is nowhere left for it to stop.
 *
 * The words and the masthead keep their own ease-out in `auth.css`, where a
 * hard start to an opacity fade is not something anyone can see.
 */
const TURN = "cubic-bezier(0.4, 0, 0.2, 1)";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Six digits, six circles.
 *
 * One input per digit rather than one field with six boxes drawn behind it:
 * the caret then belongs to the digit the reader is on, `maxLength` does the
 * clamping, and every slot is its own tab stop, which is what a screen reader
 * and a keyboard both expect from something that looks like six controls. The
 * group carries the label; each slot says which of the six it is.
 *
 * `wrongAt` is a counter rather than a boolean because the interesting event
 * is a REPEAT: the second wrong PIN has to shake again, and a boolean that is
 * already `true` has no edge to fire on.
 */
export function PinPad({
  value,
  onChange,
  onComplete,
  label,
  disabled = false,
  wrongAt = 0,
  autoFocus = false,
  wrapping = false,
  onWrapped,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The sixth digit just landed. */
  onComplete?: (value: string) => void;
  label: string;
  disabled?: boolean;
  /** Bumped by the caller on every wrong answer; each bump shakes the row. */
  wrongAt?: number;
  autoFocus?: boolean;
  /** Roll the row up into a ring and spin it away. */
  wrapping?: boolean;
  onWrapped?: () => void;
}): ReactNode {
  const slots = useRef<Array<HTMLInputElement | null>>([]);
  const row = useRef<HTMLDivElement | null>(null);
  const orbit = useRef<HTMLDivElement | null>(null);
  const [wrong, setWrong] = useState(false);
  // Held in a ref so the animation effect can call the newest one without
  // listing it as a dependency and restarting the wrap mid-flight.
  const wrapped = useRef(onWrapped);
  wrapped.current = onWrapped;

  const focusSlot = (at: number): void => {
    const slot = slots.current[Math.max(0, Math.min(PIN_LENGTH - 1, at))];
    slot?.focus();
    slot?.select();
  };

  useEffect(() => {
    if (autoFocus && !disabled) focusSlot(0);
    // Fetched and decoded now, while there are six digits still to type, so
    // that playing one later is only a buffer being connected.
    preloadPinSounds();
    // Only on mount: stealing focus back later would fight the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, []);

  /* -------------------------------- the shake ------------------------------ */

  useEffect(() => {
    if (wrongAt === 0) return;
    setWrong(true);
    const clear = window.setTimeout(() => {
      setWrong(false);
    }, SHAKE_MS + 380);
    playWrongSound();
    const el = row.current;
    if (el !== null && !reducedMotion()) {
      // Offsets are the buzz file's own envelope: the throw at 0.09 is its
      // first lobe, the bigger one at 0.31 its second, and everything after is
      // the rattle dying out. WAAPI rather than a CSS class, because a repeat
      // has nothing to toggle.
      el.animate(
        [
          { offset: 0, transform: "translateX(0px)" },
          { offset: 0.09, transform: "translateX(-10px)" },
          { offset: 0.2, transform: "translateX(7px)" },
          { offset: 0.31, transform: "translateX(-13px)" },
          { offset: 0.42, transform: "translateX(9px)" },
          { offset: 0.55, transform: "translateX(-5px)" },
          { offset: 0.7, transform: "translateX(3px)" },
          { offset: 0.85, transform: "translateX(-1.5px)" },
          { offset: 1, transform: "translateX(0px)" },
        ],
        { duration: SHAKE_MS, easing: "linear" },
      );
    }
    focusSlot(0);
    return () => {
      window.clearTimeout(clear);
    };
  }, [wrongAt]);

  /* -------------------------------- the wrap ------------------------------- */

  useEffect(() => {
    if (!wrapping) return;
    // The right answer, as a sound. The file carries its own two halves — the
    // scrape under the roll-up, the click where the ring closes — so there is
    // nothing to schedule here beyond starting it on the same frame as the
    // animation. It plays whether or not the motion below is allowed to.
    playUnlockSound();
    const boxes = slots.current.filter((slot): slot is HTMLInputElement => slot !== null);
    // A focused field is a field whose caret and selection the browser keeps
    // recomputing as it moves. Nothing is going to be typed into these again.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const line = row.current;
    const ring = orbit.current;
    const done = (): void => {
      wrapped.current?.();
    };

    if (boxes.length < 2 || line === null || ring === null || reducedMotion()) {
      const skip = window.setTimeout(done, 160);
      return () => {
        window.clearTimeout(skip);
      };
    }

    // Centre-to-centre, measured rather than assumed: the circles are sized in
    // `clamp()` against the viewport, so only the live layout knows the pitch
    // that makes the finished ring close on itself.
    const first = boxes[0]!.getBoundingClientRect();
    const second = boxes[1]!.getBoundingClientRect();
    const pitch = second.left + second.width / 2 - (first.left + first.width / 2);
    const motion = wrapIntoRing({ count: boxes.length, pitch });

    const options: KeyframeAnimationOptions = {
      duration: WRAP_MS,
      // The ease is already baked into the sampled wrap, so the timeline
      // between samples must not add a second one.
      easing: "linear",
      fill: "forwards",
      // Every keyframe is transform-only, so the whole wrap can be handed to
      // the compositor and never touch layout or paint again.
      composite: "replace",
    };
    const running = boxes.map((box, i) =>
      box.animate((motion.boxes[i] ?? []).map((transform) => ({ transform })), options),
    );
    running.push(line.animate(motion.group.map((transform) => ({ transform })), options));

    // Turn and bloom, as ONE move: two keyframes, one curve, no waypoints in
    // between for the velocity to have a corner at. The scale never drops
    // below 1 — shrinking to a point reads as something being taken away, and
    // this is the opposite, the ring opening onto what is behind it.
    const start = WRAP_MS + HOLD_MS;
    const turn = ring.animate(
      [
        { transform: "rotate(0deg) scale(1)" },
        { transform: `rotate(${String(LEAVE_TURN)}deg) scale(1.2)` },
      ],
      { duration: LEAVE_MS, delay: start, easing: TURN, fill: "forwards" },
    );
    // Fading is its own animation because it wants its own timing: the ring
    // holds full strength while it gets going and only then goes. Riding the
    // turn's curve would have it half gone before it had moved.
    const fade = ring.animate(
      [
        { opacity: 1, offset: 0, easing: "linear" },
        { opacity: 1, offset: 0.34, easing: "cubic-bezier(0.4, 0, 0.9, 1)" },
        { opacity: 0, offset: 1 },
      ],
      { duration: LEAVE_MS, delay: start, fill: "forwards" },
    );
    running.push(turn, fade);
    turn.addEventListener("finish", done);

    return () => {
      turn.removeEventListener("finish", done);
      for (const animation of running) animation.cancel();
    };
  }, [wrapping]);

  /* ------------------------------- the typing ------------------------------ */

  /**
   * The value is a dense string, and stays one: focus is clamped to the first
   * empty slot below, so `at` is never past the end and a digit can only ever
   * replace one that is there or extend the run by one. That is what makes a
   * hole in the middle impossible rather than merely unlikely.
   */
  const put = (at: number, digit: string): void => {
    if (digit === "") return;
    const next = `${value.slice(0, at)}${digit}${value.slice(at + 1)}`.slice(0, PIN_LENGTH);
    onChange(next);
    if (at < PIN_LENGTH - 1) focusSlot(at + 1);
    if (next.length === PIN_LENGTH) {
      // Still inside the keystroke, which is the only moment a browser will
      // let audio start. Whether there is anything to play is decided a second
      // later, by which time this gesture is long over.
      primeUnlockSound();
      onComplete?.(next);
    }
  };

  const onSlotKeyDown = (at: number) => (event: KeyboardEvent<HTMLInputElement>): void => {
    // Backspace takes the last digit, wherever the caret is. With focus
    // clamped to the end of the run that is the slot the reader is looking at,
    // and it is the one rule that cannot leave a gap behind.
    if (event.key === "Backspace") {
      event.preventDefault();
      if (value === "") return;
      onChange(value.slice(0, -1));
      focusSlot(value.length - 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusSlot(at - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusSlot(Math.min(at + 1, value.length));
    }
  };

  const onSlotPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = sanitizePinInput(event.clipboardData.getData("text"));
    if (pasted === "") return;
    event.preventDefault();
    onChange(pasted);
    focusSlot(pasted.length);
    if (pasted.length === PIN_LENGTH) {
      primeUnlockSound();
      onComplete?.(pasted);
    }
  };

  return (
    <div className="pa-pin-stage">
      <div className="pa-pin-orbit" ref={orbit}>
        <div
          className="pa-pin"
          ref={row}
          role="group"
          aria-label={label}
          data-wrong={wrong ? "" : undefined}
          data-wrapping={wrapping ? "" : undefined}
        >
          {Array.from({ length: PIN_LENGTH }, (_, at) => (
            <input
              key={at}
              ref={(el) => {
                slots.current[at] = el;
              }}
              className="pa-pin-slot"
              inputMode="numeric"
              autoComplete={at === 0 ? "one-time-code" : "off"}
              // A pattern and a numeric mode, not `type="number"`: spinners and
              // locale grouping have no business in a keypad.
              pattern="[0-9]*"
              maxLength={1}
              // One space, drawn as nothing: it exists so `:placeholder-shown`
              // can tell an empty circle from a filled one in CSS alone.
              placeholder=" "
              aria-label={`Digit ${String(at + 1)} of ${String(PIN_LENGTH)}`}
              disabled={disabled}
              readOnly={wrapping}
              tabIndex={wrapping ? -1 : undefined}
              value={value[at] ?? ""}
              onChange={(event) => {
                put(at, sanitizePinInput(event.target.value).slice(-1));
              }}
              onKeyDown={onSlotKeyDown(at)}
              onPaste={onSlotPaste}
              // The clamp lives on the POINTER, not on focus. Auto-advance
              // focuses the next slot before React has re-rendered with the
              // digit that was just typed, so a focus handler would still be
              // reading the old value, decide the slot is past the end, and
              // bounce focus back to where it came from — every keystroke
              // landing in the first circle. A click is the only focus that
              // needs clamping, and this is the only handler that sees just
              // those.
              onPointerDown={(event) => {
                if (at <= value.length) return;
                event.preventDefault();
                focusSlot(value.length);
              }}
              onFocus={(event) => {
                event.target.select();
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The one control on this page that trades security for convenience, so it
 * says what it costs rather than only what it saves.
 *
 * It asks for nothing here. Turning it on means the session lands on the PIN
 * screen once the password has actually worked (`set-pin`), which is both a
 * better order — nobody picks six digits for a password that turns out to be
 * wrong — and a shorter label, because the screen that asks can explain
 * itself.
 */
function StayUnlocked({
  checked,
  onChange,
  disabled,
  skin,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  skin: GateSkin;
}): ReactNode {
  return (
    <label className="pa-auth-remember">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="pa-auth-check"
      />
      {/* The site paints its tick into the box as an image; the shell skin
          needs one that takes a colour, because the fill it sits on is the
          theme's high-contrast gray and which end of the ramp that is depends
          on the theme. So it is a mask over the box, and only the skin that
          uses it renders it. */}
      {skin === "shell" ? <span aria-hidden="true" className="pa-auth-tick" /> : null}
      <span className="pa-auth-remember-text">
        <span className="pa-auth-remember-title">Stay unlocked on this browser</span>
        <span className="pa-auth-remember-note">
          Come back with a PIN instead of your password for {REMEMBER_DAYS} days. Leave it off on a shared computer.
        </span>
      </span>
    </label>
  );
}

/** Anything that went wrong, in the one warm colour the site keeps for it. */
function Alert({ children }: { children: ReactNode }): ReactNode {
  return (
    <p role="alert" className="pa-auth-alert">
      {children}
    </p>
  );
}

/** Who this browser is signed in as. */
function Whoami({ email }: { email: string }): ReactNode {
  return <p className="pa-auth-whoami">Signed in as {email}</p>;
}

/** A quiet action that reads as prose rather than a second call to action. */
function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button type="button" onClick={onClick} className="pa-auth-textbutton">
      {children}
    </button>
  );
}

export function SignIn({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { signIn, busy, error, vaultError } = useSession();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // Nowhere to go afterwards, on either site. A new account created on the
    // browser app is already standing at `/`, where its walkthrough is waiting
    // (§14, §15); one created on the dashboard is standing on the dashboard,
    // which offers the browser in its nav.
    void signIn(email.trim(), password, mode, keep);
  };

  return (
    <Frame
      skin={skin}
      title={mode === "sign-in" ? "Sign in" : "Create an account"}
      lede="Your password unlocks your sessions and records in this browser. It is never sent anywhere that could read them."
    >
      <form onSubmit={submit} className="pa-auth-form">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          required
          minLength={8}
          help={mode === "sign-up" ? "At least 8 characters. There is no way to recover data if you forget it." : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <StayUnlocked checked={keep} onChange={setKeep} disabled={busy} skin={skin} />
        {error === null ? null : <Alert>{error}</Alert>}
        {vaultError === null ? null : <Alert>{vaultError}</Alert>}
        <button type="submit" className="pa-auth-submit" disabled={busy}>
          {busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
          <ArrowRight />
        </button>
        <p className="pa-auth-switch">
          {mode === "sign-in" ? "No account yet? " : "Already have one? "}
          <TextButton
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            }}
          >
            {mode === "sign-in" ? "Create an account" : "Sign in"}
          </TextButton>
        </p>
      </form>
    </Frame>
  );
}

/** A pre-web account with no wrappers can finish setup in this browser. */
export function NotSetUp({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { unlockWith, signOut, account, busy, error, remembered } = useSession();
  const [password, setPassword] = useState("");
  const [keep, setKeep] = useState(remembered);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    // The one place that may create this account's root secrets. Unlock never
    // does: with no wrapper to check the password against, a typo there would
    // quietly become the password every future device has to know.
    void unlockWith(password, keep, { setUpEncryption: true });
  };

  return (
    <Frame
      skin={skin}
      title="Set up encryption"
      lede="This account has no keys yet. This browser can create them now, seal them with your account password, and turn on your cloud agent—no desktop app needed. Anything already sealed under an earlier password stays unreadable, so use the password you sign in with."
    >
      <form onSubmit={submit} className="pa-auth-form">
        {account === null ? null : <Whoami email={account.email} />}
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <StayUnlocked checked={keep} onChange={setKeep} disabled={busy} skin={skin} />
        {error === null ? null : <Alert>{error}</Alert>}
        <button type="submit" className="pa-auth-submit" disabled={busy}>
          {busy ? "Setting up…" : "Set up encryption"}
          <ArrowRight />
        </button>
        <p className="pa-auth-switch">
          Wrong account?{" "}
          <TextButton
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </TextButton>
        </p>
      </form>
    </Frame>
  );
}

export function Unlock({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { unlockWith, signOut, busy, error, account, remembered } = useSession();
  const [password, setPassword] = useState("");
  // A reader who asked to stay unlocked and is being asked anyway — a new
  // Space, an expired record — should not have to ask twice. A fresh PIN is
  // asked for on the way through: the old record is about to be replaced.
  const [keep, setKeep] = useState(remembered);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void unlockWith(password, keep);
  };

  return (
    <Frame
      skin={skin}
      title="Unlock"
      lede="This browser is signed in, but the keys that read your data are only ever held in memory, so a reload forgets them."
    >
      <form onSubmit={submit} className="pa-auth-form">
        {account === null ? null : <Whoami email={account.email} />}
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <StayUnlocked checked={keep} onChange={setKeep} disabled={busy} skin={skin} />
        {error === null ? null : <Alert>{error}</Alert>}
        <button type="submit" className="pa-auth-submit" disabled={busy}>
          {busy ? "Unlocking…" : "Unlock"}
          <ArrowRight />
        </button>
        <p className="pa-auth-switch">
          Not you?{" "}
          <TextButton
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </TextButton>
        </p>
      </form>
    </Frame>
  );
}

/**
 * Choosing the PIN, once the password has already worked.
 *
 * The session behind this screen is open — the keys came out of the password a
 * moment ago and are being held back on purpose — so this asks for one thing
 * and nothing else. Twice, because six digits typed once is six digits nobody
 * has checked they can reproduce, and getting it wrong here means a browser
 * that can never be unlocked with the PIN its owner thinks they set.
 */
export function PinSetup({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { setSessionPin, finishPinUnlock, state } = useSession();
  const [entry, setEntry] = useState("");
  const [first, setFirst] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [mismatch, setMismatch] = useState(0);
  // The confirmed digits are still in the pad, which is the point: the circles
  // that roll up into the ring are the ones the reader just filled.
  const unlocking = state === "unlocking";

  const restart = (): void => {
    setEntry("");
    setFirst("");
    setConfirming(false);
  };

  return (
    <Bare
      skin={skin}
      leaving={unlocking}
      // The copy does NOT change when the unlock starts. It is already fading
      // out on the frame it would change, so nobody reads the new words — and
      // two lines of copy are not two lines of the same height, which moved
      // the keypad down as it began to animate.
      title={confirming ? "Enter it again" : "Choose a PIN"}
      lede={
        confirming
          ? "Same six digits, so this browser knows you can reproduce them."
          : `Six digits seal this session into this browser for ${String(REMEMBER_DAYS)} days. It is what you will type instead of your password.`
      }
    >
      <PinPad
        key={confirming ? "confirm" : "choose"}
        label={confirming ? "Confirm your PIN" : "Choose a PIN"}
        value={entry}
        wrongAt={mismatch}
        wrapping={unlocking}
        onWrapped={finishPinUnlock}
        autoFocus
        onChange={setEntry}
        onComplete={(value) => {
          if (!confirming) {
            setFirst(value);
            setEntry("");
            setConfirming(true);
            return;
          }
          if (value === first) {
            setSessionPin(value);
            return;
          }
          // Both halves go, not just the second: a reader who mistyped does
          // not know which of the two was the mistake.
          setMismatch((count) => count + 1);
          restart();
        }}
      />
      <Tail hidden={unlocking}>
        <p className="pa-auth-pinnote">
          {mismatch > 0 && !confirming
            ? "Those did not match. Start again."
            : `Six digits is a small secret, so ${String(MAX_PIN_ATTEMPTS)} wrong tries forget these keys and ask for your password instead.`}
        </p>
        <p className="pa-auth-switch">
          Rather not?{" "}
          <TextButton
            onClick={() => {
              // The keys are already open; declining only means this browser
              // keeps nothing, which is exactly what the unchecked box would
              // have done.
              finishPinUnlock();
            }}
          >
            Skip and ask for my password next time
          </TextButton>
        </p>
      </Tail>
    </Bare>
  );
}

/**
 * Which of the two PIN screens is up.
 *
 * `unlocking` belongs to whichever one took the digits — the ring that rolls
 * up has to be made of the circles the reader just filled, and handing the
 * state to the other screen would spin six empty ones. The apps route all
 * three states here rather than reproducing that rule twice.
 */
export function PinGate({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { state } = useSession();
  // Written during render, which is safe because it is a pure function of the
  // state this render is for: `unlocking` never arrives first, so there is
  // always a screen to have come from.
  const from = useRef<"pin" | "set-pin">("pin");
  if (state === "pin" || state === "set-pin") from.current = state;
  return (state === "unlocking" ? from.current : state) === "set-pin" ? (
    <PinSetup skin={skin} />
  ) : (
    <PinLock skin={skin} />
  );
}

/**
 * Coming back to a browser that kept this session.
 *
 * The password is not asked for because it is not needed: what stands between
 * the reader and their keys is six digits and a PBKDF2 pass, both of them
 * here. That also means there is nothing to rate-limit from a server, so the
 * count of what is left is on the screen — it is the only thing standing
 * between a guesser and the record, and hiding it would not slow them down,
 * only surprise the person whose last try it was.
 */
export function PinLock({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  const { unlockWithPin, finishPinUnlock, forgetPin, signOut, account, pinAttemptsLeft, state, busy, error } =
    useSession();
  const [pin, setPin] = useState("");
  const [wrongAt, setWrongAt] = useState(0);
  const unlocking = state === "unlocking";

  const attempt = useCallback(
    (value: string): void => {
      void unlockWithPin(value).then((ok) => {
        if (ok) return;
        setPin("");
        setWrongAt((count) => count + 1);
      });
    },
    [unlockWithPin],
  );

  const left = pinAttemptsLeft;

  return (
    <Bare
      skin={skin}
      leaving={unlocking}
      // Stable across the unlock, for the reason `PinSetup` gives above.
      title="Enter your PIN"
      lede="This browser is holding your keys, sealed under the PIN you chose."
    >
      <PinPad
        label="Your PIN"
        value={pin}
        onChange={setPin}
        onComplete={attempt}
        disabled={busy}
        wrongAt={wrongAt}
        wrapping={unlocking}
        onWrapped={finishPinUnlock}
        autoFocus
      />
      <Tail hidden={unlocking}>
        {wrongAt === 0 ? null : (
          // Red from the first miss, and a filled block once it is nearly
          // out of tries: a wrong PIN is always a failure worth seeing, and
          // the last two are worth stopping at.
          <p role="alert" className={left !== null && left <= 2 ? "pa-auth-alert" : "pa-auth-pinwarn"}>
            {left === null
              ? "That PIN did not open this browser's keys."
              : left === 1
                ? "Wrong PIN. One more and these keys are forgotten."
                : `Wrong PIN. ${String(left)} tries left of ${String(MAX_PIN_ATTEMPTS)}.`}
          </p>
        )}
        {error === null ? null : <Alert>{error}</Alert>}
        <p className="pa-auth-switch">
          {account === null ? null : <>{account.email} &middot; </>}
          <TextButton
            onClick={() => {
              void forgetPin();
            }}
          >
            Use your password
          </TextButton>
          {" · "}
          <TextButton
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </TextButton>
        </p>
      </Tail>
    </Bare>
  );
}

export function Loading({ skin = "site" }: { skin?: GateSkin } = {}): ReactNode {
  return (
    <Root skin={skin}>
      <Masthead />
      <div className="pa-auth-wait">
        <p>Checking this browser…</p>
      </div>
    </Root>
  );
}
