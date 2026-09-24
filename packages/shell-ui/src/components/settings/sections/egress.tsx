/**
 * Settings → Identity egress: which Spaces leave this Mac through your own
 * gateway address rather than the network you happen to be on
 * (docs/cloud-sync-design.md §10.3).
 *
 * The page exists because the failure modes are invisible otherwise. An
 * identity Space whose gateway is down does not fall back — it fails closed,
 * because falling back is exactly the moment a site would learn the address
 * the whole arrangement is meant to keep it from seeing. So the page states
 * the gateway's health, when its credential expires, and, per Space, where
 * that Space's requests are actually going right now — which is not always
 * what its policy says.
 */

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { SpaceEgressStatus } from "@pistachio/shell-contracts/ipc";
import type { SpaceInfo } from "@pistachio/shell-contracts/spaces";
import { useAsyncAction } from "../../../lib/action";
import {
  canBrowseDirect,
  credentialExpiry,
  EGRESS_POLICY_ITEMS,
  egressHealthView,
  gatewayLabel,
  gatewayStateLabel,
  RESTART_REQUIRED_NOTE,
  restartRequired,
  spaceEgressStatus,
  spaceEgressView,
} from "../../../lib/egress";
import { useAppStore } from "../../../store";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { ConfirmDialog } from "../dialogs";
import { Block, Fixed, Group, Page, Row, LoadFailed, Unavailable, useLoadFailure, useUnavailable } from "../parts";

export function EgressPage() {
  // W12: a host that cannot answer for this page says why, and the page
  // says it back — never a screen of controls that all refuse. The page
  // body is a component of its own so its hooks are never skipped.
  const unavailable = useUnavailable("getEgressStatus");
  const failed = useLoadFailure("getEgressStatus");
  if (unavailable !== null) {
    return <Unavailable title="Identity" description="Where this account's browsing appears to come from." reason={unavailable} section="egress" />;
  }
  // And a getter that FAILED is not a getter that refused: showing the
  // section's defaults would report an outage as a fact about the account.
  if (failed !== null) {
    return <LoadFailed title="Identity" description="Where this account's browsing appears to come from." reason={failed} />;
  }
  return <EgressPageBody />;
}

function EgressPageBody() {

  return (
    <Page
      title="Identity egress"
      description="A Space set to the gateway sends every request through an address that belongs to your account, so the sites you are signed into see one steady location instead of whichever café network you opened the laptop on."
    >
      <RestartRequired />
      <GatewayGroup />
      <SpacesGroup />
      <GuaranteesGroup />
    </Page>
  );
}

function toneVariant(tone: "green" | "amber" | "gray" | "red"): "green-subtle" | "amber-subtle" | "gray-subtle" | "red-subtle" {
  switch (tone) {
    case "green":
      return "green-subtle";
    case "amber":
      return "amber-subtle";
    case "red":
      return "red-subtle";
    default:
      return "gray-subtle";
  }
}

/* ------------------------------ the gateway ------------------------------ */

function GatewayGroup() {
  const egress = useAppStore((state) => state.egress);
  const view = egressHealthView(egress);
  const credential = credentialExpiry(egress.credentialExpiresAt);

  return (
    <Group
      title="Gateway"
      note="One gateway per account, provisioned by the control plane. Every identity Space of every device of yours goes out through it."
      footer={
        egress.enabled
          ? "The credential is short-lived and renewed on its own; the gateway refuses an expired one."
          : "No Space uses the gateway yet, so none is provisioned."
      }
    >
      <Row label="Health" note={view.note}>
        <Badge variant={toneVariant(view.tone)} size="sm" data-testid="egress-health">
          {view.label}
        </Badge>
      </Row>
      <Row label="Address" note="Host and port this Mac proxies through, with the address sites see and its region.">
        <span className="font-mono text-label-12 break-all text-gray-900" data-testid="egress-gateway">
          {gatewayLabel(egress.gateway)}
        </span>
      </Row>
      <Row label="State" note="What the provider says about the gateway machine itself.">
        <span className="text-label-13 text-gray-900">{gatewayStateLabel(egress.gateway)}</span>
      </Row>
      <Row label="Credential expires" note="A rotating username and password minted for this device alone.">
        <span className={credential.soon ? "text-label-13 text-amber-900" : "text-label-13 text-gray-900"} data-testid="egress-credential">
          {credential.label}
        </span>
      </Row>
    </Group>
  );
}

/* --------------------------- the relaunch notice -------------------------- */

/**
 * Chromium takes `--disable-quic` at launch and never again. A Space that
 * became an identity Space after startup therefore still has a UDP path that
 * would go around the proxy, and Pistachio would rather say so than quietly
 * proxy the TCP half.
 */
function RestartRequired() {
  const egress = useAppStore((state) => state.egress);
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const pending = restartRequired(egress);
  const identity = egress.spaces.some((row) => row.policy === "identity");
  if (!pending && (egress.quicDisabledAtStartup || !identity)) return null;
  const names = egress.spaces
    .filter((row) => row.restartRequired)
    .map((row) => spaces.find((space) => space.id === row.spaceId)?.name ?? row.spaceId);

  return (
    <Group
      type="warning"
      title="Relaunch Pistachio to finish switching"
      note="QUIC was still on when this session started."
      footer={names.length === 0 ? "Every identity Space is affected until then." : `Affected: ${names.join(", ")}.`}
      footerHighlight
    >
      <Block>
        <Note type="warning" size="sm" data-testid="egress-restart-required">
          {RESTART_REQUIRED_NOTE} Until you do, those Spaces browse direct — the gateway is not in the path and sites see
          this Mac&rsquo;s own address.
        </Note>
      </Block>
    </Group>
  );
}

