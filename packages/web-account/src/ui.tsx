"use client";

/**
 * The small set of primitives every page in the signed-in app is built from.
 *
 * Deliberately few: spacing, alignment and type carry the hierarchy, so there
 * is no card, no panel, and no badge for ordinary metadata. A boundary appears
 * only where something is genuinely grouped or interactive.
 */

import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

export function Page({ children }: { children: ReactNode }): ReactNode {
  return <div className="pa-page">{children}</div>;
}

/** The one h1 on the page, with the sentence that orients the reader. */
export function Intro({ title, lede }: { title: string; lede?: string }): ReactNode {
  return (
    <div className="pa-intro">
      <h1 className="pa-title">{title}</h1>
      {lede === undefined ? null : <p className="pa-lede">{lede}</p>}
    </div>
  );
}

export function Section({
  heading,
  note,
  action,
  children,
}: {
  heading?: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="pa-section">
      {heading === undefined ? null : (
        <div className="pa-row">
          <h2 className="pa-heading-16">{heading}</h2>
          {action}
        </div>
      )}
      {note === undefined ? null : <p className="pa-caption">{note}</p>}
      {children}
    </section>
  );
}

export function Button({
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "quiet" | "alert" }): ReactNode {
  return <button {...props} className="pa-btn" data-variant={variant} />;
}

export function Field({
  label,
  help,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string }): ReactNode {
  // A generated id, never one derived from the label: two rows that share a
  // label ("Value", "Value") would otherwise share an id, and every label
  // would focus and name the first input.
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className="pa-field">
      <label htmlFor={id}>{label}</label>
      {help === undefined ? null : <span className="pa-help">{help}</span>}
      <input {...props} id={id} className="pa-input" />
    </div>
  );
}

export function TextArea({
  label,
  help,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; help?: string }): ReactNode {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className="pa-field">
      <label htmlFor={id}>{label}</label>
      {help === undefined ? null : <span className="pa-help">{help}</span>}
      <textarea {...props} id={id} className="pa-textarea" />
    </div>
  );
}

/** A single setting the reader turns on or off, with what it costs underneath. */
export function Checkbox({
  checked,
  help,
  label,
  onChange,
}: {
  checked: boolean;
  help?: string;
  label: string;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="pa-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        <span className="pa-label">{label}</span>
        {help === undefined ? null : <span className="pa-help">{help}</span>}
      </span>
    </label>
  );
}

/**
 * `detail` is the diagnostics line behind an error — the wire-level status
 * and code — kept out of the sentence the reader sees and behind a
 * disclosure, so the headline stays plain and support still has the code.
 */
export function Note({
  tone = "plain",
  detail,
  children,
}: {
  tone?: "plain" | "alert";
  detail?: string | null;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="pa-note" data-tone={tone} role={tone === "alert" ? "alert" : undefined}>
      {children}
      {detail == null ? null : (
        <details className="pa-note-detail">
          <summary>Details</summary>
          <code>{detail}</code>
        </details>
      )}
    </div>
  );
}

/** What is here instead of a list, and what the reader can do about it. */
export function Empty({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="pa-empty">
      <p className="pa-heading-16">{title}</p>
      {children === undefined ? null : <div className="pa-body">{children}</div>}
    </div>
  );
}

export function Status({ tone, children }: { tone?: "good" | "alert"; children: ReactNode }): ReactNode {
  return (
    <span className="pa-status">
      <span className="pa-dot" data-tone={tone} />
      {children}
    </span>
  );
}

/** A semantic table. Numeric columns are right-aligned and tabular by class. */
export function Table({ caption, head, children }: { caption: string; head: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="pa-table-wrap">
      <table className="pa-table">
        <caption>{caption}</caption>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Absolute time in the reader's own zone, with the machine-readable value kept. */
export function When({ iso, relative = false }: { iso: string | null; relative?: boolean }): ReactNode {
  if (iso === null) return <span className="pa-caption">never</span>;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="pa-caption">unknown</span>;
  const text = relative ? describeGap(date) : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <time dateTime={iso} className="pa-num" title={date.toLocaleString()}>
      {text}
    </time>
  );
}

function describeGap(date: Date): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [seconds, "second"]
      : abs < 3600
        ? [Math.round(seconds / 60), "minute"]
        : abs < 86_400
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
}
