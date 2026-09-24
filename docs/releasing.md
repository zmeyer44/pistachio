# Shipping a desktop release

How to take `apps/desktop` from source to a signed, notarized macOS build that
people can download from `/download` on the website. Apple silicon only for
now.

## One-time setup

Everything below is already in place on the release machine; a new machine
needs all of it.

1. **Developer ID certificate.** `Developer ID Application: Zach Meyer
   (PHSRT54C87)` must be in the login keychain. Check with
   `security find-identity -v -p codesigning`.
2. **Provisioning profile.** Touch ID passkeys need the
   `keychain-access-groups` entitlement, and macOS refuses to launch a
   Developer ID app with that entitlement unless a *Developer ID* provisioning
   profile is embedded. Download the `Pistachio-Developer` profile for
   `run.pistachio.desktop` from developer.apple.com → Profiles and save it as
   `apps/desktop/build/embedded.provisionprofile`. Without it, `dist:mac`
   still builds, but prints a warning and ships without passkey support.
3. **Icons.** `apps/desktop/build/` (SVG sources, generated `icon.icns`,
   and `generate-icons.sh`) is committed. Regenerate after editing an SVG with
   `sh apps/desktop/build/generate-icons.sh` (needs `librsvg` and
   `imagemagick` from brew).
4. **Secrets in the repo-root `.env`** (gitignored):

   | Variable | Purpose |
   | --- | --- |
   | `APPLE_ID` | Apple account email, for notarization |
   | `APPLE_APP_SPECIFIC_PASSWORD` | Generated at account.apple.com → App-Specific Passwords |
   | `APPLE_TEAM_ID` | `PHSRT54C87` |
   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | Cloudflare R2 credentials for uploading the DMG |

5. **`aws` CLI** for the upload (`brew install awscli`).

## Release steps

### 1. Bump the version

Update `"version"` in `apps/desktop/package.json`. electron-builder names the
artifacts from it (`Pistachio-<version>-arm64.dmg`).

### 2. Build, sign, notarize

From the repo root:

```sh
set -a; source .env; set +a
pnpm --filter @pistachio/desktop dist:mac
```

`dist:mac` runs `electron-vite build`, then `apps/desktop/scripts/dist-mac.mjs`,
which invokes electron-builder with `apps/desktop/electron-builder.yml`. It
signs with the hardened runtime, embeds the provisioning profile, uploads the
app to Apple's notary service (usually 2–10 minutes), and staples the ticket.
Expect these lines in the output:

```
dist-mac: embedding .../build/embedded.provisionprofile; Touch ID passkeys enabled
  • signing         ... identityName=Developer ID Application: Zach Meyer (PHSRT54C87)
  • notarization successful
```

Artifacts land in `apps/desktop/dist/`:

- `Pistachio-<version>-arm64.dmg` — what people download from the website
- `Pistachio-<version>-arm64-mac.zip` + `.blockmap` — what installed apps
  update from (electron-updater downloads the zip, the blockmap makes that
  delta-sized)
- `latest-mac.yml` — the release feed: version, file names, sha512 hashes
- `mac-arm64/Pistachio.app`

If signing fails partway with a `codesign` error on a random file, a previous
build of the app is probably still running and holding files open. Quit it,
`rm -rf apps/desktop/dist/mac-arm64`, and rerun.

### 3. Verify

```sh
cd apps/desktop/dist
codesign --verify --deep --strict mac-arm64/Pistachio.app     # silent = OK
spctl --assess -vv mac-arm64/Pistachio.app                     # source=Notarized Developer ID
codesign -d --entitlements :- mac-arm64/Pistachio.app | grep webauthn   # keychain group present
open mac-arm64/Pistachio.app                                   # launches, no Touch ID error in Console
```

Recommended: sign, notarize, and staple the DMG container itself so Gatekeeper
can verify the installer and the first launch works offline.

```sh
codesign --force --sign "Developer ID Application: Zach Meyer (PHSRT54C87)" \
  --timestamp Pistachio-<version>-arm64.dmg
xcrun notarytool submit Pistachio-<version>-arm64.dmg \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple Pistachio-<version>-arm64.dmg
xcrun stapler validate Pistachio-<version>-arm64.dmg
spctl --assess --type open --context context:primary-signature -vv \
  Pistachio-<version>-arm64.dmg
```

Signing and stapling change the DMG bytes. Recompute its SHA-512 and size in
`latest-mac.yml` after these steps, and use the final DMG for the website
SHA-256 and size. Leave the ZIP entry unchanged unless the ZIP also changed.

