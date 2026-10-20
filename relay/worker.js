// ferd relay — Cloudflare Worker
// Fetches aircraft near a point from keyless ADS-B feeds (server side, so no CORS problem)
// and returns the readsb v2 JSON with CORS headers for the ferd site.
//
// GET /near?lat=51.5&lon=-0.12&nm=120

const ALLOWED_ORIGINS = [
  'https://havardsandvik.github.io',
  'http://localhost:8000',
];

const PROVIDERS = [
  { name: 'adsb.lol',       url: (la, lo, nm) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'adsb.fi',        url: (la, lo, nm) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'airplanes.live', url: (la, lo, nm) => `https://api.airplanes.live/v2/point/${la}/${lo}/${nm}` },
];

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

export default {
  async fetch(request) {
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
    const la = lat.toFixed(2), lo = lon.toFixed(2);

    const errors = [];
    for (const p of PROVIDERS) {
      try {
        const r = await fetch(p.url(la, lo, nm), {
          headers: { 'User-Agent': 'ferd-relay (personal flight map)' },
          signal: AbortSignal.timeout(7000),
        });
        if (!r.ok) { errors.push(`${p.name} ${r.status}`); continue; }
        const data = await r.json();
        return json({ source: p.name, ac: data.ac || data.aircraft || [] }, 200, origin,
                    { 'Cache-Control': 'public, max-age=5' });
      } catch (e) {
        errors.push(`${p.name} ${e.name === 'TimeoutError' ? 'timeout' : 'error'}`);
      }
    }
    return json({ error: 'all feeds failed', detail: errors }, 502, origin);
  },
};
