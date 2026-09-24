/**
 * Sharing a note with named accounts (docs/notes.md §9) — the first
 * cross-account authorisation in control, so the questions here are the ones
 * no other table has to answer: that a grant is what decides a read, that
 * revoking it ends both the access AND the plaintext it existed for, that a
 * viewer's write is refused, and that an account nobody named sees nothing.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  anonymousAccount,
  authed,
  desktopAccount,
  json,
  jsonInit,
  makeHarness,
} from "./helpers.js";

const ID = "9f8e7d6c5b4a";
const OTHER_ID = "0123456789ab";

interface ShareView {
  id: string;
  email: string;
  role: "viewer" | "editor";
  createdAt: string;
}

interface SharedNoteView {
  title: string;
  markdown: string;
  revision: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

const body = (revision: number, markdown = "Olives, bread.", title = "Groceries") =>
  ({ title, markdown, revision });

describe("note shares", () => {
  it("shares by exact email, changes the role, and says nothing about an email nobody holds", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const friend = await desktopAccount(h);

    const missing = await h.request(
      `/v1/notes/${ID}/shares`,
      jsonInit("POST", { email: "nobody@example.com", role: "viewer" }, owner.token),
    );
    expect(missing.status).toBe(200);
    expect(await json<{ share: ShareView | null }>(missing)).toMatchObject({ share: null });

    const shared = await h.request(
      `/v1/notes/${ID}/shares`,
      jsonInit("POST", { email: friend.email.toUpperCase(), role: "viewer" }, owner.token),
    );
    expect(shared.status).toBe(200);
    const first = await json<{ share: ShareView }>(shared);
    expect(first.share).toMatchObject({ email: friend.email, role: "viewer" });

    // Sharing again is how a role changes; it never makes a second row.
    const promoted = await json<{ share: ShareView; shares: ShareView[] }>(
      await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: friend.email, role: "editor" }, owner.token)),
    );
    expect(promoted.share).toMatchObject({ id: first.share.id, role: "editor" });
    expect(promoted.shares).toHaveLength(1);

    const listed = await json<{ shares: ShareView[] }>(await h.request(`/v1/notes/${ID}/shares`, authed(owner.token)));
    expect(listed.shares).toMatchObject([{ id: first.share.id, email: friend.email, role: "editor" }]);

    // Nobody shares with themselves; the row could not exist anyway.
    const self = await h.request(
      `/v1/notes/${ID}/shares`,
      jsonInit("POST", { email: owner.email, role: "viewer" }, owner.token),
    );
    expect(self.status).toBe(400);
    expect(await json(self)).toEqual({ error: "cannot_share_with_self" });
  });

  it("carries the owner's body to a viewer and refuses the viewer's write", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const friend = await desktopAccount(h);

    // Nothing is stored before there is a grant to store it for.
    const early = await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(3), owner.token));
    expect(early.status).toBe(404);
    expect(await json(early)).toEqual({ error: "not_shared" });

    await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: friend.email, role: "viewer" }, owner.token));
    const pushed = await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(3), owner.token));
    expect(pushed.status).toBe(200);
    expect(await json<{ stale: boolean }>(pushed)).toMatchObject({ stale: false });

    const mine = await json<{ notes: Array<Record<string, unknown>> }>(
      await h.request("/v1/shared-notes", authed(friend.token)),
    );
    expect(mine.notes).toMatchObject([
      { ownerId: owner.userId, ownerEmail: owner.email, noteId: ID, title: "Groceries", role: "viewer", revision: 3 },
    ]);

    const read = await json<{ role: string; note: SharedNoteView }>(
      await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, authed(friend.token)),
    );
    expect(read).toMatchObject({ role: "viewer", note: { markdown: "Olives, bread.", revision: 3 } });

    const write = await h.request(
      `/v1/shared-notes/${owner.userId}/${ID}`,
      jsonInit("PUT", body(4, "Olives, bread, and a viewer's opinion."), friend.token),
    );
    expect(write.status).toBe(403);
    expect(await json(write)).toEqual({ error: "forbidden" });

    // A push that started from an older revision is ignored, not applied.
    const stale = await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(2, "old"), owner.token));
    expect(await json(stale)).toEqual({ stale: true });
    const held = await json<{ note: SharedNoteView }>(await h.request(`/v1/notes/${ID}/shared`, authed(owner.token)));
    expect(held.note).toMatchObject({ markdown: "Olives, bread.", revision: 3 });
  });

  it("lets an editor write back, and the owner read what was written", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const editor = await desktopAccount(h);

    await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: editor.email, role: "editor" }, owner.token));
    await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(3), owner.token));

    const written = await h.request(
      `/v1/shared-notes/${owner.userId}/${ID}`,
      jsonInit("PUT", body(4, "Olives, bread, capers.", "Groceries, edited"), editor.token),
    );
    expect(written.status).toBe(200);
    expect(await json<{ note: SharedNoteView }>(written)).toMatchObject({
      note: { markdown: "Olives, bread, capers.", revision: 4, updatedByUserId: editor.userId },
    });

    const back = await json<{ note: SharedNoteView }>(await h.request(`/v1/notes/${ID}/shared`, authed(owner.token)));
    expect(back.note).toMatchObject({
      title: "Groceries, edited",
      markdown: "Olives, bread, capers.",
      revision: 4,
      updatedByUserId: editor.userId,
    });

    // A second editor's save that started from revision 3 is refused rather
    // than silently overwriting the one that landed first.
    const conflict = await h.request(
      `/v1/shared-notes/${owner.userId}/${ID}`,
      jsonInit("PUT", body(4, "Olives, bread, anchovies."), editor.token),
    );
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toEqual({ error: "stale_revision" });

    // The owner's own device catching up (its note is at 5 by now) still wins.
    const owned = await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(5, "Olives, bread, capers, wine."), owner.token));
    expect(await json<{ note: SharedNoteView }>(owned)).toMatchObject({
      note: { revision: 5, updatedByUserId: null },
    });
  });

  it("ends both the access and the plaintext when the last share is revoked", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const friend = await desktopAccount(h);
    const other = await desktopAccount(h);

    const shared = await json<{ share: ShareView }>(
      await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: friend.email, role: "editor" }, owner.token)),
    );
    const second = await json<{ share: ShareView }>(
      await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: other.email, role: "viewer" }, owner.token)),
    );
    await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(3), owner.token));

    const revoked = await h.request(`/v1/notes/${ID}/shares/${shared.share.id}`, authed(owner.token, "DELETE"));
    expect(revoked.status).toBe(200);
    expect((await json<{ shares: ShareView[] }>(revoked)).shares).toMatchObject([{ id: second.share.id }]);

    // The revoked recipient is told nothing exists, not that it is refused.
    expect((await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, authed(friend.token))).status).toBe(404);
    expect(
      (await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, jsonInit("PUT", body(4), friend.token))).status,
    ).toBe(404);
    expect((await json<{ notes: unknown[] }>(await h.request("/v1/shared-notes", authed(friend.token)))).notes).toEqual([]);
    // One share is still live, so the body is still there for it.
    const [stillThere] = await h.db
      .select()
      .from(schema.sharedNotes)
      .where(and(eq(schema.sharedNotes.ownerUserId, owner.userId), eq(schema.sharedNotes.noteId, ID)));
    expect(stillThere).toBeDefined();

    expect((await h.request(`/v1/notes/${ID}/shares/${second.share.id}`, authed(owner.token, "DELETE"))).status).toBe(200);
    // The last one goes, and the plaintext goes with it.
    const rows = await h.db
      .select()
      .from(schema.sharedNotes)
      .where(eq(schema.sharedNotes.ownerUserId, owner.userId));
    expect(rows).toEqual([]);
    expect((await json<{ note: unknown }>(await h.request(`/v1/notes/${ID}/shared`, authed(owner.token)))).note).toBeNull();
    // Revoking twice is a 404, not a second audit line.
    expect((await h.request(`/v1/notes/${ID}/shares/${second.share.id}`, authed(owner.token, "DELETE"))).status).toBe(404);

    const kinds = (await h.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.userId, owner.userId)))
      .map((row) => row.kind);
    expect(kinds).toContain("note.shared");
    expect(kinds).toContain("note.share_revoked");
  });

  it("keeps one account's shares out of every other account's reach", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const friend = await desktopAccount(h);
    const stranger = await desktopAccount(h);

    const shared = await json<{ share: ShareView }>(
      await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: friend.email, role: "editor" }, owner.token)),
    );
    await h.request(`/v1/notes/${ID}/shared`, jsonInit("PUT", body(3), owner.token));

    // Nobody the owner did not name can read it, write it, or see it listed.
    expect((await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, authed(stranger.token))).status).toBe(404);
    expect(
      (await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, jsonInit("PUT", body(4), stranger.token))).status,
    ).toBe(404);
    expect((await json<{ notes: unknown[] }>(await h.request("/v1/shared-notes", authed(stranger.token)))).notes).toEqual([]);
    // Nor manage the owner's grants, even holding the share's id.
    expect((await json<{ shares: unknown[] }>(await h.request(`/v1/notes/${ID}/shares`, authed(stranger.token)))).shares).toEqual([]);
    expect((await h.request(`/v1/notes/${ID}/shares/${shared.share.id}`, authed(stranger.token, "DELETE"))).status).toBe(404);
    // A recipient is not an owner: the owner routes read the CALLER's notes.
    expect((await json<{ shares: unknown[] }>(await h.request(`/v1/notes/${ID}/shares`, authed(friend.token)))).shares).toEqual([]);
    expect((await json<{ note: unknown }>(await h.request(`/v1/notes/${ID}/shared`, authed(friend.token)))).note).toBeNull();
    // A share on one note says nothing about another.
    expect((await h.request(`/v1/shared-notes/${owner.userId}/${OTHER_ID}`, authed(friend.token))).status).toBe(404);

    // And none of it is reachable without a credential.
    expect((await h.request(`/v1/notes/${ID}/shares`)).status).toBe(401);
    expect((await h.request("/v1/shared-notes")).status).toBe(401);
  });

  it("is closed to an anonymous account, both as an owner and as a recipient", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const anon = await anonymousAccount(h);

    expect((await h.request("/v1/shared-notes", authed(anon.token))).status).toBe(403);
    expect((await h.request(`/v1/notes/${ID}/shares`, authed(anon.token))).status).toBe(403);
    expect(
      (await h.request(`/v1/notes/${ID}/shares`, jsonInit("POST", { email: owner.email, role: "viewer" }, anon.token)))
        .status,
    ).toBe(403);
    expect(
      (await h.request(`/v1/shared-notes/${owner.userId}/${ID}`, jsonInit("PUT", body(2), anon.token))).status,
    ).toBe(403);
  });
});
