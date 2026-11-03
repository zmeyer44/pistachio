/**
 * Settings → Extensions (docs/extensions.md §2, §7): Developer mode and the
 * folder it watches; then every installed extension — its state and, for
 * one of the person's own that broke, the error with its place (`file:line`)
 * — with its switch, *Agent can use it* (when it declares tools), *Reload*
 * and *Logs* (one of the person's own), its settings drawn from what it
 * declared (`ExtensionInfo.settings`: boolean, string, number, enum, secret),
 * and *Remove* (with a confirm; a bundled one is turned off instead).
 *
 * Opened on one extension from its *Options* (lib/extensions/actions.ts,
 * `settingsFocus`): that block is scrolled to, its logs read or its removal
 * asked, as the Ledge's menu said. On a host with no extensions (the web):
 * `Unavailable`, in the host's own words once it has said them.
 */

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Puzzle, RotateCw, ScrollText, Trash2 } from "lucide-react";
import type { ExtensionInfo, ExtensionSettingInfo } from "@pistachio/shell-contracts/extensions";
import { nativeApi, shellApi } from "../../../api";
import { extensionLogs, openExtensionsPage, reloadExtension, removeExtension, revealExtensionFolder, setAgentAllowed } from "../../../lib/extensions/actions";
import { errorPlace, isOwnSource, sourceLine, statusLabel, tildePath } from "../../../lib/extensions/ledge";
import { EXTENSIONS_ON_THE_DESKTOP, extensionsRequest, openExtensionSheet, useExtensions, useExtensionsState } from "../../../lib/extensions/use-extensions";
import { useAppStore } from "../../../store";
import { ExtensionMark } from "../../extensions/LedgeIcon";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Block, Group, LoadFailed, Page, probeRefusal, Row, Unavailable, useLoadFailure, useUnavailable } from "../parts";

const TITLE = "Extensions";
const DESCRIPTION = "What you've added to Pistachio: from the Chrome Web Store, made for Pistachio, or your own.";

export function ExtensionsSettingsPage() {
  const hostReason = useUnavailable("extensions");
  const failed = useLoadFailure("extensions");
  const unsupported = useExtensionsState((state) => state.unsupported);
  const loaded = useExtensionsState((state) => state.loaded);
  // The web has none (W12): ask once, so the page says it in the host's own words rather than the shell's.
  useEffect(() => {
    if (nativeApi() === null) void probeRefusal("extensions", () => shellApi().extensions({ type: "closePanel" }));
  }, []);
  const reason = unsupported ?? hostReason ?? (nativeApi() === null ? EXTENSIONS_ON_THE_DESKTOP : null);
  if (reason !== null) return <Unavailable title={TITLE} description={DESCRIPTION} reason={reason} />;
  // (A refusal is a fault only while nothing has come from main: once a snapshot has, the page shows it.)
  if (failed !== null && !loaded) return <LoadFailed title={TITLE} description={DESCRIPTION} reason={failed} />;
  return <ExtensionsSettingsBody />;
}

function ExtensionsSettingsBody() {
  const snapshot = useExtensionsState((state) => state.snapshot);
  const loaded = useExtensionsState((state) => state.loaded);
  const focus = useExtensionsState((state) => state.settingsFocus);
  const settingsFolder = useAppStore((state) => state.settings.extensions.devFolder);
  const folder = snapshot.devFolder ?? settingsFolder ?? "~/Pistachio/Extensions";
  const extensions = [...snapshot.extensions].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Page title={TITLE} description={DESCRIPTION}>
      <Group title="Your own" note="Extensions you or a coding agent write into a folder on this Mac. Each one waits for your approval before anything of it runs.">
        <Row label="Developer mode" note={`Watches ${tildePath(folder)} and reloads an extension as you save it. Pistachio writes what went wrong back into the folder (.pistachio/status.json), for you or your agent to read.`}>
          <Switch checked={snapshot.developerMode} label="Developer mode" onChange={(on) => void extensionsRequest({ type: "setDeveloperMode", on })} />
        </Row>
        <Row label="Folder" note={<span className="font-mono text-[12px]">{tildePath(folder)}</span>}>
          <Button variant="secondary" size="sm" onClick={() => void extensionsRequest({ type: "loadFolder" })}>
            Load a folder…
          </Button>
        </Row>
      </Group>

      <Group
        title="Installed"
        footer={!loaded ? "Reading what is installed…" : extensions.length === 0 ? "Nothing installed yet." : `${String(extensions.length)} installed.`}
        footerAction={
          <Button variant="secondary" size="sm" prefix={<Puzzle aria-hidden="true" />} onClick={openExtensionsPage}>
            Find extensions
          </Button>
        }
      >
        {extensions.length === 0 ? null : extensions.map((extension) => <ExtensionBlock key={extension.id} extension={extension} focus={focus?.id === extension.id ? (focus.action ?? "options") : null} />)}
      </Group>
    </Page>
  );
}