const EMPTY_SPACES: SpaceInfo[] = [];

/* -------------------------------- Spaces --------------------------------- */

function SpacesGroup() {
  const spaces = useAppStore((state) => state.snapshot?.spaces ?? EMPTY_SPACES);
  const egress = useAppStore((state) => state.egress);

  return (
    <Group
      title="Spaces"
      note="Each Space chooses for itself. A Space set to Direct is ordinary browsing from this machine; one set to the gateway never falls back to it."
      footer="Switching a Space to the gateway takes effect for new requests; pages already open keep their connections until they are reloaded."
    >
      {spaces.map((space) => (
        <SpaceRow key={space.id} space={space} row={spaceEgressStatus(egress, space.id)} />
      ))}
    </Group>
  );
}

function SpaceRow({ space, row }: { space: SpaceInfo; row: SpaceEgressStatus | null }) {
  const egress = useAppStore((state) => state.egress);
  const setSpaceEgressPolicy = useAppStore((state) => state.setSpaceEgressPolicy);
  const [direct, setDirect] = useState(false);
  const { busy, error, run } = useAsyncAction();
  const policy = row?.policy ?? space.egressPolicy;
  const view = spaceEgressView(row, egress);

  const change = (next: "direct" | "identity") => run(() => setSpaceEgressPolicy(space.id, next));

  return (
    <>
      <Row
        label={
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: space.color }} aria-hidden="true" />
              {space.name}
            </span>
            <Badge variant={toneVariant(view.tone)} size="sm" data-testid={`egress-state-${space.id}`}>
              {view.label}
            </Badge>
          </span>
        }
        note={
          <span className="flex flex-col gap-1">
            <span>{view.note}</span>
            {canBrowseDirect(row) ? (
              <span>
                <Button variant="secondary" size="sm" onClick={() => setDirect(true)} data-testid={`egress-direct-${space.id}`}>
                  Browse direct for now…
                </Button>
              </span>
            ) : null}
            {error === null ? null : <span className="text-red-900">{error}</span>}
          </span>
        }
      >
        <Select
          aria-label={`Egress for ${space.name}`}
          value={policy}
          items={EGRESS_POLICY_ITEMS}
          disabled={busy}
          onValueChange={(next) => void change(next)}
          className="w-40"
          data-testid={`egress-policy-${space.id}`}
        />
      </Row>
      {direct ? <BrowseDirectDialog space={space} onClose={() => setDirect(false)} /> : null}
    </>
  );
}

function BrowseDirectDialog({ space, onClose }: { space: SpaceInfo; onClose: () => void }) {
  const browseDirectForNow = useAppStore((state) => state.browseDirectForNow);
  const { busy, error, run } = useAsyncAction();

  const confirm = async () => {
    if (await run(() => browseDirectForNow(space.id))) onClose();
  };

  return (
    <ConfirmDialog
      icon={<ShieldAlert aria-hidden="true" />}
      title={`Browse ${space.name} direct for now?`}
      subtitle="The gateway is unreachable, so this Space is blocked. Going direct unblocks it by giving up what it was protecting."
      does={[
        "Sends this Space's requests straight out of this Mac until the gateway answers again.",
        "Reveals this machine's real IP address to every site this Space loads, including the ones you are signed into there.",
        "Ends by itself: the Space goes back through the gateway as soon as the health probe answers.",
      ]}
      doesNot={[
        "Does not change the Space's setting — it stays an identity Space.",
        "Does not affect your other Spaces, your other devices, or the cloud browser.",
        "Does not un-see anything: a site that logs this session has your address for it.",
      ]}
      confirmLabel="Browse direct for now"
      confirmVariant="warning"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() => void confirm()}
      testId="browse-direct-dialog"
    >
      <Note type="warning" size="sm">
        A site that already knows your account will link it to this address. If that matters more than reaching the site
        right now, wait for the gateway instead.
      </Note>
    </ConfirmDialog>
  );
}

/* ------------------------------ guarantees ------------------------------- */

function GuaranteesGroup() {
  return (
    <Group title="What the gateway does" note="Each line is a property of how the proxy is configured, so there is nothing here to turn off.">
      <Fixed
        label="An identity Space fails closed"
        note="No gateway, no request. Falling back would leak the address the Space exists to hide, so nothing loads instead."
        badge="Enforced"
      />
      <Fixed
        label="Credentials are never offered to a site"
        note="The gateway's username and password answer proxy challenges only. An origin that asks for authentication is never given them."
        badge="Enforced"
      />
      <Fixed
        label="WebRTC cannot go around it"
        note="Non-proxied UDP is disabled, so a page cannot discover this Mac's address through a peer connection."
        badge="Enforced"
      />
    </Group>
  );
}
