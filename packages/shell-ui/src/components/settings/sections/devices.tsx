/**
 * Settings → Devices: every machine that holds a key for this account
 * (docs/cloud-sync-design.md §10.1, D6).
 *
 * The fingerprint is the point of the page. Control introduces the cloud
 * browser's public key on first enable and this Mac pins it; showing the
 * fingerprint of every device — in the same 8-group hex form on every screen
 * — is what makes a substituted key visible afterwards. When control does
 * answer with a different key, nothing is wrapped to it until someone
 * confirms the new one here.
 */

import { useState } from "react";
import { Cloud, Globe, KeyRound, Laptop, ShieldAlert } from "lucide-react";
import type { DeviceInfo } from "@pistachio/shell-contracts/ipc";
import { useAsyncAction } from "../../../lib/action";
import { cn } from "../../../lib/cn";
import { deviceIsRevoked, devicePlatformLabel, deviceSeenLabel, fingerprintGroups, sortDevices } from "../../../lib/account";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { ConfirmDialog } from "../dialogs";
import { Block, Group, Page, Row, LoadFailed, Unavailable, useLoadFailure, useUnavailable } from "../parts";

export function DevicesPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  const unavailable = useUnavailable("listDevices");
  const failed = useLoadFailure("listDevices");
  if (unavailable !== null) {
    return <Unavailable title="Devices" description="Each device signs what it publishes with its own key." reason={unavailable} section="devices" />;
  }
  // And a getter that FAILED is not a getter that refused: showing the
  // section's defaults would report an outage as a fact about the account.
  if (failed !== null) {
    return <LoadFailed title="Devices" description="Each device signs what it publishes with its own key." reason={failed} />;
  }
  return <DevicesPageBody />;
}

function DevicesPageBody() {

  const devices = useAppStore((state) => state.devices);
  const enrolled = useAppStore((state) => state.account.state === "enrolled");
  const ordered = sortDevices(devices);
  const live = ordered.filter((device) => !deviceIsRevoked(device));

  return (
    <Page
      title="Devices"
      description="Each device signs what it publishes with its own key. Compare a fingerprint here against the one on the other machine's screen — they are the same eight groups on both."
    >
      <CloudKeyChanged />
      <Group
        title="Enrolled devices"
        note="A device stays in this list after revocation so you can see it was here."
        footer={
          enrolled
            ? live.length === 1
              ? "1 device may open this account's sealed sessions."
              : `${String(live.length)} devices may open this account's sealed sessions.`
            : "Sign in and enroll this Mac to see the account's devices."
        }
      >
        {ordered.length === 0 ? (
          <Block>
            <p className="text-copy-13 text-gray-900">
              No devices yet. Enrolling this Mac in Settings → Account registers its key pair as the first one.
            </p>
          </Block>
        ) : (
          ordered.map((device) => <DeviceRow key={device.id} device={device} />)
        )}
      </Group>

      <Group title="What a fingerprint is" note="Read it once and the comparison takes a second.">
        <Block>
          <p className="text-copy-13 leading-5 text-gray-900">
            Eight groups of four hex digits, taken from a SHA-256 of the device&rsquo;s raw agreement key. Two devices
            showing the same eight groups hold the same key; one differing group means it is a different key, whatever
            the name beside it says.
          </p>
        </Block>
      </Group>
    </Page>
  );
}

/* ------------------------------- one device ----------------------------- */

function DeviceRow({ device }: { device: DeviceInfo }) {
  const renameDevice = useAppStore((state) => state.renameDevice);
  const [draft, setDraft] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();
  const revoked = deviceIsRevoked(device);

  const save = async () => {
    if (draft === null) return;
    const name = draft.trim();
    if (name === "") {
      setError("A device needs a name.");
      return;
    }
    if (await run(() => renameDevice(device.id, name))) setDraft(null);
  };

  if (draft !== null) {
    return (
      <Block label={`Rename ${device.name}`} note="The name every device in the account sees.">
        <div className="flex flex-wrap items-start gap-2">
          <Input
            autoFocus
            value={draft}
            maxLength={64}
            error={error}
            disabled={busy}
            aria-label="Device name"
            onChange={(event) => setDraft(event.target.value)}
            className="w-64"
            containerClassName="w-64"
          />
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </Block>
    );
  }

  return (
    <>
      <div className={cn(revoked && "opacity-55")} data-testid={`device-${device.id}`}>
        <Row
          label={
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-gray-1000">{device.name}</span>
              <Badge variant={device.isThisDevice ? "green-subtle" : "gray-subtle"} size="sm" icon={<PlatformIcon device={device} />}>
                {devicePlatformLabel(device)}
              </Badge>
              {device.isPinnedCloudDevice ? (
                <Badge variant="blue-subtle" size="sm">
                  Pinned key
                </Badge>
              ) : null}
              {revoked ? (
                <Badge variant="red-subtle" size="sm">
                  Revoked
                </Badge>
              ) : null}
            </span>
          }
          note={
            <span className="flex flex-col gap-1">
              <Fingerprint value={device.fingerprint} />
              <span>{deviceSeenLabel(device)}</span>
            </span>
          }
        >
          {revoked ? null : (
            <span className="flex items-center gap-2">
              <Button variant="tertiary" size="sm" onClick={() => setDraft(device.name)}>
                Rename
              </Button>
              {device.isThisDevice ? null : (
                <Button variant="tertiary" size="sm" onClick={() => setRevoking(true)} data-testid={`revoke-${device.id}`}>
                  Revoke…
                </Button>
              )}
            </span>
          )}
        </Row>
      </div>
      {revoking ? <RevokeDialog device={device} onClose={() => setRevoking(false)} /> : null}
    </>
  );
}

