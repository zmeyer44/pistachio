# Enterprise browser controls

Pistachio's human tabs run on Chromium in a persistent space partition. Agent tabs run in isolated task partitions. Both paths now resolve sensitive browser capabilities through main-process policy before Chromium or an untrusted page can act.

## Enforced capabilities

- Chromium permission requests: camera, microphone, location, notifications, clipboard access, display capture, MIDI, and idle detection.
- Data movement: downloads, file uploads, copy, paste, and printing.
- Task tabs: the existing capsule grant controls uploads, downloads, and clipboard use; ungranted capabilities fail closed.
- Passkeys: WebAuthn works in persistent human tabs, including discoverable credentials and roaming security keys. Task tabs and Glance previews have WebAuthn disabled.
- Browser basics: native find-in-page, zoom, mute, print, navigation shortcuts, download activity, and a complete page context menu.

The trusted Site Controls surface shows the effective decision and its source (`managed`, `user`, `task`, or `default`). It also handles paused permission requests and exposes a metadata-only policy activity log.

## Managed policy

Place `enterprise-policy.json` in the Electron user-data directory, or set `PISTACHIO_ENTERPRISE_POLICY` to an absolute policy path:

```json
{
  "version": 1,
  "rules": [
    {
      "pattern": "*.corp.example",
      "permissions": {
        "camera": "block",
        "notifications": "allow"
      },
      "actions": {
        "download": "block",
        "upload": "block",
        "copy": "block",
        "paste": "allow",
        "print": "block"
      }
    }
  ]
}
```

Patterns may be `*`, an exact origin, a hostname, or a wildcard subdomain. Rules are evaluated in order and later matching values override earlier values. Managed decisions always override the person's saved site decisions.

User permission choices are stored separately in `site-permissions.json`. Renderer processes cannot write either file directly.

## Passkeys and device biometrics

Passkey creation and sign-in use Chromium's `navigator.credentials.create()` and `navigator.credentials.get()` implementation. The website never receives a fingerprint or face scan: the operating system verifies the person, and WebAuthn returns a signed assertion. The Site Controls panel reports whether the current page supports WebAuthn and whether a user-verifying platform authenticator is available.

When a relying party returns multiple discoverable accounts, Pistachio pauses the request and opens a trusted account chooser. The renderer receives only bounded account labels and request-scoped opaque option IDs. Actual WebAuthn credential IDs stay in the main process and are released only after a user selection. Navigation, tab close, cancellation, and a 60-second timeout all fail closed.

Authentication popups use a chooser in the popup's app-owned strip. The website cannot access its selection bridge. Requests remain tied to the initiating frame and the active human tab that opened the popup; replacing the document, closing the popup, or leaving its owner tab cancels the selection. The chooser and policy events identify the requesting frame's origin, including when it differs from the opener.

On macOS, Touch ID support requires a signed build with a matching `keychain-access-groups` entitlement and embedded provisioning profile. See [release setup](releasing.md) and [`apps/desktop/entitlements.mac.passkeys.plist`](../apps/desktop/entitlements.mac.passkeys.plist). A custom signed build can override the default access group with:

```sh
PISTACHIO_WEBAUTHN_ACCESS_GROUP="<TEAM_ID>.com.pistachio.desktop.webauthn"
```

The value must exactly match the resolved entitlement. Development and unsigned builds intentionally leave the Touch ID authenticator unconfigured rather than claiming biometric support they cannot provide. Roaming FIDO2 security keys and platform authenticators supported directly by Chromium remain available where the operating system reports them.

Passkey metadata belongs to the persistent human session partition, so isolated task partitions cannot see it. Electron's macOS credentials are stored in Keychain and bound to the device Secure Enclave.

These are device-bound credentials created in Pistachio, not existing passkeys in Apple Passwords/iCloud Keychain, another browser, or a third-party password manager. The pinned Electron 43 runtime does not provide that system credential-provider flow. Cookie/session import does not import passkeys. Electron's newer `platformPasskeys` API requires an association with the relying-party website and is not a general browser solution for sites such as Gmail; that requires Apple's browser-specific passkey integration. The popup regression test uses Chromium's virtual authenticator to verify request routing, selection, and cancellation, not access to a person's system passkeys.

## DLP extension seam

Every guarded action currently produces a verdict before the operation and an audit event after the decision. Content is deliberately not logged. A DLP engine can be added at that verdict boundary to inspect transfer metadata or content, return `allow`, `block`, or a future `require_approval` result, and keep the shell and Chromium hooks unchanged.
