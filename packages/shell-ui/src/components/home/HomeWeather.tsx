import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  LocateFixed,
  MapPin,
  Moon,
  Search,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import {
  defaultUnit,
  fetchWeather,
  loadWeatherMemory,
  locateByIp,
  LOCATION_TTL_MS,
  samePlace,
  saveWeatherMemory,
  searchPlaces,
  unitSymbol,
  WEATHER_TTL_MS,
  weatherKind,
  weatherLabel,
  type TemperatureUnit,
  type WeatherKind,
  type WeatherMemory,
  type WeatherPlace,
  type WeatherReading,
} from "../../lib/weather";
import { useAppStore } from "../../store";

const ICONS: Record<WeatherKind, { day: LucideIcon; night: LucideIcon }> = {
  clear: { day: Sun, night: Moon },
  "partly-cloudy": { day: CloudSun, night: CloudMoon },
  cloudy: { day: Cloud, night: Cloud },
  fog: { day: CloudFog, night: CloudFog },
  drizzle: { day: CloudDrizzle, night: CloudDrizzle },
  rain: { day: CloudRain, night: CloudRain },
  snow: { day: CloudSnow, night: CloudSnow },
  thunderstorm: { day: CloudLightning, night: CloudLightning },
};

function weatherIcon(reading: WeatherReading): LucideIcon {
  const icons = ICONS[weatherKind(reading.code)];
  return reading.isDay ? icons.day : icons.night;
}

/** A reading in another unit: switching °F/°C shows at once, before the refetch lands. */
function inUnit(reading: WeatherReading, unit: TemperatureUnit): WeatherReading {
  if (reading.unit === unit) return reading;
  const convert = (value: number) => (unit === "celsius" ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32);
  return {
    ...reading,
    unit,
    temperature: convert(reading.temperature),
    feelsLike: convert(reading.feelsLike),
    high: reading.high === null ? null : convert(reading.high),
    low: reading.low === null ? null : convert(reading.low),
  };
}

const degrees = (value: number | null): string => (value === null ? "–" : `${String(Math.round(value))}°`);

const browserFetch = (input: string, init?: { signal?: AbortSignal }) => window.fetch(input, init);

interface WeatherState {
  memory: WeatherMemory;
  loading: boolean;
  failed: boolean;
  update: (patch: Partial<WeatherMemory>) => void;
}

/**
 * One weather for every home page in the window (a split can show two), kept
 * in this browser's storage (lib/weather.ts) so the next page paints the last
 * reading at once. A request belongs to the store, not to the page that
 * asked: a home page left before its answer arrived still leaves the answer
 * behind for the next one.
 */
const useWeatherStore = create<WeatherState>((set, get) => ({
  memory: loadWeatherMemory(),
  loading: false,
  failed: false,
  update: (patch) => {
    const next = { ...get().memory, ...patch };
    saveWeatherMemory(next);
    set({ memory: next });
  },
}));

const unitOf = (memory: WeatherMemory): TemperatureUnit => memory.unit ?? defaultUnit(navigator.language);

let running = false;
let again = false;

/**
 * Bring the reading up to date: a chosen place, else the place the
 * person's address puts them (looked up again every few hours), fetched
 * again once fifteen minutes old or for another place or unit. Calls while
 * one is under way fold into a single rerun after it, so a change of place
 * mid-request is never answered with the old place's weather.
 */
function refreshWeather(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void (async () => {
    do {
      again = false;
      await refreshOnce();
    } while (again);
    running = false;
  })();
}

async function refreshOnce(): Promise<void> {
  const store = useWeatherStore;
  const memory = store.getState().memory;
  const unit = unitOf(memory);
  const now = Date.now();
  let place = memory.chosenPlace;
  if (place === null) {
    const located = memory.located;
    if (located !== null && now - located.at < LOCATION_TTL_MS) {
      place = located.place;
    } else {
      store.setState({ loading: true });
      const found = await locateByIp(browserFetch).catch(() => null);
      if (found === null) {
        store.setState({ loading: false, failed: true });
        return;
      }
      place = found;
      store.getState().update({ located: { place: found, at: now } });
    }
  }
  const reading = memory.reading;
  if (reading !== null && reading.unit === unit && samePlace(reading.place, place) && now - reading.fetchedAt < WEATHER_TTL_MS) {
    store.setState({ loading: false, failed: false });
    return;
  }
  store.setState({ loading: true });
  try {
    const next = await fetchWeather(place, unit, browserFetch, Date.now());
    // The person may have chosen somewhere else meanwhile; that choice has
    // its own run queued, and this answer is still true of its own place.
    store.getState().update({ reading: next });
    store.setState({ failed: false });
  } catch {
    store.setState({ failed: true });
  } finally {
    store.setState({ loading: false });
  }
}