/** One installed extension: its head, what is the matter with it, its switches and buttons, its settings. */
function ExtensionBlock({ extension, focus }: { extension: ExtensionInfo; focus: "options" | "logs" | "remove" | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [reading, setReading] = useState(false);
  const own = isOwnSource(extension.source);
  const place = errorPlace(extension.error);

  const readLogs = async (): Promise<void> => {
    setReading(true);
    setLogs(await extensionLogs(extension.id));
    setReading(false);
  };

  // Opened from its Ledge icon's menu: here, its logs read or its removal asked. Once.
  useEffect(() => {
    if (focus === null) return;
    ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (focus === "logs") void readLogs();
    if (focus === "remove") setRemoving(true);
    useExtensions.setState({ settingsFocus: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <div ref={ref} data-testid="settings-extension" data-extension-id={extension.id}>
      <Block
        note={
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-label-14 text-gray-1000">
              <ExtensionMark extension={extension} />
              {extension.name}
              <span className="text-label-12 text-gray-700">{extension.version}</span>
              <StatusBadge extension={extension} />
            </span>
            <span>{extension.description}</span>
            <span className="text-gray-700">{sourceLine(extension.source)}</span>
            {extension.error === null ? null : (
              <span className="text-red-900" data-testid="settings-extension-error">
                {extension.error.message}
                {place === null ? null : <span className="ml-1.5 font-mono text-[11.5px]">{place}</span>}
              </span>
            )}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {extension.pending !== null ? (
            <Button size="sm" onClick={() => openExtensionSheet({ kind: "extension", id: extension.id })}>
              Review and turn on
            </Button>
          ) : (
            <label className="flex items-center gap-2 text-label-13 text-gray-1000">
              <Switch checked={extension.enabled} label={`${extension.name} on`} disabled={extension.status === "incompatible"} onChange={(enabled) => void extensionsRequest({ type: "setEnabled", id: extension.id, enabled })} />
              On
            </label>
          )}
          {extension.pending === null && extension.enabled ? (
            <label className="flex items-center gap-2 text-label-13 text-gray-1000">
              <Switch checked={extension.enabledHere} label={`${extension.name} in this Profile`} onChange={(enabled) => void extensionsRequest({ type: "setEnabled", id: extension.id, enabled, scope: "here" })} />
              In this Profile
            </label>
          ) : null}
          {extension.tools.length > 0 ? (
            <label className="flex items-center gap-2 text-label-13 text-gray-1000">
              <Switch checked={extension.agentAllowed} label="Agent can use it" onChange={(allowed) => setAgentAllowed(extension.id, allowed)} />
              Agent can use it
            </label>
          ) : null}
          <span className="grow" />
          {own ? (
            <>
              <Button variant="tertiary" size="sm" prefix={<RotateCw aria-hidden="true" />} onClick={() => reloadExtension(extension.id)}>
                Reload
              </Button>
              <Button variant="tertiary" size="sm" prefix={<FolderOpen aria-hidden="true" />} onClick={() => revealExtensionFolder(extension.id)}>
                Show folder
              </Button>
              <Button variant="tertiary" size="sm" prefix={<ScrollText aria-hidden="true" />} loading={reading} onClick={() => (logs === null ? void readLogs() : setLogs(null))}>
                {logs === null ? "Logs" : "Hide logs"}
              </Button>
            </>
          ) : null}
          {extension.source.type === "bundled" ? null : removing ? (
            <>
              <Button variant="error" size="sm" data-testid="settings-extension-remove-confirm" onClick={() => removeExtension(extension)}>
                Remove
              </Button>
              <Button variant="tertiary" size="sm" onClick={() => setRemoving(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="tertiary" size="sm" prefix={<Trash2 aria-hidden="true" />} onClick={() => setRemoving(true)}>
              Remove…
            </Button>
          )}
        </div>
        {removing ? (
          <Note type="warning" size="sm" className="mt-3">
            {own ? "It goes from Pistachio, and what it kept here with it. Its folder stays where it is." : "It goes from Pistachio, and what it kept here with it."}
          </Note>
        ) : null}
        {logs === null ? null : <LogViewer lines={logs} />}
        {extension.settings.length === 0 ? null : (
          <div className="mt-3 flex flex-col divide-y divide-alpha-400 rounded-md shadow-border" data-testid="settings-extension-settings">
            {extension.settings.map((setting) => (
              <SettingField key={setting.key} extensionId={extension.id} setting={setting} />
            ))}
          </div>
        )}
      </Block>
    </div>
  );
}

function StatusBadge({ extension }: { extension: ExtensionInfo }) {
  const label = statusLabel(extension);
  if (extension.pending !== null || extension.status === "needs-approval" || extension.status === "paused")
    return (
      <Badge variant="amber-subtle" size="sm">
        {extension.status === "paused" ? "Paused" : "Needs approval"}
      </Badge>
    );
  if (extension.status === "error")
    return (
      <Badge variant="red-subtle" size="sm">
        Broken
      </Badge>
    );
  if (extension.status === "incompatible")
    return (
      <Badge variant="gray-subtle" size="sm">
        Won’t work here
      </Badge>
    );
  if (extension.status === "off" || !extension.enabledHere)
    return (
      <Badge variant="gray-subtle" size="sm">
        {label}
      </Badge>
    );
  return (
    <Badge variant="green-subtle" size="sm">
      {label}
    </Badge>
  );
}

/** Its log, newest last: console and errors from every context of it (main's `.pistachio/log.ndjson`). */
function LogViewer({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      data-testid="settings-extension-logs"
      className="mt-3 max-h-60 overflow-auto rounded-md bg-background-200 px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-gray-1000 shadow-border"
    >
      {lines.length === 0 ? "Nothing logged yet." : lines.join("\n")}
    </pre>
  );
}

/** One declared setting, drawn by its type; a change goes to main (`setSetting`), which the extension hears. */
function SettingField({ extensionId, setting }: { extensionId: string; setting: ExtensionSettingInfo }) {
  const set = (value: unknown): void => void extensionsRequest({ type: "setSetting", id: extensionId, key: setting.key, value });
  const label = (
    <span className="min-w-0 flex-1">
      <span className="block text-label-13 text-gray-1000">{setting.title}</span>
      {setting.description === null ? null : <span className="block text-copy-13 text-gray-900">{setting.description}</span>}
    </span>
  );
  let control: React.ReactNode;
  switch (setting.type) {
    case "boolean":
      control = <Switch checked={setting.value === true} label={setting.title} onChange={set} />;
      break;
    case "enum":
      control = (
        <Select
          aria-label={setting.title}
          value={typeof setting.value === "string" ? setting.value : (setting.options?.[0] ?? "")}
          items={(setting.options ?? []).map((option) => ({ value: option, label: option }))}
          onValueChange={set}
        />
      );
      break;
    case "number":
      control = <TextSetting kind="number" setting={setting} onCommit={(text) => (text.trim() === "" || Number.isNaN(Number(text)) ? undefined : set(Number(text)))} />;
      break;
    case "secret": {
      // A kept secret never comes back as itself, so the field cannot be emptied to forget it: Clear does (main keeps nothing for null).
      const kept = typeof setting.value === "string" && setting.value !== "";
      control = (
        <span className="flex items-center gap-2">
          <TextSetting kind="password" setting={setting} onCommit={(text) => (text === "" ? undefined : set(text))} />
          {kept ? (
            <Button variant="secondary" size="sm" data-testid="settings-extension-secret-clear" onClick={() => set(null)}>
              Clear
            </Button>
          ) : null}
        </span>
      );
      break;
    }
    case "string":
      control = <TextSetting kind="text" setting={setting} onCommit={set} />;
      break;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5" data-setting={setting.key}>
      {label}
      <span className="shrink-0">{control}</span>
    </div>
  );
}

/** A field committed on Enter or as it loses the keyboard, not on every key: each commit is a request and an event. */
function TextSetting({ kind, setting, onCommit }: { kind: "text" | "number" | "password"; setting: ExtensionSettingInfo; onCommit: (text: string) => void }) {
  // A secret never comes back as itself ("" or "••••••"): its field starts empty, its placeholder saying whether one is kept.
  const initial = kind === "password" ? "" : setting.value === null || setting.value === undefined ? "" : String(setting.value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = (): void => {
    if (text !== initial) onCommit(text);
  };
  return (
    <Input
      size="sm"
      type={kind}
      aria-label={setting.title}
      value={text}
      min={kind === "number" ? setting.min : undefined}
      max={kind === "number" ? setting.max : undefined}
      placeholder={kind === "password" ? (typeof setting.value === "string" && setting.value !== "" ? "Kept · type to replace" : "Not set") : undefined}
      className="w-56"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
