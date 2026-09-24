/**
 * The home page's weather (components/home/HomeWeather.tsx). Pure apart from
 * the `fetch` each call is handed, so the parsing is testable without a
 * network.
 *
 * WHERE. The shell runs in the person's own browser on both surfaces — the
 * desktop's renderer, or the web app's tab — so a request from here leaves
 * from where the person is, never from the cloud worker. That makes the
 * requester's address a fair city-level answer (`locateByIp`, geojs.io),
 * with no permission prompt on a page nobody asked to share a location
 * from. A place the person picks (`searchPlaces`) overrides it.
 *
 * WHAT. Open-Meteo's forecast: national weather models, no key, served with
 * CORS to any origin. `timezone=auto` makes the day's high and low the
 * PLACE's calendar day.
 */

export type TemperatureUnit = "fahrenheit" | "celsius";

export interface WeatherPlace {
  /** "Austin" — what the widget calls it. */
  name: string;
  /** "Texas, US" — enough to tell two Springfields apart. */
  region: string;
  latitude: number;
  longitude: number;
}

export interface WeatherReading {
  place: WeatherPlace;
  unit: TemperatureUnit;
  /** Degrees in `unit`, as reported (the widget rounds). */
  temperature: number;
  feelsLike: number;
  high: number | null;
  low: number | null;
  /** WMO weather interpretation code. */
  code: number;
  isDay: boolean;
  fetchedAt: number;
}

export type WeatherKind = "clear" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "thunderstorm";

