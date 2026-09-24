import { useEffect, useMemo, useState } from "react";
import { ArrowRight, GitFork, Layers3, ShieldCheck, X } from "lucide-react";
import type { ForkTabScope } from "@pistachio/shell-contracts/spaces";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

export function SpaceForkDialog() {
  const snapshot = useAppStore((state) => state.snapshot);
  const close = useAppStore((state) => state.closeSpaceFork);
  const forkSpace = useAppStore((state) => state.forkSpace);
  const parent = useMemo(
    () => snapshot?.spaces.find((space) => space.id === snapshot.activeSpaceId) ?? null,
    [snapshot],
  );
  const [name, setName] = useState(() => (parent === null ? "New Space" : `${parent.name} fork`));
  const [purpose, setPurpose] = useState("");
  const [tabs, setTabs] = useState<ForkTabScope>("active");
  const [includeShelf, setIncludeShelf] = useState(true);
  const [includeSession, setIncludeSession] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, close]);

  if (parent === null) return null;
  const activeCount = Math.max(1, snapshot?.visibleTabIds.length ?? 1);
  const allCount = snapshot?.tabs.filter((tab) => tab.kind === "human").length ?? 0;

  const submit = async () => {
    if (name.trim() === "" || busy) return;
    setBusy(true);
    const result = await forkSpace({ name, purpose, tabs, includeShelf, includeSession });
    if (result === null) setBusy(false);
    else close();
  };

  return (
    <div className="animate-backdrop-in absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.36)] p-5" data-testid="space-fork-dialog-backdrop">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-space-title"
        data-testid="space-fork-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-[560px] overflow-hidden rounded-lg bg-background-100 shadow-[0_24px_80px_oklch(0_0_0/0.28),0_0_0_1px_var(--color-alpha-400)]"
      >
        <header className="flex items-start gap-3 border-b border-alpha-400 px-5 py-4">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-green-100 text-green-900">
            <GitFork className="size-4.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <h1 id="fork-space-title" className="text-heading-16 text-gray-1000">Fork this Space</h1>
            <span className="mt-1 flex items-center gap-2 text-label-12 text-gray-900">
              <span className="size-2 rounded-full" style={{ background: parent.color }} aria-hidden="true" />
              <span className="truncate">{parent.name}</span>
              <ArrowRight className="size-3" aria-hidden="true" />
              <span>independent child</span>
            </span>
          </span>
          <Button variant="tertiary" size="xs" svgOnly aria-label="Close" disabled={busy} onClick={close}>
            <X aria-hidden="true" />
          </Button>
        </header>

        <div className="max-h-[min(620px,calc(100vh-150px))] space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <label className="space-y-1.5 text-label-12 text-gray-900">
              <span className="block font-medium text-gray-1000">Space name</span>
              <Input autoFocus value={name} maxLength={48} onChange={(event) => setName(event.target.value)} data-testid="fork-space-name" className="w-full" />
            </label>
            <label className="space-y-1.5 text-label-12 text-gray-900">
              <span className="block font-medium text-gray-1000">Purpose</span>
              <textarea
                value={purpose}
                maxLength={280}
                rows={2}
                placeholder="What related outcome is this Space for?"
                onChange={(event) => setPurpose(event.target.value)}
                data-testid="fork-space-purpose"
                className="min-h-16 w-full resize-none rounded-sm bg-background-100 px-2.5 py-2 text-label-13 text-gray-1000 shadow-border outline-none transition-shadow placeholder:text-gray-700 focus:shadow-[0_0_0_1px_var(--color-gray-1000),0_0_0_4px_var(--color-alpha-200)]"
              />
            </label>
          </div>

          <fieldset>
            <legend className="mb-2 text-label-12 font-medium text-gray-1000">Carry tabs</legend>
            <div className="grid grid-cols-2 gap-2">
              <ScopeCard active={tabs === "active"} title="Current view" note={`${String(activeCount)} ${activeCount === 1 ? "tab" : "split tabs"}`} onClick={() => setTabs("active")} />
              <ScopeCard active={tabs === "all"} title="Every open tab" note={`${String(allCount)} human ${allCount === 1 ? "tab" : "tabs"}`} onClick={() => setTabs("all")} />
            </div>
          </fieldset>

          <section className="overflow-hidden rounded-md bg-background-100 shadow-border">
            <TransferRow
              icon={<Layers3 aria-hidden="true" />}
              label="Space shelf"
              note="Favorites, pins, folders, and their live tab bindings."
              checked={includeShelf}
              onChange={setIncludeShelf}
            />
            <TransferRow
              icon={<ShieldCheck aria-hidden="true" />}
              label="Sessions and working context"
              note="Origin-scoped cookies, page storage, and non-password form drafts for carried tabs."
              checked={includeSession}
              onChange={setIncludeSession}
            />
          </section>

          <p className="rounded-md bg-amber-100 px-3 py-2 text-label-12 leading-4.5 text-amber-1000">
            The fork becomes independent immediately. IndexedDB, service workers, downloads, grants, agent runs, and evidence stay in {parent.name}.
          </p>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-alpha-400 bg-background-200 px-5 py-3">
          <span className="text-label-12 text-gray-900">Lineage is kept so the relationship stays visible.</span>
          <span className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={close}>Cancel</Button>
            <Button type="submit" size="sm" loading={busy} disabled={name.trim() === ""} prefix={<GitFork aria-hidden="true" />} data-testid="confirm-fork-space">
              Fork Space
            </Button>
          </span>
        </footer>
      </form>
    </div>
  );
}

function ScopeCard({ active, title, note, onClick }: { active: boolean; title: string; note: string; onClick(): void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md px-3 py-2.5 text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-green-100 shadow-[0_0_0_1px_var(--color-green-700)]" : "bg-background-100 shadow-border hover:bg-gray-100",
      )}
    >
      <span className="block text-label-13 font-medium text-gray-1000">{title}</span>
      <span className="mt-0.5 block text-label-12 text-gray-900">{note}</span>
    </button>
  );
}

function TransferRow({ icon, label, note, checked, onChange }: { icon: React.ReactNode; label: string; note: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <div className="flex items-start gap-3 border-t border-alpha-400 px-3.5 py-3 first:border-t-0">
      <span className="mt-0.5 text-gray-700 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-label-13 text-gray-1000">{label}</span>
        <span className="mt-0.5 block text-label-12 leading-4 text-gray-900">{note}</span>
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
