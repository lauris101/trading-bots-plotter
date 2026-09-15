# trading-bots-plotter

Trade forensics for [trading-bots](https://github.com/lauris101/trading-bots):
a local web page that draws a window of time for one bot and one instrument,
with both venues' quotes and every order event on top of them.

- Lines: Binance bid/ask (thin), Hyperliquid bid/ask (thick), as step lines;
  the ask is dashed. Every line toggles on its own in the legend.
- Markers, one per order event, coloured by side (buy green, sell red), with
  the whole record on hover. An insert is a right-pointing triangle, solid
  when the order filled and outline only when it did not; fills are dots;
  cancels are crosses; a rejection is a circled cross; an amend (a resting
  order re-priced in place) is a bar at the price it moved to. An open's marker also
  carries the decision the calculator recorded: deviation, raw deviation,
  basis, rho, delta, threshold, expected gain.
- Lower pane: the leader's mid over the lagger's mid in basis points, with
  the open threshold of the last decision as dashed lines.
- Drag a box to zoom into it; two-finger trackpad scroll pans; pinch or
  ctrl + wheel zooms around the cursor; double-click shows the whole loaded
  window.

Reads Postgres (`bot_orders`, `bot_order_events`) and ClickHouse (`quotes`);
writes nothing. Rust (axum) serves the data as JSON; the page draws on one
2D canvas by hand and only when something changes, so it costs nothing while
idle. Windows above 12 000 quotes per venue are bucketed server-side to the
last quote per bucket.

## Run

Configuration is one `.env` file, read both by the native binary and by
docker compose:

```bash
cp .env.example .env     # fill in the two passwords (trading-bots-db/.env)
```

### Docker

```bash
docker compose up -d --build plotter     # or: just up
docker compose logs -f plotter           # just logs
docker compose down                      # just down
```

The image builds the release binary in a `rust:1.98` stage and ships it on
`debian:bookworm-slim` (about 100 MB, runs as `nobody`). The container
listens on port 8095 and the port is published on `PLOTTER_BIND` only
(default `127.0.0.1`; set the VPN address, e.g. `10.0.0.1`, to reach it
over WireGuard). Docker publishes ports around the host firewall, so do not
set it to `0.0.0.0` on a host with a public address.

Reaching Postgres from the container:

- Tunnel on the host (`just tunnels` in `trading-bots-host-setup/cloudflare`,
  or `cloudflared access tcp --hostname db.<domain> --url 127.0.0.1:15432`):
  `DATABASE_URL=postgres://...@host.docker.internal:15432/...`.
- Tunnel as a sidecar, on a host whose address is on the Access bypass list:
  `docker compose --profile tunnel up -d --build` (`just up-tunnel`) and
  `DATABASE_URL=postgres://...@tunnel:15432/...`. `DB_TUNNEL_HOSTNAME` names
  the Access hostname.

ClickHouse is reached over HTTPS by hostname (`CLICKHOUSE_URL`), or through
the host's forward at `http://host.docker.internal:18123`.

### Native

```bash
just run                 # debug build; or: just run-release
```

Open http://127.0.0.1:8095. Live orders are shown by default (the mode
selector also offers dummy, or both). The bot and instrument with the newest
live orders are preselected, centred on the newest order; click any order in
the list to centre on it; `←` / `→` shift the window by half its length.

## Layout

```
src/main.rs        the server: /api/bots, /api/orders, /api/window
static/index.html  the page
static/app.js      the plot
```

`/api/window?bot=&instrument=&from_ms=&to_ms=&mode=` returns the quotes of
every venue in the window plus the events, joined to their orders. At most
six hours per window.
