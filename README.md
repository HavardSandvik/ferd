# ferð

A clean live flight map. Single-page web app hosted on GitHub Pages.

- Live aircraft positions from the OpenSky Network, fetched through a small Cloudflare Worker relay (`relay/worker.js`) that holds the OpenSky API credentials and adds CORS
- Colour by altitude, smooth movement between refreshes, tap for details, follow, callsign search
- OpenStreetMap tiles, muted for light and dark mode

Planned: FlightAware AeroAPI via the relay, a "My trips" view, then push alerts.
