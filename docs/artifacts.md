# Artifacts

The desktop and cloud agents can build a complete interactive HTML page — a
morning briefing, trip itinerary, dashboard, or small site. Every artifact has
a stable web URL:

```text
https://pistachio.run/app/artifacts/<artifact-id>
```

That owner URL is private by default. The web app obtains the artifact from the
end-to-end-encrypted workspace and renders it only after an enrolled browser has
unlocked the account. The owner can deliberately publish a separate, stable
share URL:

```text
https://pistachio.run/artifacts/<random-share-id>
```

Public means anyone with that URL can read the plaintext snapshot without an
account. Making the artifact private again clears the plaintext copy and makes
the share URL return 404 immediately. Re-publishing reuses the same share ID.

## Division of labor

- The primary agent decides whether a page is warranted, gathers the material,
  and commissions it with `artifact_create` or refreshes it with
  `artifact_update`.
- The artifact builder is a specialist model with no tools or browser. It turns
  the supplied material into one self-contained document. The generated HTML
  never enters the primary model's context.
- Desktop and cloud expose the same artifact tools and both persist the result
  as an encrypted account workspace record.

A recurring deliverable updates one artifact rather than creating a new one.
Its ID, private web URL, and public share ID remain stable while `revision`
increases. If the owner has published it, desktop and cloud first read the
hosting status (metadata only) and upload the new plaintext revision only when
that status is still `public`. A web viewer can also heal a missed public update
when it sees a newer encrypted revision.

## Storage and routes

- `ArtifactRecord` holds metadata plus HTML inside a device-signed workspace
  document sealed under the account workspace key. The sync hub stores only
  ciphertext.
- `apps/desktop/src/main/artifact-store.ts` keeps an offline local copy in
  `<userData>/artifacts.json` and `<userData>/artifacts/<id>.html`. The old
  `pistachio://artifact/<id>` handler remains for existing local links, but new
  tool results use the web URL. `PISTACHIO_WEB_URL` overrides the web origin;
  development defaults to `http://localhost:3000`.
- `hosted_artifacts` in control contains the owner/id mapping, random share ID,
  visibility, and current public revision. `public_html` is null for every
  private row. It contains plaintext only after explicit publication. The table
  also hosts published notes: `kind` (`'artifact'` | `'note'`) is what every
  route filters on, so the two share one share-ID space, one publish path and
  one CSP without either kind answering at the other's URL (docs/notes.md §8).
- `/app/artifacts` is the encrypted owner library and
  `/app/artifacts/<artifact-id>` is its private viewer and sharing control.
- `/artifacts/<share-id>` is the public web route. It proxies only an artifact
  currently marked public and never accepts a device token or encryption key.

## Isolation

Generated HTML is untrusted, even when the model wrote it from trusted-looking
material. Private previews run in an iframe without `allow-same-origin`; public
documents receive a CSP `sandbox` response directive. Both use an opaque origin,
so inline scripts cannot read the web app's storage, browser device identity, or
account keys.

The remaining policy permits inline styles and scripts plus data/blob media. It
blocks all network-loaded resources, fetch/WebSocket connections, forms, frames,
objects, external scripts, and base-URL changes. Ordinary source links still
work as user navigation. Responses are `no-store`, use no-referrer, and are
`noindex` so a share link is accessible but not intended for discovery.

Limits remain 100 artifacts per workspace and 1.5 MB of HTML per revision.