### 4. Upload to R2

Releases live in the public `harbor-public` bucket under `releases/`. (The
`R2_BUCKET` value in `.env` is a placeholder; use the bucket name directly.)
Upload the DMG, the zip, its blockmap, and — **last**, because installed
apps act on it the moment it lands — `latest-mac.yml`.

```sh
export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
       AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
       AWS_DEFAULT_REGION=auto
cd apps/desktop/dist
aws s3 cp Pistachio-<version>-arm64.dmg s3://harbor-public/releases/ \
  --endpoint-url "$R2_ENDPOINT" --content-type application/x-apple-diskimage
aws s3 cp Pistachio-<version>-arm64-mac.zip s3://harbor-public/releases/ \
  --endpoint-url "$R2_ENDPOINT" --content-type application/zip
aws s3 cp Pistachio-<version>-arm64-mac.zip.blockmap s3://harbor-public/releases/ \
  --endpoint-url "$R2_ENDPOINT" --content-type application/octet-stream
aws s3 cp latest-mac.yml s3://harbor-public/releases/ \
  --endpoint-url "$R2_ENDPOINT" --content-type text/yaml --cache-control "max-age=60"
```

Installed apps check `releases/latest-mac.yml` every six hours (and fifteen
seconds after launch). They only *notify*: the download starts when the
person clicks the pill or Settings → About → Download, and the install when
they choose to restart.

Confirm it is public and the size matches:

```sh
curl -sI https://pub-68b47b2a682a4b2f8b6bb9a2df285ec5.r2.dev/releases/Pistachio-<version>-arm64.dmg
```

#### Rehearsing an update without publishing

Serve a folder holding a `latest-mac.yml` (with a higher `version`), the zip,
and its blockmap, then launch the installed app pointed at it:

```sh
cd apps/desktop/dist && python3 -m http.server 8765 &
PISTACHIO_UPDATE_FEED=http://localhost:8765/ open -a /Applications/Pistachio.app
```

The pill appears in the chrome within about fifteen seconds; click through
download and restart.

### 5. Update the website

Edit `apps/www/lib/release.ts`:

```sh
shasum -a 256 apps/desktop/dist/Pistachio-<version>-arm64.dmg
stat -f %z  apps/desktop/dist/Pistachio-<version>-arm64.dmg
```

- `version`, `file` — match the new artifact
- `publishedAt` — today's date
- `bytes`, `sha256` — from the commands above
- `minimumOs` — only if the Electron major changed its floor

`/download` renders these, and `/download/latest` redirects to the new DMG.
Deploying `apps/www` publishes the change.

### 6. Commit and tag

```sh
git add apps/desktop/package.json apps/www/lib/release.ts
git commit -m "Release <version>"
git tag v<version>
git push && git push --tags
```

### 7. Publish the source

This repo (`zmeyer44/pistachio-internal`) is private. The public GPL repo,
`zmeyer44/pistachio`, gets one commit per release and none of this repo's
history:

```sh
DRY_RUN=1 scripts/publish-public.sh v<version> "Pistachio <version>"  # review
scripts/publish-public.sh v<version> "Pistachio <version>"
```

The script commits the tagged tree, minus the paths in `.public-exclude`, on
top of the previous public release. Add a path there before it ships if it
should stay private. Changes contributed on the public repo come back by hand
(apply the patch here), since the two histories are unrelated.

## Reference

- Bundle ID: `run.pistachio.desktop`
- Keychain access group: `PHSRT54C87.run.pistachio.desktop.webauthn` — must
  stay identical in `apps/desktop/entitlements.mac.passkeys.plist` and
  `DEFAULT_WEBAUTHN_ACCESS_GROUP` in `apps/desktop/src/main/index.ts`.
- `entitlements.mac.plist` (no keychain group) is used for helper processes
  and for builds without a profile; `entitlements.mac.passkeys.plist` is used
  for the main app when the profile is present.
- Touch ID passkeys are device-bound (Secure Enclave), not synced through
  iCloud Keychain.
- Profiles: the packaged app (`productName` "Pistachio") stores its data in
  `~/Library/Application Support/Pistachio`; a dev run pins itself to
  `~/Library/Application Support/@pistachio/desktop`. They never share state
  or the single-instance lock, so both can run at once.
- Dev builds (`pnpm dev`) run the unsigned stock Electron binary, so passkey
  prompts never appear there; test passkeys against a packaged build.
