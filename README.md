# trading-bots-plotter

Trade forensics for [trading-bots](https://github.com/lauris101/trading-bots):
a local web page that draws a window of time for one bot and one instrument,
with both venues' quotes and every order event on top of them.

- Lines: Binance bid/ask (thin), Hyperliquid bid/ask (thick), as step lines.
- Markers, one per order event, coloured by side (buy green, sell red), with
  the whole record on hover. An insert is a right-pointing triangle, solid
  when the order filled and outline only when it did not; fills are dots;
  cancels are crosses; a rejection is a circled cross. An open's marker also
  carries the decision the calculator recorded: deviation, raw deviation,
  basis, rho, delta, threshold, expected gain.
- Lower pane: the leader's mid over the lagger's mid in basis points, with
  the open threshold of the last decision as dashed lines.
- Drag a box to zoom into it; two-finger trackpad scroll pans; pinch or
  ctrl + wheel zooms around the cursor; double-click resets. Legend entries
  toggle a series.

Reads Postgres (`bot_orders`, `bot_order_events`) and ClickHouse (`quotes`);
writes nothing. Rust (axum) serves the data as JSON, the page renders with
Plotly's WebGL traces, so a window of tens of thousands of quotes pans
without stutter. Windows above 12 000 quotes per venue are bucketed
server-side to the last quote per bucket.

## Run

```bash
cp .env.example .env     # fill in the two passwords (trading-bots-db/.env)
just run                 # or: cargo run --release
```

Open http://127.0.0.1:8095. Live orders are shown by default (the mode
selector also offers dummy, or both). The bot and instrument with the newest
live orders are preselected, centred on the newest order; click any order in the list
to centre on it; `←` / `→` shift the window by half its length.

Reaching the stores:

- From a laptop: `just tunnels` in `trading-bots-host-setup/cloudflare`
  forwards Postgres to `127.0.0.1:15432` and ClickHouse HTTP to
  `127.0.0.1:18123`, which is what `.env.example` points at.
- From a machine whose address is on the Access bypass list:
  `CLICKHOUSE_URL=https://chdb.<domain>` directly, and Postgres through
  `cloudflared access tcp --hostname db.<domain> --url 127.0.0.1:15432`.

## Layout

```
src/main.rs        the server: /api/bots, /api/orders, /api/window
static/index.html  the page
static/app.js      the plot
```

`/api/window?bot=&instrument=&from_ms=&to_ms=&mode=` returns the quotes of
every venue in the window plus the events, joined to their orders. At most
six hours per window.