function PlatformIcon({ device }: { device: DeviceInfo }) {
  if (device.platform === "cloud") return <Cloud aria-hidden="true" />;
  if (device.platform === "web") return <Globe aria-hidden="true" />;
  return <Laptop aria-hidden="true" />;
}

/** The 8 groups, kept on one baseline so two of them can be read side by side. */
export function Fingerprint({ value, className }: { value: string; className?: string }) {
  const groups = fingerprintGroups(value);
  if (groups.length === 0) return <span className="text-gray-700">no key</span>;
  return (
    <span className={cn("flex flex-wrap gap-x-1.5 font-mono text-[11px] leading-4 text-gray-900", className)}>
      {groups.map((group, index) => (
        <span key={`${group}-${String(index)}`}>{group}</span>
      ))}
    </span>
  );
}

/* -------------------------------- revoke -------------------------------- */

function RevokeDialog({ device, onClose }: { device: DeviceInfo; onClose: () => void }) {
  const revokeDevice = useAppStore((state) => state.revokeDevice);
  const { busy, error, run } = useAsyncAction();

  const confirm = async () => {
    if (await run(() => revokeDevice(device.id))) onClose();
  };

  const cloud = device.platform === "cloud";
  return (
    <ConfirmDialog
      icon={<ShieldAlert aria-hidden="true" />}
      title={`Revoke ${device.name}?`}
      subtitle="Revocation is about keys, not about sessions that already exist elsewhere."
      does={[
        "Control stops accepting that device's token, and the hub closes its socket at once.",
        "Its key wrappers are deleted, so it can no longer unwrap any Space secret.",
        "Its egress credentials are revoked; the gateway refuses them on the next connection.",
        cloud
          ? "The cloud browser stops driving this account, and this Mac drops the pinned key."
          : "Anything it publishes after this moment is rejected by every other device's verifier.",
      ]}
      doesNot={[
        "Cannot log that device out of third-party sites: cookies already in its browser keep working until the site expires them.",
        "Does not clear what is on that machine — its Spaces, tabs, and local cookie jars stay as they are.",
        "Does not remove what it already published; converged records stay in every device's jar.",
        "Does not delete the device from this list — it stays here, marked revoked.",
      ]}
      confirmLabel="Revoke device"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => void confirm()}
      testId="revoke-device-dialog"
    >
      <div className="rounded-md bg-background-200 px-3.5 py-3 shadow-border">
        <p className="text-label-12 font-medium text-gray-1000">{device.name}</p>
        <p className="mt-0.5 text-label-12 text-gray-900">
          {devicePlatformLabel(device)} · {deviceSeenLabel(device)}
        </p>
        <Fingerprint value={device.fingerprint} className="mt-1.5" />
      </div>
      <Note type="warning" size="sm">
        If that machine is lost, also change your password: the password wrappers it once read are still on control.
      </Note>
    </ConfirmDialog>
  );
}

/* -------------------------- the cloud key changed ------------------------ */

function CloudKeyChanged() {
  const pinned = useAppStore((state) => state.account.cloudDevicePin);
  const changed = useAppStore((state) => state.account.cloudDeviceChanged ?? null);
  const confirmCloudDevice = useAppStore((state) => state.confirmCloudDevice);
  const { busy, error, run } = useAsyncAction();

  if (changed === null || changed === undefined) return null;

  const confirm = () => run(() => confirmCloudDevice());

  return (
    <Group
      type="warning"
      title="The cloud browser is showing a different key"
      note="Nothing was wrapped to it. Until someone confirms the new key here, the cloud browser cannot open any Space of this account."
      footer="Confirm only if you expected the cloud browser to be re-provisioned."
      footerHighlight
      footerAction={
        <Button variant="warning" size="sm" loading={busy} onClick={() => void confirm()} data-testid="confirm-cloud-key">
          Confirm new key
        </Button>
      }
    >
      <Block>
        <div className="grid gap-3 sm:grid-cols-2" data-testid="cloud-key-comparison">
          <KeyCard label="Key this Mac pinned" fingerprint={pinned?.fingerprint ?? ""} deviceId={pinned?.deviceId ?? "unknown"} tone="pinned" />
          <KeyCard label="Key control is offering" fingerprint={changed.fingerprint} deviceId={changed.deviceId} tone="new" />
        </div>
        {error === null ? null : (
          <Note type="error" size="sm" className="mt-3">
            {error}
          </Note>
        )}
      </Block>
    </Group>
  );
}

function KeyCard({
  label,
  fingerprint,
  deviceId,
  tone,
}: {
  label: string;
  fingerprint: string;
  deviceId: string;
  tone: "pinned" | "new";
}) {
  return (
    <div
      className={cn(
        "rounded-md px-3.5 py-3",
        tone === "new" ? "bg-amber-100 text-amber-1000" : "bg-background-200 shadow-border",
      )}
    >
      <p className="flex items-center gap-1.5 text-label-12 font-medium text-gray-1000">
        <KeyRound aria-hidden="true" className="size-3.5" />
        {label}
      </p>
      <Fingerprint value={fingerprint} className="mt-1.5" />
      <p className="mt-1 font-mono text-[11px] leading-4 break-all text-gray-700">{deviceId}</p>
    </div>
  );
}