function useWeather() {
  const memory = useWeatherStore((s) => s.memory);
  const loading = useWeatherStore((s) => s.loading);
  const failed = useWeatherStore((s) => s.failed);
  const update = useWeatherStore((s) => s.update);
  const unit = unitOf(memory);

  useEffect(() => {
    refreshWeather();
  }, [memory.chosenPlace, unit]);

  useEffect(() => {
    const interval = window.setInterval(refreshWeather, WEATHER_TTL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshWeather();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const place = memory.chosenPlace ?? memory.located?.place ?? null;
  const shown =
    memory.reading !== null && (place === null || samePlace(memory.reading.place, place)) ? inUnit(memory.reading, unit) : null;
  return {
    reading: shown,
    place,
    unit,
    chosen: memory.chosenPlace !== null,
    loading,
    failed: failed && shown === null,
    choosePlace: (next: WeatherPlace) => update({ chosenPlace: next }),
    followAddress: () => update({ chosenPlace: null }),
    setUnit: (next: TemperatureUnit) => update({ unit: next }),
  };
}

/** The weather in the header: an icon and the temperature, opening the details and the place. */
export function HomeWeather() {
  const weather = useWeather();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { reading } = weather;
  const Icon = reading === null ? MapPin : weatherIcon(reading);
  const summary =
    reading === null
      ? weather.failed
        ? "Weather unavailable — choose a place"
        : "Loading the weather"
      : `${weatherLabel(reading.code)}, ${degrees(reading.temperature)} in ${reading.place.name}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="home-weather"
        aria-label={summary}
        aria-expanded={open}
        title={summary}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-gray-900 transition-colors hover:bg-alpha-100",
          open && "bg-alpha-100",
          reading === null && !weather.failed && "opacity-60",
        )}
      >
        <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {reading === null ? (
          weather.failed ? <span className="text-[13px]">Weather</span> : <span className="w-6 animate-pulse rounded bg-alpha-200 text-transparent">00</span>
        ) : (
          <span data-testid="home-weather-temperature">{degrees(reading.temperature)}</span>
        )}
      </button>
      {open ? <WeatherPanel weather={weather} onDone={() => setOpen(false)} /> : null}
    </div>
  );
}

function WeatherPanel({ weather, onDone }: { weather: ReturnType<typeof useWeather>; onDone: () => void }) {
  const createTab = useAppStore((s) => s.createTab);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const { reading } = weather;

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchPlaces(text, browserFetch, controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) setResults(found);
        })
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const Icon = reading === null ? MapPin : weatherIcon(reading);

  return (
    <div
      role="dialog"
      aria-label="Weather"
      data-testid="home-weather-panel"
      className="absolute top-full right-0 z-40 mt-2 w-[296px] max-w-[calc(100vw-32px)] rounded-2xl bg-background-100 p-4 text-left shadow-menu"
    >
      {reading === null ? (
        <p className="text-[13px] text-gray-900">
          {weather.loading ? "Finding the weather…" : "The weather could not be loaded. Choose a place below."}
        </p>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-gray-1000">{reading.place.name}</p>
            {reading.place.region !== "" ? <p className="truncate text-[12px] text-gray-700">{reading.place.region}</p> : null}
            <p className="mt-2 text-[13px] text-gray-900">{weatherLabel(reading.code)}</p>
            <p className="text-[12px] text-gray-700">
              Feels like {degrees(reading.feelsLike)} · H {degrees(reading.high)} L {degrees(reading.low)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[30px] font-semibold tracking-[-0.03em] text-gray-1000 tabular-nums">
            <Icon className="size-7 text-gray-900" strokeWidth={1.5} aria-hidden="true" />
            {degrees(reading.temperature)}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[12px] text-gray-700">Units</span>
        <div role="radiogroup" aria-label="Temperature unit" className="flex rounded-lg bg-alpha-100 p-0.5">
          {(["fahrenheit", "celsius"] as const).map((unit) => (
            <button
              key={unit}
              type="button"
              role="radio"
              aria-checked={weather.unit === unit}
              onClick={() => weather.setUnit(unit)}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                weather.unit === unit ? "bg-background-100 text-gray-1000 shadow-small" : "text-gray-800 hover:text-gray-1000",
              )}
            >
              {unitSymbol(unit)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <label className="flex h-9 items-center gap-2 rounded-lg bg-alpha-100 px-2.5 text-gray-700 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            type="text"
            value={query}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search for a place"
            placeholder="Change location…"
            data-testid="home-weather-place"
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-gray-1000 outline-none placeholder:text-gray-700"
          />
        </label>
        {results.length > 0 ? (
          <ul className="mt-1.5 max-h-44 overflow-y-auto">
            {results.map((result) => (
              <li key={`${String(result.latitude)},${String(result.longitude)}`}>
                <button
                  type="button"
                  onClick={() => {
                    weather.choosePlace(result);
                    setQuery("");
                    onDone();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-alpha-100"
                >
                  <MapPin className="size-3.5 shrink-0 text-gray-700" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-gray-1000">{result.name}</span>
                  <span className="max-w-[120px] shrink-0 truncate text-[11px] text-gray-700">{result.region}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : query.trim().length >= 2 && !searching ? (
          <p className="mt-2 px-1 text-[12px] text-gray-700">No places match.</p>
        ) : null}
        {weather.chosen ? (
          <button
            type="button"
            onClick={() => {
              weather.followAddress();
              onDone();
            }}
            className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-gray-900 hover:bg-alpha-100"
          >
            <LocateFixed className="size-3.5" aria-hidden="true" />
            Use my current location
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-[11px] text-gray-700">
        {weather.chosen ? "Showing a place you chose." : "Located from your network address."}{" "}
        <button type="button" className="cursor-pointer underline decoration-alpha-500 underline-offset-2 hover:text-gray-900" onClick={() => void createTab("https://open-meteo.com/")}>
          Weather data by Open-Meteo
        </button>
      </p>
    </div>
  );
}
