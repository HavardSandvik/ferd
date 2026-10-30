// ferd relay — Cloudflare Worker
// Fetches aircraft near a point and returns readsb-v2-style JSON with CORS headers.
//
// GET /near?lat=51.5&lon=-0.12&nm=120
//
// Sources, in order: the community ADS-B feeds (adsb.lol, adsb.fi, airplanes.live), then
// OpenSky Network (its token endpoint often doesn't answer Cloudflare, so it goes last).
// OpenSky credentials are Worker secrets: OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.
// If every source fails, the last good result for the area (up to 5 min old) is returned.

const VERSION = 4;

const COMMUNITY = [
  { name: 'adsb.lol',       url: (la, lo, nm) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'adsb.fi',        url: (la, lo, nm) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'airplanes.live', url: (la, lo, nm) => `https://api.airplanes.live/v2/point/${la}/${lo}/${nm}` },
];

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
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 401) token = null;
  if (!r.ok) throw new Error(`${t ? '' : 'anon '}${r.status}`);
  const j = await r.json();
  return (j.states || []).filter(s => s[5] != null && s[6] != null).map(fromOpenSky);
}

// ---------- flight status (FlightAware AeroAPI) ----------
// Needs the Worker secret FLIGHTAWARE_API_KEY. Each AeroAPI call is billed (Personal tier:
// $5/month free), so results are cached: flight status 2 min, positions 1 min.
const AEROAPI = 'https://aeroapi.flightaware.com/aeroapi';
const FLIGHT_FIELDS = [
  'fa_flight_id', 'ident', 'ident_iata', 'ident_icao', 'atc_ident', 'operator', 'operator_iata',
  'flight_number', 'registration', 'aircraft_type', 'status', 'cancelled', 'diverted', 'blocked',
  'progress_percent', 'departure_delay', 'arrival_delay', 'inbound_fa_id', 'route_distance',
  'scheduled_out', 'estimated_out', 'actual_out', 'scheduled_off', 'estimated_off', 'actual_off',
  'scheduled_on', 'estimated_on', 'actual_on', 'scheduled_in', 'estimated_in', 'actual_in',
  'gate_origin', 'gate_destination', 'terminal_origin', 'terminal_destination', 'baggage_claim',
];
const AIRPORT_FIELDS = ['code', 'code_iata', 'code_icao', 'name', 'city', 'timezone'];
const pick = (o, keys) => o ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : null;
const trimFlight = f => ({ ...pick(f, FLIGHT_FIELDS), origin: pick(f.origin, AIRPORT_FIELDS), destination: pick(f.destination, AIRPORT_FIELDS) });
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

