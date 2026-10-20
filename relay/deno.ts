// ferd relay — Deno Deploy version of worker.js (same API, same sources).
// Fetches aircraft near a point and returns readsb-v2-style JSON with CORS headers.
//
// GET /near?lat=51.5&lon=-0.12&nm=120
//
// Sources, in order: the community ADS-B feeds (adsb.lol, adsb.fi, airplanes.live), then
// OpenSky Network. OpenSky credentials are environment variables on the Deno Deploy project:
// OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.
// If every source fails, the last good result for the area (up to 5 min old) is returned.

const VERSION = 4;
const HOST = 'deno';

type Aircraft = Record<string, unknown>;
type Result = { v: number; host: string; source: string; ac: Aircraft[] };

const COMMUNITY = [
  { name: 'adsb.lol',       url: (la: string, lo: string, nm: number) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'adsb.fi',        url: (la: string, lo: string, nm: number) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'airplanes.live', url: (la: string, lo: string, nm: number) => `https://api.airplanes.live/v2/point/${la}/${lo}/${nm}` },
];

const ALLOWED_ORIGINS = [
  'https://havardsandvik.github.io',
  'http://localhost:8000',
];

const OPENSKY_API = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let token: string | null = null, tokenExpires = 0;   // cached per isolate

// In-memory cache per isolate: fresh for 10 s, kept as a stale fallback for 5 min.
const FRESH_MS = 10_000, STALE_MS = 300_000;
const cache = new Map<string, { body: string; at: number }>();

function cors(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function getToken(): Promise<string | null> {
  const id = Deno.env.get('OPENSKY_CLIENT_ID'), secret = Deno.env.get('OPENSKY_CLIENT_SECRET');
  if (!id || !secret) return null;
  if (token && Date.now() < tokenExpires - 60000) return token;
  const r = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  tokenExpires = Date.now() + (j.expires_in || 1800) * 1000;
  return token;
}

// OpenSky state vector -> readsb-v2-style aircraft object (feet, knots, ft/min)
// deno-lint-ignore no-explicit-any
function fromOpenSky(s: any[]): Aircraft {
  const [hex, cs, , , lastContact, lon, lat, baro, ground, vel, trk, vr, , geo, sq] = s;
  const m2ft = 3.28084;
  const altM = baro ?? geo;
  return {
    hex, flight: (cs || '').trim(), lat, lon,
    alt_baro: ground ? 'ground' : altM != null ? Math.round(altM * m2ft) : undefined,
    gs: vel != null ? vel * 1.94384 : undefined,
    track: trk ?? undefined,
    baro_rate: vr != null ? Math.round(vr * 196.85) : undefined,
    squawk: sq || undefined,
    seen_pos: lastContact ? Math.max(0, Date.now() / 1000 - lastContact) : undefined,
  };
}

async function openSky(lat: number, lon: number, nm: number): Promise<Aircraft[]> {
  const dLat = nm / 60;
  const dLon = nm / (60 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  const q = new URLSearchParams({
    lamin: Math.max(-90, lat - dLat).toFixed(2), lamax: Math.min(90, lat + dLat).toFixed(2),
    lomin: Math.max(-180, lon - dLon).toFixed(2), lomax: Math.min(180, lon + dLon).toFixed(2),
  });
  const t = await getToken();
  const r = await fetch(`${OPENSKY_API}?${q}`, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 401) token = null;
  if (!r.ok) throw new Error(`${t ? '' : 'anon '}${r.status}`);
  const j = await r.json();
  // deno-lint-ignore no-explicit-any
  return (j.states || []).filter((s: any[]) => s[5] != null && s[6] != null).map(fromOpenSky);
}

function errName(e: unknown): string {
  return e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : 'error';
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/near') {
    return json({ error: 'not found' }, 404, origin);
  }

  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const nm = Math.round(Number(url.searchParams.get('nm')));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      !Number.isFinite(nm) || nm < 1 || nm > 250) {
    return json({ error: 'bad parameters' }, 400, origin);
  }

  const la = lat.toFixed(1), lo = lon.toFixed(1), nmR = Math.ceil(nm / 10) * 10;
  const key = `${la},${lo},${nmR}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  }

  const errors: string[] = [];
  let result: Result | null = null;
  for (const p of COMMUNITY) {
    try {
      const r = await fetch(p.url(la, lo, nmR), {
        headers: { 'User-Agent': 'ferd-relay (personal flight map)' },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) { errors.push(`${p.name} ${r.status}`); continue; }
      const data = await r.json();
      result = { v: VERSION, host: HOST, source: p.name, ac: data.ac || data.aircraft || [] };
      break;
    } catch (e) {
      errors.push(`${p.name} ${errName(e) === 'timeout' ? 'timeout' : 'error'}`);
    }
  }
  if (!result) {
    try {
      result = { v: VERSION, host: HOST, source: 'opensky', ac: await openSky(Number(la), Number(lo), nmR) };
    } catch (e) {
      errors.push(`opensky ${errName(e)}`);
    }
  }
  if (!result) {
    if (hit && Date.now() - hit.at < STALE_MS) {
      return json({ ...JSON.parse(hit.body), stale: true, detail: errors }, 200, origin);
    }
    return json({ v: VERSION, host: HOST, error: 'all feeds failed', detail: errors }, 502, origin);
  }

  const body = JSON.stringify(result);
  cache.set(key, { body, at: Date.now() });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > STALE_MS) cache.delete(k);
  }
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors(origin) } });
});
