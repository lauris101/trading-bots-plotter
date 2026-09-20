# trading-bots-plotter

Trade forensics for [trading-bots](https://github.com/lauris101/trading-bots):
a local web page that draws a window of time for one bot and one instrument,
with both venues' quotes and every order event on top of them.

- Lines: Binance bid/ask (thin), Hyperliquid bid/ask (thick), as step lines;
  the ask is dashed. Every line toggles on its own in the legend.
- Markers, one per order event, coloured by side (buy green, sell red), with
  the whole record on hover, cloid included. Every event is on the plot, on
  its own clock: an insert, amend or cancel at the moment it left this
  machine, an ack at the moment the answer was read here, a fill at the
  VENUE's own fill time and fill price - so a fill sits where it crossed the
  spread, not where we heard about it, and the gap between a fill and its
  ack is the round trip made visible. The shape is the kind of order:
  an opening IOC points right, a closing ALO rung is a square, a closing IOC
  points left; each is solid when the order filled at all and an outline when
  it did not. Fills are dots, cancels crosses, a rejection a circled cross,
  and an amend (a resting order re-priced in place) a bar at the price it
  moved to - solid when the venue accepted the move, dashed at the price it
  never reached when the venue refused it. Nothing is dropped for want of a shape. An open's marker also
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

`CONTROL_URL` (optional) is the control API (`https://app.example`). With it
set, the page seeds its gate and slope inputs from the bot's current config
for the chosen key (`/api/params`: the strategy's defaults with the
instrument's overrides), so a change made in the bot shows on the plot.
Without it the inputs keep the page's own defaults.

### Native

```bash
just run                 # debug build; or: just run-release
```

Open http://127.0.0.1:8095. Live orders are shown by default (the mode
selector also offers dummy, or both). The list beside the plot is every
EVENT of the selected key, newest first, one row each: the timestamp is the
event's own clock (amber when it is the venue's), the badge names the event
(open IOC / close ALO / close IOC for an insert, then resting / filled /
rejected, fill,
amend landed / refused, cancel sent / ok / failed), the price is the event's
own or, greyed, the order's when the event carries none. A fill's note shows
its fee, its closed pnl and how long after the venue's stamp we saw it. The
bot and instrument with the newest events are preselected, centred on the
newest event; click any row to centre on it at the zoom you are at (the
view slides, and reloads around the event if it lies outside the loaded
window; double-click is what shows the whole window again); `←` / `→` shift
the window by half its length. Hovering a row rings every point of that order on the
plot, its own event heaviest.

For an exact window, fill in `from` and `to` (UTC, `YYYY-MM-DD HH:MM:SS.mmm`);
they override the centre and the window picker, and `←` / `→` then step by
half the range. Six hours is the server's limit and a wider range is clamped
to it. Clear either field, or click an order, to go back to centre + window.

## Layout

```
src/main.rs        the server: /api/bots, /api/orders, /api/events, /api/window
static/index.html  the page
static/app.js      the plot
```

`/api/window?bot=&instrument=&from_ms=&to_ms=&mode=` returns the quotes of
every venue in the window plus the events, joined to their orders. At most
six hours per window.
