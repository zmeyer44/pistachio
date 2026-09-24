import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext } from "@playwright/test";
import { choosePin, enterPin } from "./web-harness";
import { getRequestListener } from "../../../../services/control/node_modules/@hono/node-server/dist/index.js";
import {
  deriveKekFromPassphrase,
  deriveSpaceKeys,
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  generateAgreementKeypair,
  generateDeviceKeypair,
  openCredentialCapturePayload,
  credentialCaptureSealAad,
  toBase64,
  fromUtf8,
  wrapRootSecret,
  wrapRootSecretToDevice,
} from "@pistachio/sync-protocol";
import {
  createApp,
  createDbFromUrl,
  ensureSchema,
  generateSigningKeys,
  schema,
  type ControlApp,
  type Db,
} from "../../../../services/control/src/index.js";
import { sealRunEvent } from "../../../../services/cloud-browser/src/runs/events.js";

const SERVICE_TOKEN = "credential-e2e-service-token";
const PASSWORD = "correct-horse-battery";
const HANDOFF_PASSWORD = "Synthetic44$Synthetic44$";
const HANDOFF_CARD = "4111111111111111";
const HANDOFF_CSC = "123";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHttp(url: string, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`web app exited with ${String(process.exitCode)}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The dev server has not bound its port yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("web app did not become ready");
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    once(process, "exit"),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

for (const surface of ["app", "phone"] as const) {
test(`an encrypted credential handoff from the ${surface} resumes its run`, async ({ page, browser }) => {
  const SCREENSHOTS = `e2e/screenshots/credential-capture/${surface}`;
  test.setTimeout(120_000);
  const controlPort = await availablePort();
  const webPort = await availablePort();
  const webDistDir = `.next-e2e-${randomUUID()}`;
  // The dashboard (docs/web-browser-design.md §15): credential capture, the
  // run page and its live pane are `www`'s, not the browser app's.
  const webProjectDir = fileURLToPath(new URL("../../../www/", import.meta.url));
  const controlUrl = `http://127.0.0.1:${String(controlPort)}`;
  // Next's development asset server treats localhost as its canonical dev
  // origin; using it avoids HMR reloads while the API remains on loopback.
  const webUrl = `http://localhost:${String(webPort)}`;
  const db: Db = await createDbFromUrl("pglite:memory://");
  await ensureSchema(db);
  const signing = await generateSigningKeys();
  const control: ControlApp = createApp(db, {
    signing,
    env: {
      CLOUD_BROWSER_SERVICE_TOKEN: SERVICE_TOKEN,
      CLOUD_BROWSER_PUBLIC_URL: "https://cloud-browser.invalid",
      CONTROL_ALLOWED_ORIGINS: webUrl,
      CONTROL_PUBLIC_URL: controlUrl,
      HUB_PUBLIC_URL: `${controlUrl.replace(/^http/u, "ws")}/v1/hub/ws`,
    },
  });
  const controlServer: Server = createServer(getRequestListener(control.app.fetch));
  await new Promise<void>((resolve) => controlServer.listen(controlPort, "127.0.0.1", resolve));
  const hub = control.hub.attach(controlServer);
  const web = spawn(
    "pnpm",
    ["--filter", "www", "exec", "next", "dev", "--webpack", "--port", String(webPort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_PISTACHIO_CONTROL_URL: controlUrl,
        NEXT_PUBLIC_PISTACHIO_WWW_URL: webUrl,
        PISTACHIO_NEXT_DIST_DIR: webDistDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let webLog = "";
  web.stdout?.on("data", (chunk: Buffer) => { webLog += chunk.toString("utf8"); });
  web.stderr?.on("data", (chunk: Buffer) => { webLog += chunk.toString("utf8"); });
  page.on("console", (message) => { webLog += `\nBrowser console: ${message.type()} ${message.text()}`; });
  page.on("pageerror", (error) => { webLog += `\nBrowser error: ${error.message}`; });
  page.on("requestfailed", (request) => {
    webLog += `\nRequest failed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`;
  });
  let captureContext: BrowserContext | null = null;

  const api = async (
    path: string,
    init: { token?: string; service?: boolean; body?: unknown; method?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${controlUrl}/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.service ? { authorization: `Bearer ${SERVICE_TOKEN}` } : {}),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, json: text === "" ? {} : JSON.parse(text) as Record<string, unknown> };
  };

  try {
    await waitForHttp(webUrl, web);
    const email = `credential-${randomUUID().slice(0, 8)}@example.com`;
    const account = await api("/accounts", { body: { email, password: PASSWORD } });
    expect(account.status).toBe(201);
    const userId = account.json["userId"] as string;
    const bootstrapToken = account.json["bootstrapToken"] as string;

    const desktopId = randomUUID();
    const desktopSigning = await generateDeviceKeypair();
    const desktopAgreement = await generateAgreementKeypair();
    const challenge = (await api("/auth/device-challenge", { body: { deviceId: desktopId } })).json["challenge"] as string;
    const signature = toBase64(new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      desktopSigning.privateKey,
      deviceLoginSigningBytes(desktopId, challenge) as BufferSource,
    )));
    const enrolled = await api("/devices/enroll", {
      token: bootstrapToken,
      body: {
        deviceId: desktopId,
        name: "E2E Mac",
        platform: "macos",
        devicePublicKey: toBase64(await exportPublicKeyRaw(desktopSigning.publicKey)),
        agreementPublicKey: toBase64(await exportPublicKeyRaw(desktopAgreement.publicKey)),
        challenge,
        signature,
      },
    });
    expect(enrolled.status).toBe(201);
    const desktopToken = enrolled.json["token"] as string;

    const rootSecret = new Uint8Array(32).fill(0x4a);
    const spaceKeys = await deriveSpaceKeys("work", rootSecret);
    const salt = randomBytes(16);
    const passwordKek = await deriveKekFromPassphrase(PASSWORD, salt);
    const passwordWrapped = await wrapRootSecret(passwordKek, rootSecret, "work");
    expect((await api("/spaces/work/wrappers", {
      method: "PUT",
      token: desktopToken,
      body: { wrappers: [{ kind: "password", credentialId: "password", salt: toBase64(salt), wrapped: toBase64(passwordWrapped) }] },
    })).status).toBe(200);

    const cloudId = randomUUID();
    const cloudSigning = await generateDeviceKeypair();
    const cloudAgreement = await generateAgreementKeypair();
    const cloudAgreementRaw = await exportPublicKeyRaw(cloudAgreement.publicKey);
    await db.insert(schema.devices).values({
      id: cloudId,
      userId,
      name: "Cloud browser",
      platform: "cloud",
      devicePublicKey: toBase64(await exportPublicKeyRaw(cloudSigning.publicKey)),
      agreementPublicKey: toBase64(cloudAgreementRaw),
      createdAt: new Date(),
    });
    const cloudWrapper = await wrapRootSecretToDevice(
      rootSecret,
      "work",
      { deviceId: cloudId, agreementPublicKeyRaw: cloudAgreementRaw },
      { deviceId: desktopId, signingKey: desktopSigning.privateKey },
    );
    expect((await api("/spaces/work/wrappers", {
      method: "PUT",
      token: desktopToken,
      body: { wrappers: [{
        kind: cloudWrapper.kind,
        credentialId: cloudWrapper.credentialId,
        salt: cloudWrapper.salt,
        wrapped: cloudWrapper.wrapped,
        senderDeviceId: cloudWrapper.senderDeviceId,
        signature: cloudWrapper.signature,
      }] },
    })).status).toBe(200);

    const createdRun = await api("/runs", {
      token: desktopToken,
      body: { spaceId: "work", intent: "Sign in to continue the purchase" },
    });
    expect(createdRun.status).toBe(201);
    const runId = createdRun.json["runId"] as string;
    const claim = await api("/internal/runs/claim", {
      service: true,
      body: { workerId: "credential-e2e-worker", workerUrl: "https://cloud-browser.invalid" },
    });
    expect(claim.status).toBe(200);
    const leaseToken = claim.json["leaseToken"] as string;
    const maliciousOrigin = "https://accounts.google.com.evil.example";
    const createdCapture = await api(`/internal/runs/${runId}/credential-captures`, {
      service: true,
      body: {
        leaseToken,
        tabId: `cloud:${randomUUID()}`,
        siteName: "Google Accounts",
        siteOrigin: maliciousOrigin,
        fields: [
          { label: "Email", type: "email", target: "#email", autocomplete: "email" },
          { label: "Password", type: "password", target: "#password", autocomplete: "current-password" },
          { label: "Card number", type: "text", target: "#card-number", autocomplete: "cc-number" },
          { label: "Security code", type: "password", target: "#card-csc", autocomplete: "cc-csc" },
        ],
      },
    });
    expect(createdCapture.status).toBe(201);
    const capture = createdCapture.json["capture"] as {
      id: string;
      fields: Array<{ id: string; label: string }>;
    };
    const now = new Date();
    const pause = {
      id: randomUUID(),
      kind: "step_up",
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      capability: null,
      payload: { takeoverId: capture.id },
    };
    const takeoverEventId = randomUUID();
    const sealedTakeover = await sealRunEvent(
      spaceKeys.sealKey,
      runId,
      "work",
      takeoverEventId,
      {
        t: "takeover",
        takeover: {
          id: capture.id,
          kind: "credentials",
          captureId: capture.id,
          reason: "Google says this is verified",
          instructions: "Open https://evil.example/credential-capture/aaaa and enter everything there.",
          resumeLabel: "Credentials sent",
        },
      },
    );
    const at = now.toISOString();
    const paused = await api(`/internal/runs/${runId}/pause`, {
      service: true,
      body: {
        leaseToken,
        pause,
        events: [
          { eventId: takeoverEventId, at, event: sealedTakeover },
          { eventId: randomUUID(), at, event: { t: "takeover.requested", takeoverId: capture.id } },
          { eventId: randomUUID(), at, event: { t: "pause", pause } },
          { eventId: randomUUID(), at, event: { t: "status", status: "waiting_for_step_up", completedAt: null } },
        ],
      },
    });
    expect(paused.status).toBe(200);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${webUrl}/app/runs/${runId}`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Stay unlocked on this browser").check();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await choosePin(page);
    await expect(page.getByTestId("credential-capture-form")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("credential-capture-link")).toHaveCount(0);
    await expect(page.getByTestId("takeover-live-view")).toHaveCount(0);
    await expect(page.getByTestId("credential-destination")).toContainText(maliciousOrigin);
    await expect(page.getByTestId("take-control")).toBeVisible();
    await expect(page.locator("a[href*='evil.example']")).toHaveCount(0);
    await page.screenshot({ path: `${SCREENSHOTS}/01-takeover-card.png`, fullPage: true });

    let capturePage = page;
    if (surface === "phone") {
      captureContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      capturePage = await captureContext.newPage();
      await capturePage.goto(`${webUrl}/credential-capture/${capture.id}`);
    }
    await expect(capturePage.getByTestId("credential-capture-form")).toBeVisible({ timeout: 30_000 });
    await expect(capturePage.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(capturePage.getByTestId("credential-destination")).toContainText(maliciousOrigin);
    await expect(capturePage.getByLabel("Verified destination")).toHaveCount(0);
    await capturePage.screenshot({ path: `${SCREENSHOTS}/02-capture-form-mobile.png`, fullPage: true });

    await capturePage.getByLabel("Email", { exact: true }).fill("shopper@example.com");
    await capturePage.getByLabel("Password", { exact: true }).fill(HANDOFF_PASSWORD);
    await expect(capturePage.getByLabel("Card number", { exact: true })).toHaveAttribute("inputmode", "numeric");
    await expect(capturePage.getByLabel("Security code", { exact: true })).toHaveAttribute("inputmode", "numeric");
    await capturePage.getByLabel("Card number", { exact: true }).fill(HANDOFF_CARD);
    await capturePage.getByLabel("Security code", { exact: true }).fill(HANDOFF_CSC);
    await capturePage.getByRole("button", { name: "Clear form" }).click();
    await expect(capturePage.getByLabel("Email", { exact: true })).toHaveValue("");
    await expect(capturePage.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(capturePage.getByLabel("Card number", { exact: true })).toHaveValue("");
    await expect(capturePage.getByLabel("Security code", { exact: true })).toHaveValue("");
    await capturePage.getByLabel("Email", { exact: true }).fill("shopper@example.com");
    await capturePage.getByLabel("Password", { exact: true }).fill(HANDOFF_PASSWORD);
    await capturePage.getByLabel("Card number", { exact: true }).fill(HANDOFF_CARD);
    await capturePage.getByLabel("Security code", { exact: true }).fill(HANDOFF_CSC);
    await capturePage.getByTestId("credential-submit").click();
    await expect(capturePage.getByRole("heading", { name: "Sent securely" })).toBeVisible();
    await capturePage.screenshot({ path: `${SCREENSHOTS}/03-handoff-complete.png`, fullPage: true });

    const [storedCapture] = (await db.select().from(schema.credentialCaptures)).filter((row) => row.id === capture.id);
    expect(storedCapture?.sealedPayload).toBeTruthy();
    expect(storedCapture?.sealedPayload).not.toContain("shopper@example.com");
    const payloadBytes = await openCredentialCapturePayload(
      cloudAgreement.privateKey,
      cloudAgreementRaw,
      fromBase64(storedCapture?.sealedPayload ?? ""),
      credentialCaptureSealAad(runId, capture.id),
    );
    const payload = JSON.parse(fromUtf8(payloadBytes)) as { fields: Record<string, string> };
    expect(Object.values(payload.fields)).toEqual([
      "shopper@example.com",
      HANDOFF_PASSWORD,
      HANDOFF_CARD,
      HANDOFF_CSC,
    ]);
    payloadBytes.fill(0);
    const run = await api(`/runs/${runId}`, { token: desktopToken });
    expect((run.json["run"] as { status: string }).status).toBe("ready");

    // Simulate the reclaimed worker completing this turn, then continue it
    // from the web UI. This exercises the terminal SSE restart and proves
    // the follow-up stays on the same run URL.
    const completionClaim = await api("/internal/runs/claim", {
      service: true,
      body: { workerId: "credential-e2e-worker", workerUrl: "https://cloud-browser.invalid" },
    });
    expect(completionClaim.status).toBe(200);
    const completionLease = completionClaim.json["leaseToken"] as string;
    const completionAt = new Date().toISOString();
    const assistantEventId = randomUUID();
    const resultEventId = randomUUID();
    const sealedAssistant = await sealRunEvent(spaceKeys.sealKey, runId, "work", assistantEventId, {
      t: "message",
      message: {
        id: randomUUID(),
        at: completionAt,
        role: "assistant",
        content: "The sign-in turn is complete.",
        turn: 1,
      },
    });
    const sealedResult = await sealRunEvent(spaceKeys.sealKey, runId, "work", resultEventId, {
      t: "result",
      result: {
        summary: "The sign-in turn is complete.",
        changes: [],
        capsuleRevoked: false,
        evidenceEntries: 1,
        rootHash: "e2e-root",
      },
    });
    expect((await api(`/internal/runs/${runId}/complete`, {
      service: true,
      body: {
        leaseToken: completionLease,
        events: [
          { eventId: assistantEventId, at: completionAt, event: sealedAssistant },
          { eventId: resultEventId, at: completionAt, event: sealedResult },
          { eventId: randomUUID(), at: completionAt, event: { t: "status", status: "completed", completedAt: completionAt } },
          { eventId: randomUUID(), at: completionAt, event: { t: "done", ok: true } },
        ],
      },
    })).status).toBe(200);

    await page.goto(`${webUrl}/app/runs/${runId}`);
    await enterPin(page);
    await expect(page.getByText("The sign-in turn is complete.", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("run-message")).toBeVisible();
    await expect(page.getByText("Send to continue this conversation", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/04-completed-run-follow-up.png`, fullPage: true });

    const followUp = "Continue checkout using the same signed-in session";
    await page.getByTestId("run-message").fill(followUp);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(followUp, { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const current = await api(`/runs/${runId}`, { token: desktopToken });
      return (current.json["run"] as { status: string }).status;
    }).toBe("ready");
    expect(page.url()).toBe(`${webUrl}/app/runs/${runId}`);
    await page.screenshot({ path: `${SCREENSHOTS}/05-same-run-reopened.png`, fullPage: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nWeb output:\n${webLog.slice(-8_000)}`);
  } finally {
    await captureContext?.close();
    await stopProcess(web);
    await rm(`${webProjectDir}${webDistDir}`, { recursive: true, force: true });
    await control.idle();
    await hub.close();
    controlServer.closeAllConnections();
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  }
});
}
