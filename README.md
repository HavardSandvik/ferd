# ferð

A clean live flight map. Single-page web app hosted on GitHub Pages.

- Live aircraft positions from keyless community ADS-B feeds (adsb.lol, adsb.fi, airplanes.live), fetched through a small Cloudflare Worker relay (`relay/worker.js`) because the feeds block direct browser requests
- Colour by altitude, smooth movement between refreshes, tap for details, follow, callsign search
- OpenStreetMap tiles, muted for light and dark mode

Planned: FlightAware AeroAPI via the relay, a "My trips" view, then push alerts.
