import { Globe, Search } from "lucide-react";
import {
  favoriteApp,
  type OnboardingFavoritePick,
} from "@pistachio/shell-contracts/onboarding";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { BrandWash, brandBorderStyle } from "../BrandTile";
import { AppLogo } from "./AppLogo";

/**
 * The sidebar as it will be once the wizard is done, drawn small in the copy
 * column while the apps are picked: the address row, then the favorites
 * grid with each chosen app as the tile the real grid draws
 * (components/FavoritesGrid.tsx — same size, same radius, same mark), and
 * a few faint rows for the tabs that will follow. Tiles sit in the order
 * picked — the order the shelf will have — so a new pick takes the next
 * slot and nothing already there moves. The last app picked is
 * shown as the active page, so the brand-coloured active state is
 * previewed too. Empty slots hold the grid's shape so the column does not
 * jump as picks come and go. The mock has no bottom edge: it dissolves
 * into the column, a sidebar that goes on below the fold.
 *
 * It stays on through the appearance step, where (`themed`) it is painted
 * with the window's live theme variables, so the palette being chosen
 * shows on the sidebar it will actually colour. Before that it is plain
 * grey — the theme is not the favorites step's subject.
 */
/** `themed` paints it with the window's live theme; otherwise it is plain grey. */
export function SidebarPreview({
  picks,
  themed = false,
}: {
  /** Catalog apps and sites typed in by hand (plain tiles, named by host), in the order picked. */
  picks: readonly OnboardingFavoritePick[];
  themed?: boolean;
}) {
  const radius = useAppStore((state) => state.settings.appearance.radius);
  const activeId = picks.reduce<string | null>((last, pick) => (pick.kind === "app" ? pick.id : last), null);
  const slots = Math.max(3, Math.ceil(picks.length / 3) * 3);
  return (
    <div
      aria-label="Your sidebar, as it will look"
      data-testid="onboarding-sidebar-preview"
      className="onboarding-preview mx-auto w-[300px] rounded-t-[14px] border border-b-0 border-alpha-400 bg-background-200 p-2.5 transition-[background-color,border-radius] duration-200 [mask-image:linear-gradient(to_bottom,black_45%,transparent_100%)]"
      // The real sidebar's paint (styles.css `.chrome-sidebar`): the theme's
      // gradient over a surface of the chosen opacity. The `--theme-*` vars
      // are the window's own, kept live by ThemeRuntime as the appearance
      // step writes settings, so this is what the sidebar will look like.
      style={
        themed
          ? {
              backgroundColor:
                "color-mix(in srgb, var(--color-background-200) var(--theme-surface-opacity-percent), var(--color-background-100))",
              backgroundImage: "var(--theme-window-gradient)",
              borderTopLeftRadius: Math.max(10, radius + 4),
              borderTopRightRadius: Math.max(10, radius + 4),
            }
          : undefined
      }
    >
      <div aria-hidden="true" className="mb-2 flex items-center gap-1.5 px-1">
        <span className="size-2 rounded-full bg-alpha-300" />
        <span className="size-2 rounded-full bg-alpha-300" />
        <span className="size-2 rounded-full bg-alpha-300" />
      </div>
      <div
        aria-hidden="true"
        className="mb-2 flex h-8 items-center gap-2 rounded-md bg-background-100 px-2.5 text-[11px] text-gray-700 shadow-small"
      >
        <Search className="size-3" />
        Search or enter address
      </div>
      <div
        role="list"
        aria-label="Favorites"
        className="grid grid-cols-3 gap-1.5"
      >
        {Array.from({ length: slots }, (_, at) => {
          const pick = picks[at];
          const site = pick?.kind === "site" ? pick : undefined;
          const app = pick?.kind === "app" ? (favoriteApp(pick.id) ?? undefined) : undefined;
          if (site !== undefined) {
            return (
              <span
                key={site.url}
                role="listitem"
                aria-label={site.title}
                data-testid="preview-favorite-custom"
                title={site.title}
                className="onboarding-preview-tile relative grid h-10 place-items-center rounded-md border-[1.5px] border-transparent bg-alpha-100"
              >
                <Globe
                  className="size-[18px] text-gray-800"
                  aria-hidden="true"
                />
              </span>
            );
          }
          if (app === undefined) {
            return (
              <span
                key={`slot-${String(at)}`}
                aria-hidden="true"
                className="h-10 rounded-md border-[1.5px] border-dashed border-alpha-300"
              />
            );
          }
          const active = app.id === activeId;
          return (
            <span
              key={app.id}
              role="listitem"
              aria-label={app.name}
              aria-current={active ? "page" : undefined}
              data-testid={`preview-favorite-${app.id}`}
              className={cn(
                "onboarding-preview-tile relative grid h-10 place-items-center rounded-md border-[1.5px]",
                active
                  ? "shadow-[0_4px_12px_-6px_rgb(0_0_0/0.25)]"
                  : "border-transparent bg-alpha-100",
              )}
              style={active ? brandBorderStyle(app.colors) : undefined}
            >
              {active ? <BrandWash colors={app.colors} /> : null}
              <AppLogo
                id={app.id}
                className="relative size-[18px] rounded-[5px]"
              />
            </span>
          );
        })}
      </div>
      <div aria-hidden="true" className="mt-2 flex flex-col gap-1">
        {[0.7, 0.5, 0.6, 0.65, 0.45, 0.55].map((width, at) => (
          <span
            key={at}
            className="flex h-7 items-center gap-2 rounded-md px-2"
          >
            <span className="size-4 shrink-0 rounded-[4px] bg-alpha-200" />
            <span
              className="h-2 rounded-full bg-alpha-200"
              style={{ width: `${String(width * 100)}%` }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
