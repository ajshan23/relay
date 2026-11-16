/*
 * Places for the "Send location" step's map picker: search and reverse lookup through OpenStreetMap's
 * Nominatim (free, no key; its policy asks for at most one request a second and a real User-Agent, so
 * calls are queued and cached here), and turning a pasted Google Maps link or coordinates into a pin.
 */

export type Place = { name: string; address: string; latitude: number; longitude: number };

const NOMINATIM = "https://nominatim.openstreetmap.org";
const USER_AGENT = "Relay/1.0 (automation location picker)";

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 24 * 60 * 60 * 1000;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** One Nominatim call at a time, at least a second apart, cached for a day. */
async function nominatim<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const call = queue.then(async () => {
    const wait = lastCall + 1_050 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(`${NOMINATIM}${path}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Place search answered ${res.status}`);
    return (await res.json()) as T;
  });
  queue = call.catch(() => {});
  const value = await call;
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  cache.set(path, { at: Date.now(), value });
  return value;
}

type NominatimPlace = { name?: string; display_name?: string; lat?: string; lon?: string };

function toPlace(p: NominatimPlace): Place | null {
  const latitude = Number(p.lat);
  const longitude = Number(p.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const full = (p.display_name ?? "").trim();
  const name = (p.name ?? "").trim() || full.split(",")[0]?.trim() || "";
  // The address without the name it starts with.
  const address = full.startsWith(`${name},`) ? full.slice(name.length + 1).trim() : full;
  return { name, address, latitude, longitude };
}

export async function searchPlaces(q: string): Promise<Place[]> {
  const query = q.trim().slice(0, 200);
  if (query.length < 2) return [];
  const rows = await nominatim<NominatimPlace[]>(
    `/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`,
  );
  // OpenStreetMap often has a building and its shop entries under one name: show each place once.
  const seen = new Set<string>();
  return rows
    .map(toPlace)
    .filter((p): p is Place => !!p)
    .filter((p) => {
      const key = `${p.name}|${p.address}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function reversePlace(latitude: number, longitude: number): Promise<Place | null> {
  if (!validPin(latitude, longitude)) return null;
  const row = await nominatim<NominatimPlace & { error?: string }>(
    `/reverse?format=jsonv2&zoom=18&lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`,
  );
  if (row.error) return null;
  const place = toPlace(row);
  return place ? { ...place, latitude, longitude } : null;
}

const validPin = (lat: number, lng: number) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

/**
 * Coordinates (and a place name, when the link has one) from pasted text: "25.08, 55.14", or a Google
 * Maps link with the pin in it (…!3d25.08!4d55.14, …@25.08,55.14,17z, …?q=25.08,55.14).
 */
export function parseMapText(text: string): { latitude: number; longitude: number; name: string } | null {
  const t = text.trim();
  let decoded = t;
  try {
    decoded = decodeURIComponent(t);
  } catch {}
  const patterns = [
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/,
    // The place's own pin, more exact than the map's centre.
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|center|destination|daddr)=(-?\d{1,2}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /\/(?:search|place|dir)\/(-?\d{1,2}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(decoded);
    if (!m) continue;
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (!validPin(latitude, longitude)) continue;
    const place = /\/maps\/place\/([^/@?]+)/.exec(t)?.[1];
    let name = "";
    if (place) {
      try {
        name = decodeURIComponent(place.replace(/\+/g, " ")).trim();
      } catch {}
      if (/^-?\d+\.\d+,/.test(name)) name = "";
    }
    return { latitude, longitude, name };
  }
  return null;
}

/** Only Google Maps hosts are followed, so this can't be used to make the server fetch anything else. */
export function isMapsHost(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return false;
  if (h === "maps.app.goo.gl") return true;
  if (h === "goo.gl") return url.pathname.startsWith("/maps");
  if (/^maps\.google\.[a-z.]{2,7}$/.test(h)) return true;
  return /^(www\.)?google\.[a-z.]{2,7}$/.test(h) && url.pathname.startsWith("/maps");
}

/** A pasted map link or coordinates → a pin. Short links are followed (Google hosts only, 5 hops). */
export async function resolveMapLink(
  text: string,
): Promise<{ latitude: number; longitude: number; name: string } | null> {
  const direct = parseMapText(text);
  if (direct) return direct;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  for (let hop = 0; hop < 5; hop++) {
    if (!isMapsHost(url)) return null;
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Relay)" },
      signal: AbortSignal.timeout(5_000),
    });
    const location = res.headers.get("location");
    if (!location || res.status < 300 || res.status >= 400) return null;
    const found = parseMapText(location);
    if (found) return found;
    url = new URL(location, url);
  }
  return null;
}
