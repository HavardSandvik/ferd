// ferd relay — Cloudflare Worker
// Fetches aircraft near a point and returns readsb-v2-style JSON with CORS headers.
//
// GET /near?lat=51.5&lon=-0.12&nm=120
//
// Primary source: OpenSky Network. Add your OpenSky API client as Worker secrets
// (Settings → Variables and Secrets): OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.
// Without them it tries OpenSky anonymously, which is heavily rate-limited from Cloudflare.
// If OpenSky fails or is slow, the last good result for the area (up to 5 min old) is returned.

const ALLOWED_ORIGINS = [
  'https://havardsandvik.github.io',
  'http://localhost:8000',
];

const OPENSKY_API = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';


let token = null, tokenExpires = 0;   // cached per Worker isolate

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin), ...extra },
  });
}

async function getToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (token && Date.now() < tokenExpires - 60000) return token;
  const r = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  tokenExpires = Date.now() + (j.expires_in || 1800) * 1000;
  return token;
}

// OpenSky state vector -> readsb-v2-style aircraft object (feet, knots, ft/min)
function fromOpenSky(s) {
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

async function openSky(lat, lon, nm, env) {
  const dLat = nm / 60;
  const dLon = nm / (60 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  const q = new URLSearchParams({
    lamin: Math.max(-90, lat - dLat).toFixed(2), lamax: Math.min(90, lat + dLat).toFixed(2),
    lomin: Math.max(-180, lon - dLon).toFixed(2), lomax: Math.min(180, lon + dLon).toFixed(2),
  });
  const t = await getToken(env);
  const r = await fetch(`${OPENSKY_API}?${q}`, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) token = null;
  if (!r.ok) throw new Error(`${t ? '' : 'anon '}${r.status}`);
  const j = await r.json();
  return (j.states || []).filter(s => s[5] != null && s[6] != null).map(fromOpenSky);
}

export default {
  async fetch(request, env, ctx) {
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

    // Short shared cache so repeated views of the same area don't spend extra credits.
    const la = lat.toFixed(1), lo = lon.toFixed(1), nmR = Math.ceil(nm / 10) * 10;
    const cacheKey = new Request(`https://ferd-relay.cache/near?lat=${la}&lon=${lo}&nm=${nmR}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    }

    const staleKey = new Request(cacheKey.url + '&stale=1');
    let result;
    try {
      result = { source: 'opensky', ac: await openSky(Number(la), Number(lo), nmR, env) };
    } catch (e) {
      const why = `opensky ${e.name === 'TimeoutError' ? 'timeout' : e.message}`;
      const old = await cache.match(staleKey);
      if (old) {
        const j = await old.json();
        return json({ ...j, stale: true, detail: [why] }, 200, origin);
      }
      return json({ error: 'feed failed', detail: [why] }, 502, origin);
    }

    const body = JSON.stringify(result);
    ctx.waitUntil(Promise.all([
      cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } })),
      cache.put(staleKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })),
    ]));
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  },
};
