import { describe, expect, it } from "vitest";
import {
  SERVICE_TOKEN,
  authed,
  desktopAccount,
  json,
  jsonInit,
  makeHarness,
} from "./helpers.js";

const ID = "a1b2c3d4e5f6";
const HTML = "<!doctype html><html><head><title>Forecast</title></head><body><script>document.body.dataset.ready='yes'</script></body></html>";

describe("hosted artifacts", () => {
  it("keeps a private artifact encrypted-only, then publishes and revokes a stable share URL", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);

    const madePrivate = await h.request(
      `/v1/artifacts/${ID}/visibility`,
      jsonInit("PUT", { revision: 1, visibility: "private" }, owner.token),
    );
    expect(madePrivate.status).toBe(200);
    const privateView = await json<{ artifact: { shareId: string; visibility: string } }>(madePrivate);
    expect(privateView.artifact.visibility).toBe("private");
    expect((await h.request(`/v1/public/artifacts/${privateView.artifact.shareId}`)).status).toBe(404);

    const publish = await h.request(
      `/v1/artifacts/${ID}/visibility`,
      jsonInit("PUT", { revision: 1, visibility: "public", html: HTML }, owner.token),
    );
    expect(publish.status).toBe(200);
    const publicView = await json<{ artifact: { shareId: string; visibility: string } }>(publish);
    expect(publicView.artifact).toMatchObject({ shareId: privateView.artifact.shareId, visibility: "public" });

    const page = await h.request(`/v1/public/artifacts/${publicView.artifact.shareId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(HTML);
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const revoke = await h.request(
      `/v1/artifacts/${ID}/visibility`,
      jsonInit("PUT", { revision: 1, visibility: "private" }, owner.token),
    );
    expect(revoke.status).toBe(200);
    expect((await h.request(`/v1/public/artifacts/${publicView.artifact.shareId}`)).status).toBe(404);
  });

  it("isolates owners and accepts only current public revisions from producers", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    const other = await desktopAccount(h);
    await h.request(
      `/v1/artifacts/${ID}/visibility`,
      jsonInit("PUT", { revision: 3, visibility: "public", html: HTML }, owner.token),
    );

    expect((await h.request(`/v1/artifacts/${ID}`, authed(other.token))).status).toBe(404);
    const stale = await h.request(
      `/v1/artifacts/${ID}/revision`,
      jsonInit("PUT", { revision: 2, html: "<h1>old</h1>" }, owner.token),
    );
    expect(await json(stale)).toEqual({ published: false });
    const fresh = await h.request(
      `/v1/internal/users/${owner.userId}/artifacts/${ID}/revision`,
      jsonInit("PUT", { revision: 4, html: "<h1>new</h1>" }, SERVICE_TOKEN),
    );
    expect(await json<{ published: boolean }>(fresh)).toMatchObject({ published: true });

    const listed = await json<{ artifacts: Array<{ revision: number }> }>(
      await h.request("/v1/artifacts", authed(owner.token)),
    );
    expect(listed.artifacts).toMatchObject([{ revision: 4 }]);
  });

  it("requires an authenticated device to change visibility and valid HTML to publish", async () => {
    const h = await makeHarness();
    const owner = await desktopAccount(h);
    expect(
      (await h.request(`/v1/artifacts/${ID}/visibility`, jsonInit("PUT", { revision: 1, visibility: "private" }))).status,
    ).toBe(401);
    expect(
      (await h.request(`/v1/artifacts/${ID}/visibility`, jsonInit("PUT", { revision: 1, visibility: "public" }, owner.token))).status,
    ).toBe(400);
  });
});
