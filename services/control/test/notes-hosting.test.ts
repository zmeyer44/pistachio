/**
 * Publishing a note (docs/notes.md §8). The pipeline is the artifact one —
 * `hosted_artifacts` with `kind = 'note'` — so this file is `artifacts.test.ts`
 * asked the same questions at the note routes, plus the one question only a
 * shared table raises: that a share id minted for one kind never answers at
 * the other kind's route.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  SERVICE_TOKEN,
  authed,
  desktopAccount,
  json,
  jsonInit,
  makeHarness,
} from "./helpers.js";

const ID = "9f8e7d6c5b4a";
const OTHER_ID = "0123456789ab";
const HTML = "<!doctype html><html><head><title>Groceries</title></head><body><h1>Groceries</h1><p>Olives.</p></body></html>";

describe("hosted notes", () => {
  it("keeps a private note encrypted-only, then publishes and revokes a stable share URL", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);

    const madePrivate = await h.request(
      `/v1/notes/${ID}/visibility`,
      jsonInit("PUT", { revision: 1, visibility: "private" }, owner.token),
    );
    expect(madePrivate.status).toBe(200);
    const privateView = await json<{ note: { noteId: string; shareId: string; visibility: string } }>(madePrivate);
    expect(privateView.note).toMatchObject({ noteId: ID, visibility: "private" });
    expect((await h.request(`/v1/public/notes/${privateView.note.shareId}`)).status).toBe(404);

    const publish = await h.request(
      `/v1/notes/${ID}/visibility`,
      jsonInit("PUT", { revision: 2, visibility: "public", html: HTML }, owner.token),
    );
    expect(publish.status).toBe(200);
    const publicView = await json<{ note: { shareId: string; visibility: string } }>(publish);
    expect(publicView.note).toMatchObject({ shareId: privateView.note.shareId, visibility: "public" });

    const page = await h.request(`/v1/public/notes/${publicView.note.shareId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(HTML);
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");

    const revoke = await h.request(
      `/v1/notes/${ID}/visibility`,
      jsonInit("PUT", { revision: 2, visibility: "private" }, owner.token),
    );
    expect(revoke.status).toBe(200);
    expect((await h.request(`/v1/public/notes/${publicView.note.shareId}`)).status).toBe(404);
    // Revoking clears the plaintext, it does not merely hide it.
    const [row] = await h.db
      .select()
      .from(schema.hostedArtifacts)
      .where(eq(schema.hostedArtifacts.userId, owner.userId));
    expect(row).toMatchObject({ kind: "note", visibility: "private", publicHtml: null });
  });

  it("isolates owners and accepts only current public revisions from producers", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const other = await desktopAccount(h);
    await h.request(
      `/v1/notes/${ID}/visibility`,
      jsonInit("PUT", { revision: 3, visibility: "public", html: HTML }, owner.token),
    );

    expect((await h.request(`/v1/notes/${ID}`, authed(other.token))).status).toBe(404);
    const stale = await h.request(
      `/v1/notes/${ID}/revision`,
      jsonInit("PUT", { revision: 2, html: "<h1>old</h1>" }, owner.token),
    );
    expect(await json(stale)).toEqual({ published: false });
    // A publish that started from an older revision is refused outright.
    const staleVisibility = await h.request(
      `/v1/notes/${ID}/visibility`,
      jsonInit("PUT", { revision: 2, visibility: "public", html: HTML }, owner.token),
    );
    expect(staleVisibility.status).toBe(409);
    expect(await json(staleVisibility)).toEqual({ error: "stale_revision" });

    const fresh = await h.request(
      `/v1/internal/users/${owner.userId}/notes/${ID}/revision`,
      jsonInit("PUT", { revision: 4, html: "<h1>new</h1>" }, SERVICE_TOKEN),
    );
    expect(await json<{ published: boolean }>(fresh)).toMatchObject({ published: true });

    const listed = await json<{ notes: Array<{ noteId: string; revision: number }> }>(
      await h.request("/v1/notes", authed(owner.token)),
    );
    expect(listed.notes).toMatchObject([{ noteId: ID, revision: 4 }]);
    expect((await json<{ notes: unknown[] }>(await h.request("/v1/notes", authed(other.token)))).notes).toEqual([]);
  });

  it("never lets one kind's share id answer at the other kind's route", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);

    const note = await json<{ note: { shareId: string } }>(
      await h.request(
        `/v1/notes/${ID}/visibility`,
        jsonInit("PUT", { revision: 1, visibility: "public", html: HTML }, owner.token),
      ),
    );
    const artifact = await json<{ artifact: { shareId: string } }>(
      await h.request(
        `/v1/artifacts/${OTHER_ID}/visibility`,
        jsonInit("PUT", { revision: 1, visibility: "public", html: HTML }, owner.token),
      ),
    );

    expect((await h.request(`/v1/public/artifacts/${note.note.shareId}`)).status).toBe(404);
    expect((await h.request(`/v1/public/notes/${artifact.artifact.shareId}`)).status).toBe(404);
    expect((await h.request(`/v1/notes/${OTHER_ID}`, authed(owner.token))).status).toBe(404);
    expect((await h.request(`/v1/artifacts/${ID}`, authed(owner.token))).status).toBe(404);

    // The two libraries stay separate.
    const notes = await json<{ notes: Array<{ noteId: string }> }>(await h.request("/v1/notes", authed(owner.token)));
    const artifacts = await json<{ artifacts: Array<{ artifactId: string }> }>(
      await h.request("/v1/artifacts", authed(owner.token)),
    );
    expect(notes.notes.map((row) => row.noteId)).toEqual([ID]);
    expect(artifacts.artifacts.map((row) => row.artifactId)).toEqual([OTHER_ID]);

    // One id cannot be both. The 12-hex space makes this a bug, not a clash.
    const clash = await h.request(
      `/v1/artifacts/${ID}/visibility`,
      jsonInit("PUT", { revision: 1, visibility: "private" }, owner.token),
    );
    expect(clash.status).toBe(409);
    expect(await json(clash)).toEqual({ error: "id_in_use" });
  });

  it("requires an authenticated device to change visibility and HTML to publish", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    expect(
      (await h.request(`/v1/notes/${ID}/visibility`, jsonInit("PUT", { revision: 1, visibility: "private" }))).status,
    ).toBe(401);
    expect(
      (await h.request(`/v1/notes/${ID}/visibility`, jsonInit("PUT", { revision: 1, visibility: "public" }, owner.token))).status,
    ).toBe(400);
    // The public read is the only note route without a credential.
    expect((await h.request(`/v1/notes/${ID}`)).status).toBe(401);
  });
});
