"use client";

import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { CredentialCapture } from "@pistachio/web-account/credential-capture";
import { BrandMark } from "../primitives";

function CaptureShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="credential-page">
      <h1 className="sr-only">Secure information handoff</h1>
      <header className="credential-brand">
        <Link
          href="/app"
          aria-label="Pistachio home"
          className="credential-wordmark"
        >
          <BrandMark name="pistachio-mark" className="credential-mark" />
          <span>Pistachio</span>
        </Link>
        <span className="credential-secure-chip">
          <LockKeyhole aria-hidden="true" /> Secure handoff
        </span>
      </header>
      <div className="credential-stage">{children}</div>
      <footer className="credential-footer">
        Pistachio never adds these values to the agent conversation.
      </footer>
    </main>
  );
}

export function CredentialCapturePage({
  captureId,
}: {
  captureId: string;
}): ReactNode {
  return (
    <CaptureShell>
      <CredentialCapture captureId={captureId} />
    </CaptureShell>
  );
}
