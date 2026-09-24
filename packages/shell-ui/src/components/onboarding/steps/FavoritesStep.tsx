import { useState } from "react";
import { Check, Globe, Plus, X } from "lucide-react";
import { MAX_FAVORITES } from "@pistachio/shell-contracts/sidebar";
import {
  customFavoriteFrom,
  FAVORITE_APPS,
  SUGGESTED_FAVORITES,
  type OnboardingCustomFavorite,
} from "@pistachio/shell-contracts/onboarding";
import { cn } from "../../../lib/cn";
import { AppLogo } from "../AppLogo";
import { MockWindow } from "../parts";
import { BrandWash, brandBorderStyle } from "../../BrandTile";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/**
 * The favorites step's stage: the catalog as a three-wide grid inside a
 * mock window, the way the real favorites grid sits under the sidebar's
 * address bar. The tiles size to the window — a third of the stage's width
 * each, up to 180px — with everything inside them in proportion (`--tile`).
 * A chosen tile is washed and ringed with the brand's own
 * colours (FAVORITE_APPS.colors), so Figma's tile carries its five and
 * YouTube's carries only its red.
 *
 * Under the grid, a field for a site the catalog does not offer: the
 * address is checked the way the General settings' new-tab page is, so a
 * word is refused out loud rather than kept as a favorite that opens a
 * search. Three picks are a suggestion; none is fine.
 */
export function FavoritesStep({
  selected,
  custom,
  onToggle,
  onAddCustom,
  onRemoveCustom,
}: {
  selected: readonly string[];
  custom: readonly OnboardingCustomFavorite[];
  onToggle: (id: string) => void;
  onAddCustom: (favorite: OnboardingCustomFavorite) => void;
  onRemoveCustom: (url: string) => void;
}) {
  const chosen = selected.length + custom.length;
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const full = chosen >= MAX_FAVORITES;

  const addCustom = () => {
    const favorite = customFavoriteFrom(address);
    if (favorite === null) {
      setProblem("A favorite has to be a web address, like app.example.com.");
      return;
    }
    if (
      custom.some((existing) => existing.url === favorite.url) ||
      FAVORITE_APPS.some((app) => app.url === favorite.url)
    ) {
      setProblem("That site is already in the list.");
      return;
    }
    onAddCustom(favorite);
    setAddress("");
    setProblem(null);
  };

  return (
    <MockWindow placement="bleed" testId="onboarding-favorites">
      <div className="scroll-thin flex h-full flex-col overflow-y-auto px-8 pb-10 @container [--tile:min(180px,calc(100cqw/3-12px))]">
        <div
          role="group"
          aria-label="Apps to keep as favorites"
          className="grid w-full grid-cols-3 justify-items-center gap-y-[calc(var(--tile)*0.14)]"
        >
          {FAVORITE_APPS.map((app) => {
            const on = selected.includes(app.id);
            return (
              <button
                key={app.id}
                type="button"
                aria-pressed={on}
                aria-label={app.name}
                title={app.name}
                data-testid={`favorite-app-${app.id}`}
                data-selected={on ? "" : undefined}
                onClick={() => onToggle(app.id)}
                className={cn(
                  "group relative grid size-(--tile) place-items-center overflow-hidden rounded-[calc(var(--tile)*0.15)] border-2 outline-none duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] cursor-pointer transform transition-all",
                  on
                    ? "shadow-[0_6px_18px_-8px_rgb(0_0_0/0.25)]"
                    : "border-transparent bg-alpha-100 hover:bg-alpha-200 hover:-translate-y-0.5",
                )}
                style={on ? brandBorderStyle(app.colors) : undefined}
              >
                {on ? <BrandWash colors={app.colors} /> : null}
                <AppLogo
                  id={app.id}
                  className="relative size-[calc(var(--tile)*0.33)] transition-transform duration-150 group-hover:scale-105"
                />
                {on ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-[6%] right-[6%] grid size-[calc(var(--tile)*0.17)] place-items-center rounded-full bg-gray-1000 text-background-100 shadow-small"
                  >
                    <Check className="size-[55%]" strokeWidth={3} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <form
          className="mx-auto mt-6 flex w-full max-w-[calc(var(--tile)*3+24px)] flex-col gap-2"
          data-testid="onboarding-custom-favorite"
          onSubmit={(event) => {
            event.preventDefault();
            addCustom();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label="Add your own site"
              placeholder="Add your own site — app.example.com"
              prefix={<Globe aria-hidden="true" />}
              value={address}
              disabled={full}
              onChange={(event) => {
                setAddress(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                // Enter adds the site; the wizard's own Enter (its primary
                // button) must not fire from inside the field.
                event.stopPropagation();
              }}
              className="min-w-0 flex-1"
              inputClassName="font-mono placeholder:font-sans"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={full || address.trim() === ""}
              prefix={<Plus aria-hidden="true" />}
            >
              Add
            </Button>
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-label-12 text-red-900">
              {problem}
            </p>
          )}
          {custom.length === 0 ? null : (
            <ul className="flex flex-wrap gap-1.5" aria-label="Your own sites">
              {custom.map((favorite) => (
                <li
                  key={favorite.url}
                  data-testid="onboarding-custom-site"
                  className="flex h-7 items-center gap-1 rounded-full bg-alpha-100 pr-1 pl-2.5 text-label-12 text-gray-1000"
                >
                  <Globe className="size-3 text-gray-700" aria-hidden="true" />
                  {favorite.title}
                  <button
                    type="button"
                    aria-label={`Remove ${favorite.title}`}
                    onClick={() => onRemoveCustom(favorite.url)}
                    className="grid size-5 cursor-pointer place-items-center rounded-full text-gray-700 hover:bg-alpha-200 hover:text-gray-1000"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        <p
          aria-live="polite"
          className="mt-4 text-center text-label-12 text-gray-700"
        >
          {chosen === 0
            ? `Pick a few — ${String(SUGGESTED_FAVORITES)} is a good start — or carry on without any`
            : `${String(chosen)} chosen · they'll be at the top of your sidebar`}
        </p>
      </div>
    </MockWindow>
  );
}