type Fetch = (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** How long a reading stands before it is fetched again. */
export const WEATHER_TTL_MS = 15 * 60_000;
/** How long an address-based location stands: people move, but not every page view. */
export const LOCATION_TTL_MS = 6 * 60 * 60_000;

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const IP_LOCATION_URL = "https://get.geojs.io/v1/ip/geo.json";

/** Every host this module talks to — the desktop renderer's CSP lists exactly these. */
export const WEATHER_ORIGINS = [
  "https://api.open-meteo.com",
  "https://geocoding-api.open-meteo.com",
  "https://get.geojs.io",
] as const;

/* ------------------------------ conditions ------------------------------ */

const LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

/** What a WMO code says, in words. */
export function weatherLabel(code: number): string {
  return LABELS[code] ?? "Weather";
}

/** Which icon a WMO code is drawn with. */
export function weatherKind(code: number): WeatherKind {
  if (code <= 1) return "clear";
  if (code === 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunderstorm";
  return "cloudy";
}

/**
 * The unit a locale reads temperatures in: Fahrenheit where that is the
 * everyday scale (the US and a handful of others), Celsius everywhere else.
 */
export function defaultUnit(locale: string): TemperatureUnit {
  const region = /[-_]([A-Za-z]{2})\b/u.exec(locale)?.[1]?.toUpperCase() ?? (/^en$/iu.test(locale) ? "US" : "");
  return ["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH", "PR", "GU", "VI", "AS", "MP", "UM"].includes(region)
    ? "fahrenheit"
    : "celsius";
}

export function unitSymbol(unit: TemperatureUnit): string {
  return unit === "fahrenheit" ? "°F" : "°C";
}

/* -------------------------------- parsing -------------------------------- */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function text(value: unknown, max = 80): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validPlace(latitude: number | null, longitude: number | null): latitude is number {
  return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/** geojs.io's answer for the requester's address, or null when it names nowhere usable. */
export function parseIpLocation(body: unknown): WeatherPlace | null {
  const data = record(body);
  if (data === null) return null;
  const latitude = finite(data["latitude"]);
  const longitude = finite(data["longitude"]);
  if (!validPlace(latitude, longitude)) return null;
  const city = text(data["city"]);
  const region = text(data["region"]);
  const country = text(data["country_code"], 3) || text(data["country"]);
  return {
    name: city || region || country || "Your area",
    region: [city === "" ? "" : region, country].filter(Boolean).join(", "),
    latitude,
    longitude: longitude!,
  };
}

/** Open-Meteo geocoding results, as places to choose from. */
export function parsePlaces(body: unknown): WeatherPlace[] {
  const results = record(body)?.["results"];
  if (!Array.isArray(results)) return [];
  return results.flatMap((result): WeatherPlace[] => {
    const data = record(result);
    if (data === null) return [];
    const latitude = finite(data["latitude"]);
    const longitude = finite(data["longitude"]);
    const name = text(data["name"]);
    if (!validPlace(latitude, longitude) || name === "") return [];
    return [{ name, region: [text(data["admin1"]), text(data["country_code"], 3)].filter(Boolean).join(", "), latitude, longitude: longitude! }];
  });
}

/** An Open-Meteo forecast, or null when it is missing the current conditions. */
export function parseForecast(body: unknown, place: WeatherPlace, unit: TemperatureUnit, fetchedAt: number): WeatherReading | null {
  const data = record(body);
  const current = record(data?.["current"]);
  if (current === null) return null;
  const temperature = finite(current["temperature_2m"]);
  const code = finite(current["weather_code"]);
  if (temperature === null || code === null) return null;
  const daily = record(data?.["daily"]);
  const first = (key: string): number | null => {
    const series = daily?.[key];
    return Array.isArray(series) ? finite(series[0]) : null;
  };
  return {
    place,
    unit,
    temperature,
    feelsLike: finite(current["apparent_temperature"]) ?? temperature,
    high: first("temperature_2m_max"),
    low: first("temperature_2m_min"),
    code,
    isDay: current["is_day"] !== 0,
    fetchedAt,
  };
}

/* -------------------------------- requests ------------------------------- */

/**
 * How long one request may take. A network that swallows the request (a
 * captive portal, a proxy that never answers) must end in the widget's
 * "unavailable" state, not a placeholder that waits forever.
 */
export const WEATHER_REQUEST_TIMEOUT_MS = 10_000;

async function getJson(fetcher: Fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(WEATHER_REQUEST_TIMEOUT_MS);
  const response = await fetcher(url, { signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) });
  if (!response.ok) throw new Error(`weather request failed: ${url.split("?")[0] ?? url}`);
  return response.json();
}

/** Where the requester's address places them, or null when the lookup says nothing usable. */
export async function locateByIp(fetcher: Fetch, signal?: AbortSignal): Promise<WeatherPlace | null> {
  return parseIpLocation(await getJson(fetcher, IP_LOCATION_URL, signal));
}

/** Places matching what the person typed, best first. */
export async function searchPlaces(query: string, fetcher: Fetch, signal?: AbortSignal): Promise<WeatherPlace[]> {
  const name = query.trim();
  if (name.length < 2) return [];
  const params = new URLSearchParams({ name, count: "6", format: "json", language: "en" });
  return parsePlaces(await getJson(fetcher, `${GEOCODING_URL}?${params.toString()}`, signal));
}

export function forecastUrl(place: WeatherPlace, unit: TemperatureUnit): string {
  const params = new URLSearchParams({
    latitude: place.latitude.toFixed(4),
    longitude: place.longitude.toFixed(4),
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    daily: "temperature_2m_max,temperature_2m_min",
    temperature_unit: unit,
    timezone: "auto",
    forecast_days: "1",
  });
  return `${FORECAST_URL}?${params.toString()}`;
}

/** The current conditions at a place. */
export async function fetchWeather(
  place: WeatherPlace,
  unit: TemperatureUnit,
  fetcher: Fetch,
  now: number,
  signal?: AbortSignal,
): Promise<WeatherReading> {
  const reading = parseForecast(await getJson(fetcher, forecastUrl(place, unit), signal), place, unit, now);
  if (reading === null) throw new Error("the forecast had no current conditions");
  return reading;
}

/* ------------------------------ remembering ------------------------------ */

/**
 * What the widget keeps in this browser's storage: the place the person
 * chose (null follows their address), the unit they chose (null follows
 * the locale), the address-based place and when it was found, and the
 * last reading so the next page paints at once.
 */
export interface WeatherMemory {
  chosenPlace: WeatherPlace | null;
  unit: TemperatureUnit | null;
  located: { place: WeatherPlace; at: number } | null;
  reading: WeatherReading | null;
}

export const EMPTY_WEATHER_MEMORY: WeatherMemory = { chosenPlace: null, unit: null, located: null, reading: null };

const STORAGE_KEY = "pistachio.home.weather";

function place(value: unknown): WeatherPlace | null {
  const data = record(value);
  if (data === null) return null;
  const latitude = finite(data["latitude"]);
  const longitude = finite(data["longitude"]);
  const name = text(data["name"]);
  return validPlace(latitude, longitude) && name !== "" ? { name, region: text(data["region"]), latitude, longitude: longitude! } : null;
}

function unit(value: unknown): TemperatureUnit | null {
  return value === "fahrenheit" || value === "celsius" ? value : null;
}

/** Read back what `serializeWeatherMemory` wrote; anything malformed is forgotten, not trusted. */
export function parseWeatherMemory(raw: string | null): WeatherMemory {
  if (raw === null) return EMPTY_WEATHER_MEMORY;
  let data: Record<string, unknown> | null;
  try {
    data = record(JSON.parse(raw));
  } catch {
    return EMPTY_WEATHER_MEMORY;
  }
  if (data === null) return EMPTY_WEATHER_MEMORY;
  const located = record(data["located"]);
  const locatedPlace = place(located?.["place"]);
  const locatedAt = finite(located?.["at"]);
  const reading = record(data["reading"]);
  const readingPlace = place(reading?.["place"]);
  const readingUnit = unit(reading?.["unit"]);
  const parsedReading =
    reading === null || readingPlace === null || readingUnit === null
      ? null
      : parseForecast(
          {
            current: {
              temperature_2m: reading["temperature"],
              apparent_temperature: reading["feelsLike"],
              weather_code: reading["code"],
              is_day: reading["isDay"] === false ? 0 : 1,
            },
            daily: { temperature_2m_max: [reading["high"]], temperature_2m_min: [reading["low"]] },
          },
          readingPlace,
          readingUnit,
          finite(reading["fetchedAt"]) ?? 0,
        );
  return {
    chosenPlace: place(data["chosenPlace"]),
    unit: unit(data["unit"]),
    located: locatedPlace === null || locatedAt === null ? null : { place: locatedPlace, at: locatedAt },
    reading: parsedReading,
  };
}

export function serializeWeatherMemory(memory: WeatherMemory): string {
  return JSON.stringify(memory);
}

export function loadWeatherMemory(): WeatherMemory {
  try {
    return parseWeatherMemory(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_WEATHER_MEMORY;
  }
}

export function saveWeatherMemory(memory: WeatherMemory): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeWeatherMemory(memory));
  } catch {
    // A full or blocked store costs only the instant first paint.
  }
}

/** Whether two places are the same spot, to the precision a forecast cares about. */
export function samePlace(a: WeatherPlace, b: WeatherPlace): boolean {
  return Math.abs(a.latitude - b.latitude) < 0.01 && Math.abs(a.longitude - b.longitude) < 0.01;
}
