import { describe, expect, it } from "vitest";
import {
  defaultUnit,
  EMPTY_WEATHER_MEMORY,
  fetchWeather,
  forecastUrl,
  locateByIp,
  parseForecast,
  parseIpLocation,
  parsePlaces,
  parseWeatherMemory,
  samePlace,
  searchPlaces,
  serializeWeatherMemory,
  weatherKind,
  weatherLabel,
  type WeatherPlace,
} from "../src/lib/weather";

const austin: WeatherPlace = { name: "Austin", region: "Texas, US", latitude: 30.26715, longitude: -97.74306 };

/** The shape Open-Meteo answered with when this module was written. */
const FORECAST = {
  latitude: 30.269146,
  longitude: -97.75338,
  timezone: "America/Chicago",
  current_units: { temperature_2m: "°F" },
  current: { time: "2026-09-11T16:00", interval: 900, temperature_2m: 100.6, apparent_temperature: 104.3, weather_code: 0, is_day: 1 },
  daily: { time: ["2026-09-11"], temperature_2m_max: [100.6], temperature_2m_min: [77.5] },
};

const answering = (body: unknown, ok = true) => {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    return Promise.resolve({ ok, json: () => Promise.resolve(body) });
  };
  return { calls, fetcher };
};

describe("conditions", () => {
  it("names and draws every WMO group", () => {
    expect([0, 1, 2, 3, 45, 53, 63, 81, 73, 86, 95].map(weatherKind)).toEqual([
      "clear",
      "clear",
      "partly-cloudy",
      "cloudy",
      "fog",
      "drizzle",
      "rain",
      "rain",
      "snow",
      "snow",
      "thunderstorm",
    ]);
    expect(weatherLabel(2)).toBe("Partly cloudy");
    expect(weatherLabel(1234)).toBe("Weather");
  });

  it("reads Fahrenheit where people do and Celsius elsewhere", () => {
    expect(defaultUnit("en-US")).toBe("fahrenheit");
    expect(defaultUnit("en")).toBe("fahrenheit");
    expect(defaultUnit("en-GB")).toBe("celsius");
    expect(defaultUnit("de-DE")).toBe("celsius");
    expect(defaultUnit("fr")).toBe("celsius");
  });
});

describe("answers", () => {
  it("reads the current conditions and the day's range", () => {
    expect(parseForecast(FORECAST, austin, "fahrenheit", 7)).toEqual({
      place: austin,
      unit: "fahrenheit",
      temperature: 100.6,
      feelsLike: 104.3,
      high: 100.6,
      low: 77.5,
      code: 0,
      isDay: true,
      fetchedAt: 7,
    });
    expect(parseForecast({ current: { temperature_2m: "hot" } }, austin, "celsius", 0)).toBeNull();
    expect(parseForecast(null, austin, "celsius", 0)).toBeNull();
  });

  it("places the requester from geojs, whose coordinates are strings", () => {
    expect(
      parseIpLocation({ city: "New York", region: "New York", country_code: "US", latitude: "40.7149", longitude: "-73.9893" }),
    ).toEqual({ name: "New York", region: "New York, US", latitude: 40.7149, longitude: -73.9893 });
    expect(parseIpLocation({ country: "Iceland", latitude: "64.1", longitude: "-21.9" })).toMatchObject({ name: "Iceland" });
    expect(parseIpLocation({ city: "Nowhere", latitude: "999", longitude: "0" })).toBeNull();
    expect(parseIpLocation("nope")).toBeNull();
  });

  it("reads geocoding results as places", () => {
    expect(
      parsePlaces({
        results: [
          { name: "Austin", latitude: 30.26715, longitude: -97.74306, admin1: "Texas", country_code: "US" },
          { name: "", latitude: 1, longitude: 1 },
        ],
      }),
    ).toEqual([austin]);
    expect(parsePlaces({})).toEqual([]);
  });
});

describe("requests", () => {
  it("asks Open-Meteo for the place in the unit, on the place's own calendar day", async () => {
    const { calls, fetcher } = answering(FORECAST);
    const reading = await fetchWeather(austin, "celsius", fetcher, 1);
    expect(reading.temperature).toBe(100.6);
    const url = new URL(calls[0]!);
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.searchParams.get("temperature_unit")).toBe("celsius");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("latitude")).toBe("30.2672");
    expect(forecastUrl(austin, "fahrenheit")).toContain("current=temperature_2m%2Capparent_temperature%2Cweather_code%2Cis_day");
  });

  it("fails loudly on an error answer rather than showing nothing as weather", async () => {
    await expect(fetchWeather(austin, "celsius", answering({}, false).fetcher, 1)).rejects.toThrow(/weather request failed/u);
    await expect(fetchWeather(austin, "celsius", answering({}).fetcher, 1)).rejects.toThrow(/no current conditions/u);
  });

  it("gives every request a deadline, alongside the caller's own cancel", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fetcher = (_url: string, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(FORECAST) });
    };
    await fetchWeather(austin, "celsius", fetcher, 1);
    const cancel = new AbortController();
    await fetchWeather(austin, "celsius", fetcher, 1, cancel.signal);
    expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
    cancel.abort();
    expect(seen[1]?.aborted).toBe(true);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("searches places only for a real query", async () => {
    const { calls, fetcher } = answering({ results: [] });
    expect(await searchPlaces(" a ", fetcher)).toEqual([]);
    expect(calls).toEqual([]);
    await searchPlaces("Austin", fetcher);
    expect(new URL(calls[0]!).searchParams.get("name")).toBe("Austin");
  });

  it("locates by address", async () => {
    const { calls, fetcher } = answering({ city: "Austin", region: "Texas", country_code: "US", latitude: "30.2", longitude: "-97.7" });
    expect(await locateByIp(fetcher)).toMatchObject({ name: "Austin" });
    expect(calls).toEqual(["https://get.geojs.io/v1/ip/geo.json"]);
  });
});

describe("memory", () => {
  it("round-trips what it keeps and forgets anything malformed", () => {
    const reading = parseForecast(FORECAST, austin, "fahrenheit", 42)!;
    const memory = { chosenPlace: austin, unit: "celsius" as const, located: { place: austin, at: 5 }, reading };
    expect(parseWeatherMemory(serializeWeatherMemory(memory))).toEqual(memory);
    expect(parseWeatherMemory("{broken")).toEqual(EMPTY_WEATHER_MEMORY);
    expect(parseWeatherMemory(JSON.stringify({ chosenPlace: { name: "X", latitude: 500, longitude: 0 }, unit: "kelvin" }))).toEqual(
      EMPTY_WEATHER_MEMORY,
    );
  });

  it("treats places a few metres apart as the same place", () => {
    expect(samePlace(austin, { ...austin, latitude: austin.latitude + 0.001 })).toBe(true);
    expect(samePlace(austin, { ...austin, latitude: austin.latitude + 0.5 })).toBe(false);
  });
});