async function aero(path, env) {
  const r = await fetch(AEROAPI + path, {
    headers: { 'x-apikey': env.FLIGHTAWARE_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const e = new Error(`flightaware ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// The flight to show: the first one that hasn't arrived and isn't long past, else the latest.
function relevantIndex(flights) {
  const now = Date.now();
  const t = f => Date.parse(f.scheduled_out || f.scheduled_off || f.scheduled_in || 0);
  const open = flights.map((f, i) => [f, i])
    .filter(([f]) => !f.actual_in && !f.actual_on && !f.cancelled && t(f) > now - 18 * 3600e3)
    .sort((a, b) => t(a[0]) - t(b[0]));
  if (open.length) return open[0][1];
  let best = 0;
  flights.forEach((f, i) => { if (t(f) <= now + 3600e3 && t(f) > t(flights[best])) best = i; });
  return best;
}

async function cached(key, ttl, ctx, make) {
  const cache = caches.default;
  const req = new Request(`https://ferd-relay.cache/${key}`);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const val = await make();
  ctx.waitUntil(cache.put(req, new Response(JSON.stringify(val), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })));
  return val;
}

// GET /flight?ident=DY1306  -> { flights: [...], index, inbound }
async function flightStatus(ident, env, ctx) {
  return cached(`flight3/${ident}`, 120, ctx, async () => {
    const now = Date.now();
    const q = new URLSearchParams({ start: iso(now - 30 * 3600e3), end: iso(now + 47 * 3600e3) });
    const j = await aero(`/flights/${encodeURIComponent(ident)}?${q}`, env);
    const flights = (j.flights || []).map(trimFlight)
      .sort((a, b) => Date.parse(a.scheduled_out || 0) - Date.parse(b.scheduled_out || 0));
    if (!flights.length) return { flights: [], index: -1, inbound: null };
    const index = relevantIndex(flights);
    const f = flights[index];
    // Where the aircraft is now: the flight that brings it in, while ours hasn't left yet.
    // Where the aircraft is, from its own flights (by registration), while ours hasn't left yet:
    //   current = the flight it's on now, or the last one it landed from
    //   inbound = the flight that brings it to our departure airport
    let inbound = null, current = null, aircraftNote = null;
    if (!f.actual_out && !f.actual_off && !f.cancelled && f.registration) {
      try {
        const dep = Date.parse(f.estimated_out || f.scheduled_out);
        const q2 = new URLSearchParams({ ident_type: 'registration', start: iso(Math.min(now, dep) - 24 * 3600e3), end: iso(dep + 3600e3) });
        const k = await aero(`/flights/${encodeURIComponent(f.registration.replace(/\s+/g, ''))}?${q2}`, env);
        const tOut = x => Date.parse(x.actual_out || x.actual_off || x.estimated_out || x.scheduled_out || 0);
        const others = (k.flights || []).filter(x => x.fa_flight_id !== f.fa_flight_id && !x.cancelled);
        const at = a => a && (a.code_icao || a.code);
        const started = others.filter(x => x.actual_out || x.actual_off).sort((a, b) => tOut(b) - tOut(a));
        if (started[0]) current = trimFlight(started[0]);
        const into = others.filter(x => at(x.destination) === at(f.origin) && tOut(x) < dep).sort((a, b) => tOut(b) - tOut(a));
        if (into[0]) inbound = trimFlight(into[0]);
        if (!others.length) aircraftNote = 'no other flights found for this aircraft';
      } catch (e) {
        aircraftNote = e.message;
      }
    }
    // No aircraft known yet: educated guess from the paired flight. Airlines often fly a route
    // as neighbouring numbers (DY1318 BGO->LGW, then DY1319 LGW->BGO), so look for the
    // number one below/above flying the reverse route into our airport shortly before we leave.
    let likely = null;
    const dep = Date.parse(f.estimated_out || f.scheduled_out || 0);
    if (!f.registration && !f.actual_out && !f.actual_off && !f.cancelled && dep && dep - now < 24 * 3600e3) {
      likely = await pairedInbound(f, dep, env).catch(() => null);
    }
    return { flights, index, inbound, current, likely, aircraftNote };
  });
}

async function pairedInbound(f, dep, env) {
  const m = /^([A-Z]{3})(\d{1,4})$/.exec(f.ident_icao || f.ident || '');
  if (!m) return null;
  const at = a => a && (a.code_icao || a.code);
  const tIn = x => Date.parse(x.actual_in || x.actual_on || x.estimated_in || x.estimated_on || x.scheduled_in || x.scheduled_on || 0);
  const q = new URLSearchParams({ start: iso(dep - 14 * 3600e3), end: iso(dep) });
  for (const n of [Number(m[2]) - 1, Number(m[2]) + 1]) {
    if (n < 1) continue;
    let j;
    try { j = await aero(`/flights/${m[1]}${n}?${q}`, env); } catch { continue; }
    const hit = (j.flights || [])
      .filter(x => !x.cancelled && at(x.origin) === at(f.destination) && at(x.destination) === at(f.origin))
      .filter(x => { const t = tIn(x); return t && t <= dep + 2 * 3600e3 && t >= dep - 10 * 3600e3; })
      .sort((a, b) => tIn(b) - tIn(a))[0];
    if (hit) return trimFlight(hit);
  }
  return null;
}

// GET /position?id=<fa_flight_id>  -> last known position
async function flightPosition(id, env, ctx) {
  return cached(`pos/${id}`, 60, ctx, async () => {
    const j = await aero(`/flights/${encodeURIComponent(id)}/position`, env);
    const p = j.last_position || null;
    return p ? pick(p, ['latitude', 'longitude', 'altitude', 'groundspeed', 'heading', 'timestamp', 'update_type']) : null;
  });
}

async function handleFlight(url, env, ctx, origin) {
  if (!env.FLIGHTAWARE_API_KEY) return json({ error: 'flight status not set up', detail: ['FLIGHTAWARE_API_KEY missing'] }, 503, origin);
  try {
    if (url.pathname === '/flight') {
      const ident = (url.searchParams.get('ident') || '').toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9]{3,8}$/.test(ident)) return json({ error: 'bad flight number' }, 400, origin);
      return json(await flightStatus(ident, env, ctx), 200, origin);
    }
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9\-]{6,60}$/.test(id)) return json({ error: 'bad id' }, 400, origin);
    return json({ position: await flightPosition(id, env, ctx) }, 200, origin);
  } catch (e) {
    const s = e.status === 404 ? 404 : e.status === 429 ? 429 : 502;
    return json({ error: e.status === 404 ? 'flight not found' : 'flight status failed', detail: [e.message] }, s, origin);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/flight' || url.pathname === '/position')) {
      return handleFlight(url, env, ctx, origin);
    }
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
    const errors = [];
    let result = null;
    for (const p of COMMUNITY) {
      try {
        const r = await fetch(p.url(la, lo, nmR), {
          headers: { 'User-Agent': 'ferd-relay (personal flight map)' },
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) { errors.push(`${p.name} ${r.status}`); continue; }
        const data = await r.json();
        result = { v: VERSION, source: p.name, ac: data.ac || data.aircraft || [] };
        break;
      } catch (e) {
        errors.push(`${p.name} ${e.name === 'TimeoutError' ? 'timeout' : 'error'}`);
      }
    }
    if (!result) {
      try {
        result = { v: VERSION, source: 'opensky', ac: await openSky(Number(la), Number(lo), nmR, env) };
      } catch (e) {
        errors.push(`opensky ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
      }
    }
    if (!result) {
      const old = await cache.match(staleKey);
      if (old) {
        const j = await old.json();
        return json({ ...j, stale: true, detail: errors }, 200, origin);
      }
      return json({ v: VERSION, error: 'all feeds failed', detail: errors }, 502, origin);
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
