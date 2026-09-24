"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Checkbox,
  type ControlDevice,
  type DevicePlatform,
  Empty,
  Intro,
  listDevices,
  Note,
  Page,
  PIN_LENGTH,
  PinPad,
  REMEMBER_DAYS,
  revokeDevice,
  Section,
  Table,
  useSession,
  When,
} from "@pistachio/web-account";

/**
 * Control owns the list of platforms (`DevicePlatform`), so this reads it from
 * the protocol package rather than a copy that could fall behind. A device of
 * a kind this build has not heard of still gets a row and a word for it.
 */
const PLATFORM: Record<DevicePlatform, string> = {
  macos: "Mac",
  web: "Browser",
  cloud: "Cloud browser",
};

const platformLabel = (device: ControlDevice): string => PLATFORM[device.platform] ?? "Device";

export default function DevicesPage(): ReactNode {
  const { token, identity, remembered, setRemembered, signOut, vaultError } = useSession();
  const [devices, setDevices] = useState<ControlDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [affected, setAffected] = useState<string[] | null>(null);
  /**
   * Turning "stay unlocked" on is a ceremony now, not a click: the keys are
   * sealed under a PIN, so the switch cannot move until there is one to seal
   * them with. Null means the row is just a checkbox.
   */
  const [choosing, setChoosing] = useState<{ first: string; entry: string; confirming: boolean } | null>(null);
  const [mismatch, setMismatch] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null) return;
    try {
      setDevices((await listDevices(token)).devices);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read your devices.");
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = (device: ControlDevice): void => {
    if (token === null) return;
    const isThis = device.id === identity?.deviceId;
    const question = isThis
      ? "Revoke this browser? You will be signed out here."
      : `Revoke ${device.name}? It loses access within a minute.`;
    if (!confirm(question)) return;
    setPending(device.id);
    void revokeDevice(token, device.id)
      .then(async (result) => {
        // The confirm promised a sign-out, and control has just stopped
        // honouring this browser's token: the keys it holds have to go with
        // it, rather than sitting in the vault until someone reloads.
        if (isThis) {
          await signOut();
          return;
        }
        setAffected(result.affectedOrigins.map((origin) => origin.label));
        await refresh();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That device could not be revoked.");
      })
      .finally(() => {
        setPending(null);
      });
  };

  const live = devices.filter((device) => device.revokedAt === null);
  const revoked = devices.filter((device) => device.revokedAt !== null);

  return (
    <Page>
      <Intro
        title="Devices"
        lede="Everything holding a key to this account. Revoking one cuts its access to sync, the cloud browser and the identity gateway within a minute."
      />

      {error === null ? null : <Note tone="alert">{error}</Note>}
      {vaultError === null ? null : <Note tone="alert">{vaultError}</Note>}

      <Section
        heading="This browser"
        note="Where the keys that read your records are held between reloads."
      >
        <Checkbox
          checked={remembered || choosing !== null}
          label="Stay unlocked on this browser"
          help={`Seals this account's keys into this browser's vault for ${String(REMEMBER_DAYS)} days under a ${String(PIN_LENGTH)}-digit PIN, so coming back is the PIN instead of your password. Anyone who can use this browser profile and knows the PIN can then read your records. Turning this off forgets them now.`}
          onChange={(on) => {
            setError(null);
            setMismatch(0);
            if (on) {
              // Nothing is stored until the PIN is confirmed, so the switch is
              // only shown as on while the ceremony runs.
              setChoosing({ first: "", entry: "", confirming: false });
              return;
            }
            setChoosing(null);
            // The checkbox follows the store, not the click: if the keys could
            // not be deleted it stays where it was, because the reader is
            // entitled to read it as the truth about this browser.
            void setRemembered(false).catch((cause: unknown) => {
              setError(
                `This browser could not delete the stored keys${cause instanceof Error ? `: ${cause.message}` : "."} Clear this site's data to remove them.`,
              );
            });
          }}
        />
        {choosing === null ? null : (
          <div className="pa-pinchoice">
            <p className="pa-label">
              {choosing.confirming ? "Enter it again to confirm" : `Choose a ${String(PIN_LENGTH)}-digit PIN`}
            </p>
            <PinPad
              key={choosing.confirming ? "confirm" : "choose"}
              label={choosing.confirming ? "Confirm your PIN" : "Choose a PIN"}
              value={choosing.entry}
              wrongAt={mismatch}
              autoFocus
              onChange={(entry) => {
                setChoosing((current) => (current === null ? null : { ...current, entry }));
              }}
              onComplete={(entry) => {
                setChoosing((current) => {
                  if (current === null) return null;
                  if (!current.confirming) return { first: entry, entry: "", confirming: true };
                  if (entry !== current.first) {
                    setMismatch((count) => count + 1);
                    return { first: "", entry: "", confirming: false };
                  }
                  void setRemembered(true, entry)
                    .then(() => {
                      setChoosing(null);
                    })
                    .catch(() => {
                      setError("This browser could not store the keys, so it will still ask for your password.");
                      setChoosing(null);
                    });
                  return { ...current, entry };
                });
              }}
            />
            <p className="pa-help">
              {mismatch > 0 && choosing.confirming === false
                ? "Those did not match. Start again."
                : `Five wrong tries forget these keys and ask for your password instead.`}
            </p>
          </div>
        )}
      </Section>

      {affected === null ? null : (
        <Note tone="alert">
          Revoked. Pistachio cannot sign that device out of sites it already reached — if it is lost, end those sessions
          at the sites themselves{affected.length === 0 ? "." : `, starting with ${affected.slice(0, 5).join(", ")}.`}
        </Note>
      )}

      {live.length === 0 ? (
        <Empty title="No devices" />
      ) : (
        <Section heading="Active">
          <Table
            caption={`${String(live.length)} device${live.length === 1 ? "" : "s"} with a live key.`}
            head={
              <>
                <th scope="col">Device</th>
                <th scope="col">Kind</th>
                <th scope="col" className="pa-n">Added</th>
                <th scope="col" className="pa-n">Last seen</th>
                <th scope="col" />
              </>
            }
          >
            {live.map((device) => (
              <tr key={device.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {device.name}
                  {device.id === identity?.deviceId ? <span className="pa-caption"> · this browser</span> : null}
                </th>
                <td className="pa-caption">{platformLabel(device)}</td>
                <td className="pa-n">
                  <When iso={device.createdAt} />
                </td>
                <td className="pa-n">
                  <When iso={device.lastSeenAt} relative />
                </td>
                <td>
                  <Button
                    type="button"
                    variant="alert"
                    disabled={pending === device.id}
                    onClick={() => {
                      revoke(device);
                    }}
                  >
                    {pending === device.id ? "Revoking…" : "Revoke"}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {revoked.length === 0 ? null : (
        <Section heading="Revoked">
          <Table
            caption={`${String(revoked.length)} device${revoked.length === 1 ? "" : "s"} no longer trusted.`}
            head={
              <>
                <th scope="col">Device</th>
                <th scope="col">Kind</th>
                <th scope="col" className="pa-n">Revoked</th>
              </>
            }
          >
            {revoked.map((device) => (
              <tr key={device.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {device.name}
                </th>
                <td className="pa-caption">{platformLabel(device)}</td>
                <td className="pa-n">
                  <When iso={device.revokedAt} relative />
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </Page>
  );
}
