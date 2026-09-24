//! trading-bots-plotter: trade forensics over both venues' quotes.
//!
//! One small axum server. It reads the bots' order history from Postgres
//! (`bot_orders`, `bot_order_events`, `bot_fills`) and the scraped quotes
//! from ClickHouse (`quotes`), and serves a page that draws a window of
//! time: Binance and Hyperliquid bid/ask as step lines, every order event
//! as a marker with its details on hover, and the deviation between the
//! venues underneath. Nothing is written anywhere.
//!
//! Environment (`.env` is read): PLOTTER_ADDR, DATABASE_URL, CLICKHOUSE_URL,
//! CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB, CONTROL_URL (the
//! control API, for the bot's current parameters; optional), RUST_LOG.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use sqlx::postgres::PgPoolOptions;

const INDEX_HTML: &str = include_str!("../static/index.html");
const APP_JS: &str = include_str!("../static/app.js");
const LIVE_HTML: &str = include_str!("../static/live.html");
const LIVE_JS: &str = include_str!("../static/live.js");

/// Quotes returned per venue per window, at most; beyond this the window is
/// bucketed and the last quote of each bucket kept (a step line looks the
/// same, the browser gets a bounded payload).
const MAX_QUOTES_PER_VENUE: i64 = 12_000;

#[derive(Clone)]
struct App {
    pool: sqlx::PgPool,
    http: reqwest::Client,
    ch_url: String,
    ch_user: String,
    ch_password: String,
    ch_db: String,
    /// The control API (`https://app.example`), for `/api/params`; `None`
    /// leaves the page on its own defaults.
    control_url: Option<String>,
}

type ApiResult = Result<Json<Value>, ApiError>;

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, err.to_string())
}

fn bad(err: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, err.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let addr = std::env::var("PLOTTER_ADDR").unwrap_or_else(|_| "127.0.0.1:8095".to_owned());
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .connect_lazy(&database_url)
        .context("DATABASE_URL is not a valid postgres url")?;
    let app = App {
        pool,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?,
        ch_url: std::env::var("CLICKHOUSE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:18123".to_owned())
            .trim_end_matches('/')
            .to_owned(),
        ch_user: std::env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "trading-bots".to_owned()),
        ch_password: std::env::var("CLICKHOUSE_PASSWORD").unwrap_or_default(),
        ch_db: std::env::var("CLICKHOUSE_DB").unwrap_or_else(|_| "trading_bots".to_owned()),
        control_url: std::env::var("CONTROL_URL")
            .ok()
            .map(|u| u.trim_end_matches('/').to_owned())
            .filter(|u| !u.is_empty()),
    };
    let router = Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route(
            "/app.js",
            get(|| async { ([(header::CONTENT_TYPE, "application/javascript")], APP_JS) }),
        )
        .route("/live", get(|| async { Html(LIVE_HTML) }))
        .route(
            "/live.js",
            get(|| async { ([(header::CONTENT_TYPE, "application/javascript")], LIVE_JS) }),
        )
        .route("/api/live/setup", get(live_setup))
        .route("/api/bots", get(bots))
        .route("/api/orders", get(orders))
        .route("/api/events", get(events))
        .route("/api/window", get(window))
        .route("/api/watched", get(watched))
        .route("/api/competitor", get(competitor))
        .route("/api/params", get(params))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(90),
        ))
        .with_state(Arc::new(app));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("could not bind {addr}"))?;
    tracing::info!(%addr, "plotter listening; open http://{addr}/");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

// ---- bots and instruments that have orders --------------------------------
//
// Everything the page lists is bounded to the last 24 hours: the quotes
// table keeps one day (its TTL), so an older event has nothing to be drawn
// against, and a key with no order in the day has nothing to show.

async fn bots(State(app): State<Arc<App>>) -> ApiResult {
    let rows = sqlx::query(
        "select bot, coalesce(strategy, '') as strategy, instrument, mode, count(*) as orders,
                max(created_at) as last_at
         from bot_orders where instrument is not null and created_at > now() - interval '24 hours'
         group by bot, strategy, instrument, mode order by max(created_at) desc",
    )
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "bot": r.get::<String, _>("bot"),
                // The strategy entry the order came from; "" for an order
                // recorded without one (a bare resting row).
                "strategy": r.get::<String, _>("strategy"),
                "instrument": r.get::<String, _>("instrument"),
                "mode": r.get::<String, _>("mode"),
                "orders": r.get::<i64, _>("orders"),
                "last_at": r.get::<DateTime<Utc>, _>("last_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "keys": out })))
}

// ---- the live page's choices --------------------------------------------------
//
// The addresses to listen to (every account of every bot control knows: the
// master and each subaccount) and the instruments with both venues' symbols,
// from control's stored configs. The page opens its own sockets to the
// venues; this only tells it what to ask for.

async fn live_setup(State(app): State<Arc<App>>) -> ApiResult {
    let Some(control) = app.control_url.as_deref() else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "CONTROL_URL is not set: the live page needs control for the addresses and symbols"
                .to_owned(),
        ));
    };
    let bots: Value = app
        .http
        .get(format!("{control}/bots"))
        .send()
        .await
        .map_err(|e| internal(format!("control unreachable at {control}: {e}")))?
        .json()
        .await
        .map_err(internal)?;
    let list = bots
        .as_array()
        .cloned()
        .or_else(|| bots["bots"].as_array().cloned())
        .unwrap_or_default();
    let mut accounts = Vec::new();
    let mut instruments: std::collections::BTreeMap<String, Value> =
        std::collections::BTreeMap::new();
    for bot in &list {
        let Some(name) = bot["name"].as_str() else {
            continue;
        };
        for account in bot["status"]["accounts"].as_array().into_iter().flatten() {
            if let Some(address) = account["address"].as_str() {
                accounts.push(json!({
                    "bot": name,
                    "label": account["label"],
                    "address": address,
                    "strategies": account["strategies"],
                }));
            }
        }
        let Ok(resp) = app
            .http
            .get(format!("{control}/bots/{name}/config"))
            .send()
            .await
        else {
            continue;
        };
        let Ok(doc) = resp.json::<Value>().await else {
            continue;
        };
        let symbols = &doc["symbols"];
        for strategy in doc["config"]["strategies"].as_array().into_iter().flatten() {
            for canonical in strategy["instruments"]
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
            {
                // The store's names or nothing: an unmapped instrument is
                // left off the page rather than guessed at.
                let (Some(binance), Some(hl)) = (
                    symbols["binance_perps"][&canonical].as_str().map(str::to_owned),
                    symbols["hyperliquid"][&canonical].as_str().map(str::to_owned),
                ) else {
                    continue;
                };
                instruments.entry(canonical.clone()).or_insert(json!({
                    "canonical": canonical,
                    "binance": binance,
                    "hl": hl,
                    "bot": name,
                    "strategy": strategy["name"],
                }));
            }
        }
    }
    Ok(Json(json!({
        "accounts": accounts,
        "instruments": instruments.values().collect::<Vec<_>>(),
    })))
}

// ---- other addresses' orders and fills (the wallet collector's tables) ----
//
// Control's collector records `orderUpdates` and `userFills` of any
// Hyperliquid address into `hl_order_events` / `hl_fills`. The page overlays
// one such address on the plot as a competitor: where its orders rested and
// where it filled, against the same quotes.

/// The addresses the collector knows, for the page's picker.
async fn watched(State(app): State<Arc<App>>) -> ApiResult {
    let rows = sqlx::query(
        "select w.address, w.label, w.enabled, w.is_own,
                (select max(fill_ts) from hl_fills f where f.address = w.address) as last_fill_at
         from hl_watched_addresses w order by w.created_at",
    )
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "address": r.get::<String, _>("address"),
                "label": r.get::<Option<String>, _>("label"),
                "enabled": r.get::<bool, _>("enabled"),
                "is_own": r.get::<bool, _>("is_own"),
                "last_fill_at": r.get::<Option<DateTime<Utc>>, _>("last_fill_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "addresses": out })))
}

#[derive(Deserialize)]
struct CompetitorQuery {
    address: String,
    instrument: String,
    from_ms: i64,
    to_ms: i64,
}

/// One address's order status events and fills on one instrument in a
/// window. The instrument is matched by its Hyperliquid coin names from the
/// instrument model (every Hyperliquid symbology), and by the canonical
/// itself when no mapping exists.
async fn competitor(State(app): State<Arc<App>>, Query(q): Query<CompetitorQuery>) -> ApiResult {
    let address = q.address.trim().to_lowercase();
    let Some(from) = Utc.timestamp_millis_opt(q.from_ms).single() else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad from_ms".to_owned()));
    };
    let Some(to) = Utc.timestamp_millis_opt(q.to_ms).single() else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad to_ms".to_owned()));
    };
    if to <= from || (to - from) > chrono::Duration::hours(6) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "a window is at most 6 hours and must end after it starts".to_owned(),
        ));
    }
    // Every Hyperliquid symbology (the main dex and the builder dexes):
    // the symbol stored under each is the name the venue trades.
    let mut coins: Vec<String> = sqlx::query_scalar(
        "select distinct s.symbol
         from instrument_symbols s
         join instruments i on i.id = s.instrument_id
         join symbologies g on g.id = s.symbology_id
         where upper(i.symbol) = upper($1)
           and (g.code = 'Hyperliquid' or g.code like 'Hyperliquid\\_%')
           and (s.valid_to is null or s.valid_to > now())",
    )
    .bind(&q.instrument)
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    if !coins.iter().any(|c| c == &q.instrument) {
        coins.push(q.instrument.clone());
    }
    let orders = sqlx::query(
        "select oid, cloid, side, limit_px::text as limit_px, sz::text as sz, orig_sz::text as orig_sz,
                reduce_only, status, order_ts, status_ts
         from hl_order_events
         where address = $1 and coin = any($2) and status_ts >= $3 and status_ts <= $4
         order by status_ts, id",
    )
    .bind(&address)
    .bind(&coins)
    .bind(from)
    .bind(to)
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let fills = sqlx::query(
        "select tid, oid, side, px::text as px, sz::text as sz, fill_ts, dir, closed_pnl::text as closed_pnl,
                crossed, fee::text as fee
         from hl_fills
         where address = $1 and coin = any($2) and fill_ts >= $3 and fill_ts <= $4
         order by fill_ts, id",
    )
    .bind(&address)
    .bind(&coins)
    .bind(from)
    .bind(to)
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let side = |s: &str| match s {
        "B" => "buy",
        "A" => "sell",
        _ => "none",
    };
    let orders: Vec<Value> = orders
        .iter()
        .map(|r| {
            json!({
                "oid": r.get::<i64, _>("oid"),
                "cloid": r.get::<Option<String>, _>("cloid"),
                "side": side(&r.get::<String, _>("side")),
                "limit_px": r.get::<Option<String>, _>("limit_px"),
                "sz": r.get::<String, _>("sz"),
                "orig_sz": r.get::<String, _>("orig_sz"),
                "reduce_only": r.get::<Option<bool>, _>("reduce_only"),
                "status": r.get::<String, _>("status"),
                "order_t": r.get::<DateTime<Utc>, _>("order_ts").timestamp_millis(),
                "t": r.get::<DateTime<Utc>, _>("status_ts").timestamp_millis(),
            })
        })
        .collect();
    let fills: Vec<Value> = fills
        .iter()
        .map(|r| {
            json!({
                "tid": r.get::<i64, _>("tid"),
                "oid": r.get::<i64, _>("oid"),
                "side": side(&r.get::<String, _>("side")),
                "px": r.get::<String, _>("px"),
                "sz": r.get::<String, _>("sz"),
                "t": r.get::<DateTime<Utc>, _>("fill_ts").timestamp_millis(),
                "dir": r.get::<Option<String>, _>("dir"),
                "closed_pnl": r.get::<Option<String>, _>("closed_pnl"),
                "crossed": r.get::<Option<bool>, _>("crossed"),
                "fee": r.get::<Option<String>, _>("fee"),
            })
        })
        .collect();
    Ok(Json(json!({ "address": address, "coins": coins, "orders": orders, "fills": fills })))
}

// ---- the bot's current parameters for one key -----------------------------

#[derive(Deserialize)]
struct ParamsQuery {
    bot: String,
    instrument: String,
    /// The strategy entry to read; without it, the first one that trades
    /// the instrument (two can, in different accounts).
    #[serde(default)]
    strategy: Option<String>,
}

/// The parameters the bot runs `instrument` with right now, from control's
/// stored config: the strategy's `defaults` with the instrument's own
/// overrides merged on top, per block (`taker`, `ema`, `send`). The page
/// seeds its inputs from these, so a change in the bot's config shows on
/// the plot without anyone retyping it. 404 without CONTROL_URL or when the
/// bot does not trade the instrument.
async fn params(State(app): State<Arc<App>>, Query(q): Query<ParamsQuery>) -> ApiResult {
    let Some(control) = app.control_url.as_deref() else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "CONTROL_URL is not set: the page keeps its own defaults".to_owned(),
        ));
    };
    let resp = app
        .http
        .get(format!("{control}/bots/{}/config", q.bot))
        .send()
        .await
        .map_err(|e| internal(format!("control unreachable at {control}: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!(
                "control has no config for bot '{}' ({})",
                q.bot,
                resp.status()
            ),
        ));
    }
    let doc: Value = resp.json().await.map_err(internal)?;
    let version = doc["version"].clone();
    let strategies = doc["config"]["strategies"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let wanted = q.instrument.to_uppercase();
    let wanted_strategy = q
        .strategy
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_uppercase);
    let Some((strategy, override_)) = strategies
        .iter()
        .filter(|s| {
            wanted_strategy
                .as_deref()
                .is_none_or(|w| s["name"].as_str().is_some_and(|n| n.to_uppercase() == w))
        })
        .find_map(|s| {
            s["instruments"]
                .as_object()?
                .iter()
                .find(|(k, _)| k.to_uppercase() == wanted)
                .map(|(_, v)| (s, v.clone()))
        })
    else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            match &q.strategy {
                Some(name) if !name.trim().is_empty() => format!(
                    "bot '{}' has no strategy '{}' trading '{}'",
                    q.bot, name, q.instrument
                ),
                _ => format!("bot '{}' has no strategy trading '{}'", q.bot, q.instrument),
            },
        ));
    };
    let mut out = serde_json::Map::new();
    for block in ["taker", "taker_trail", "momentum", "ema", "send"] {
        let mut merged = strategy["defaults"][block].clone();
        deep_merge(&mut merged, &override_[block]);
        if !merged.is_null() {
            out.insert(block.to_owned(), merged);
        }
    }
    Ok(Json(json!({
        "bot": q.bot,
        "instrument": q.instrument,
        "strategy": strategy["name"],
        "version": version,
        "params": out,
    })))
}

/// Objects merge key by key (the overlay's keys win), anything else is
/// replaced by the overlay; a null overlay leaves the base alone.
fn deep_merge(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (_, Value::Null) => {}
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                deep_merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (b, o) => *b = o.clone(),
    }
}

// ---- the recent orders of one key, to pick a moment ------------------------

#[derive(Deserialize)]
struct OrdersQuery {
    bot: String,
    instrument: String,
    /// The strategy entry; empty or absent = every strategy of the bot.
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

async fn orders(State(app): State<Arc<App>>, Query(q): Query<OrdersQuery>) -> ApiResult {
    let rows = sqlx::query(
        "select cloid, parent_cloid, mode, side, tif, reduce_only, reason, priority, px::text as px, sz::text as sz,
                status, error, filled_sz::text as filled_sz, avg_px::text as avg_px,
                coalesce(sent_at, created_at) as sent_at, done_at, trace::text as trace
         from bot_orders
         where bot = $1 and upper(instrument) = upper($2) and ($3::text is null or mode = $3)
           and ($5::text is null or coalesce(strategy, '') = $5)
           and coalesce(sent_at, created_at) > now() - interval '24 hours'
         order by coalesce(sent_at, created_at) desc limit $4",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(q.mode.as_deref().filter(|m| !m.is_empty()))
    .bind(q.limit.unwrap_or(200).clamp(1, 2_000))
    .bind(q.strategy.as_deref())
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "cloid": r.get::<String, _>("cloid"),
                "parent_cloid": r.get::<Option<String>, _>("parent_cloid"),
                "mode": r.get::<String, _>("mode"),
                "side": r.get::<Option<String>, _>("side"),
                "tif": r.get::<Option<String>, _>("tif"),
        "parent_cloid": r.try_get::<Option<String>, _>("parent_cloid").ok().flatten(),
                "reduce_only": r.get::<Option<bool>, _>("reduce_only"),
                "reason": r.get::<Option<String>, _>("reason"),
                "priority": r.get::<Option<i32>, _>("priority"),
                "px": r.get::<Option<String>, _>("px"),
                "sz": r.get::<Option<String>, _>("sz"),
                "status": r.get::<String, _>("status"),
                "error": r.get::<Option<String>, _>("error"),
                "filled_sz": r.get::<String, _>("filled_sz"),
                "avg_px": r.get::<Option<String>, _>("avg_px"),
                "sent_at": r.get::<DateTime<Utc>, _>("sent_at"),
                "done_at": r.get::<Option<DateTime<Utc>>, _>("done_at"),
                "trace": r.get::<Option<String>, _>("trace").and_then(|t| serde_json::from_str::<Value>(&t).ok()),
            })
        })
        .collect();
    Ok(Json(json!({ "orders": out })))
}

// ---- every event of one key, newest first --------------------------------
//
// The list the page navigates by. One row per event rather than per order,
// each on its own clock: `at` is the bot's wire time for what the bot did
// (sent, amend, cancel_sent), the reply-read time for what the venue
// answered (acked, cancelled), and the VENUE's own fill time for a fill -
// so a fill sits where it crossed the spread, not where we heard about it.
// `received_at` is when control recorded it, which for a fill is the delay
// between the two clocks.

async fn events(State(app): State<Arc<App>>, Query(q): Query<OrdersQuery>) -> ApiResult {
    let rows = sqlx::query(
        "select e.id, e.at, e.received_at, e.cloid, e.kind, e.status, e.batch, e.error,
                coalesce(e.side, o.side) as side, coalesce(e.tif, o.tif) as tif, o.parent_cloid,
                coalesce(e.reduce_only, o.reduce_only) as reduce_only,
                coalesce(e.reason, o.reason) as reason, coalesce(e.priority, o.priority) as priority,
                e.px::text as px, e.sz::text as sz, o.px::text as order_px, o.sz::text as order_sz,
                o.status as order_status, o.avg_px::text as order_avg_px, o.filled_sz::text as order_filled,
                e.oid, e.fill_id, e.fee::text as fee, e.closed_pnl::text as closed_pnl, e.source, o.mode
         from bot_order_events e join bot_orders o on o.cloid = e.cloid
         where e.bot = $1 and upper(o.instrument) = upper($2)
           and e.at > now() - interval '24 hours'
           and ($3::text is null or o.mode = $3)
           and ($5::text is null or coalesce(o.strategy, '') = $5)
         order by e.at desc, e.id desc limit $4",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(q.mode.as_deref().filter(|m| !m.is_empty()))
    .bind(q.limit.unwrap_or(600).clamp(1, 5_000))
    .bind(q.strategy.as_deref())
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows.iter().map(event_json).collect();
    Ok(Json(json!({ "events": out })))
}

/// One event row as the page reads it, shared by the list and the window.
fn event_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.get::<i64, _>("id"),
        "t": r.get::<DateTime<Utc>, _>("at").timestamp_millis(),
        "at": r.get::<DateTime<Utc>, _>("at"),
        "received_at": r.try_get::<DateTime<Utc>, _>("received_at").ok(),
        "cloid": r.get::<String, _>("cloid"),
        "kind": r.get::<String, _>("kind"),
        "status": r.get::<Option<String>, _>("status"),
        "batch": r.get::<Option<i64>, _>("batch"),
        "error": r.get::<Option<String>, _>("error"),
        "side": r.get::<Option<String>, _>("side"),
        "tif": r.get::<Option<String>, _>("tif"),
        "reduce_only": r.get::<Option<bool>, _>("reduce_only"),
        "reason": r.get::<Option<String>, _>("reason"),
        "priority": r.get::<Option<i32>, _>("priority"),
        "px": r.get::<Option<String>, _>("px"),
        "sz": r.get::<Option<String>, _>("sz"),
        "order_px": r.get::<Option<String>, _>("order_px"),
        "order_sz": r.get::<Option<String>, _>("order_sz"),
        "order_status": r.get::<String, _>("order_status"),
        "order_avg_px": r.get::<Option<String>, _>("order_avg_px"),
        "order_filled": r.get::<String, _>("order_filled"),
        "oid": r.get::<Option<i64>, _>("oid"),
        "fill_id": r.get::<Option<String>, _>("fill_id"),
        "fee": r.get::<Option<String>, _>("fee"),
        "closed_pnl": r.get::<Option<String>, _>("closed_pnl"),
        "source": r.get::<Option<String>, _>("source"),
        "mode": r.try_get::<Option<String>, _>("mode").ok().flatten(),
        "decision": r.try_get::<Option<Value>, _>("decision").ok().flatten(),
    })
}

// ---- one window: quotes of both venues plus every order event ---------------

#[derive(Deserialize)]
struct WindowQuery {
    bot: String,
    instrument: String,
    /// Window start and end, epoch milliseconds (UTC).
    from_ms: i64,
    to_ms: i64,
    #[serde(default)]
    mode: Option<String>,
    /// The strategy entry; empty or absent = every strategy of the bot.
    #[serde(default)]
    strategy: Option<String>,
}

#[derive(Serialize)]
struct QuoteRow {
    t: i64,
    bid: f64,
    ask: f64,
}

async fn window(State(app): State<Arc<App>>, Query(q): Query<WindowQuery>) -> ApiResult {
    if q.to_ms <= q.from_ms {
        return Err(bad("to_ms must be after from_ms"));
    }
    if q.to_ms - q.from_ms > 6 * 3_600_000 {
        return Err(bad("a window is at most 6 hours"));
    }
    let from = Utc
        .timestamp_millis_opt(q.from_ms)
        .single()
        .ok_or_else(|| bad("from_ms"))?;
    let to = Utc
        .timestamp_millis_opt(q.to_ms)
        .single()
        .ok_or_else(|| bad("to_ms"))?;

    let (quotes, events, conditions) = tokio::join!(
        quotes_for(&app, &q.instrument, from, to),
        events_for(&app, &q, from, to),
        conditions_for(&app, &q, from, to),
    );
    Ok(Json(json!({
        "from_ms": q.from_ms,
        "to_ms": q.to_ms,
        "quotes": quotes?,
        "events": events?,
        "conditions": conditions?,
    })))
}

/// What the key was prevented from doing, from `bot_events`: the leader in
/// shock, the lagger not following the last open, a fault that stopped the
/// key and its recovery. Separate from the order events because these are
/// about the times there is NO order to look at -- the gap in the order
/// series is the thing being explained.
async fn conditions_for(
    app: &App,
    q: &WindowQuery,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "select id, at, kind, coalesce(strategy, '') as strategy, details
         from bot_events
         where bot = $1 and instrument is not null and upper(instrument) = upper($2)
           and at >= $3 and at <= $4
           and ($5::text is null or coalesce(strategy, '') = $5)
         order by id",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(from)
    .bind(to)
    .bind(q.strategy.as_deref())
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "t": r.get::<DateTime<Utc>, _>("at").timestamp_millis(),
                "kind": r.get::<String, _>("kind"),
                "strategy": r.get::<String, _>("strategy"),
                "details": r.get::<Value, _>("details"),
            })
        })
        .collect();
    Ok(json!(out))
}

/// The scraped quotes of an instrument on every venue in the window. The
/// instrument label the scraper writes is control's normalized canonical,
/// so the match is case-insensitive.
async fn quotes_for(
    app: &App,
    instrument: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, ApiError> {
    let inst = instrument.replace('\'', "");
    let span_ms = (to - from).num_milliseconds().max(1);
    let f = from.format("%Y-%m-%d %H:%M:%S%.3f");
    let t = to.format("%Y-%m-%d %H:%M:%S%.3f");
    // ClickHouse is a remote round trip (0.3-0.8 s of latency from here
    // before any work), so the window is ONE round trip, not two: the raw
    // quotes and the bucketed ones are asked for together. The raw query
    // stops one row past the budget per venue; if any venue reached it the
    // bucketed answer is the one served. The bucket width depends only on
    // the span, so the bucketed query needs no count to be right. The
    // budget is a per-venue row cap, and the bucket keeps the last quote
    // of its interval, which is what a step line would show anyway.
    let bucket_ms = (span_ms / MAX_QUOTES_PER_VENUE).max(1);
    let raw_sql = format!(
        "SELECT venue, toUnixTimestamp64Milli(ts_venue) AS t, bid, ask FROM {db}.quotes \
         WHERE upper(instrument) = upper('{inst}') AND ts_venue BETWEEN '{f}' AND '{t}' \
         ORDER BY venue, ts_venue LIMIT {cap} BY venue FORMAT TSV",
        db = app.ch_db,
        cap = MAX_QUOTES_PER_VENUE + 1
    );
    let bucketed_sql = format!(
        "SELECT venue, toUnixTimestamp64Milli(t) AS t, bid, ask FROM ( \
            SELECT venue, toStartOfInterval(ts_venue, INTERVAL {bucket_ms} MILLISECOND) AS t, \
                   argMax(bid, ts_venue) AS bid, argMax(ask, ts_venue) AS ask \
            FROM {db}.quotes WHERE upper(instrument) = upper('{inst}') \
              AND ts_venue BETWEEN '{f}' AND '{t}' GROUP BY venue, t) \
         ORDER BY venue, t FORMAT TSV",
        db = app.ch_db
    );
    let (raw, bucketed) = tokio::join!(app.ch(&raw_sql), app.ch(&bucketed_sql));
    let raw = parse_quotes(&raw?);
    let over_budget = raw
        .values()
        .any(|rows| rows.len() as i64 > MAX_QUOTES_PER_VENUE);
    let by_venue = if over_budget {
        parse_quotes(&bucketed?)
    } else {
        raw
    };
    Ok(json!({
        "bucketed_ms": if over_budget { Some(bucket_ms) } else { None },
        "by_venue": by_venue,
    }))
}

/// `venue \t t_ms \t bid \t ask` lines, grouped by venue in the order served.
fn parse_quotes(body: &str) -> std::collections::BTreeMap<String, Vec<QuoteRow>> {
    let mut by_venue: std::collections::BTreeMap<String, Vec<QuoteRow>> = Default::default();
    for line in body.lines() {
        let mut it = line.split('\t');
        let (Some(venue), Some(t), Some(bid), Some(ask)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(t), Ok(bid), Ok(ask)) = (t.parse::<i64>(), bid.parse::<f64>(), ask.parse::<f64>())
        else {
            continue;
        };
        by_venue
            .entry(venue.to_owned())
            .or_default()
            .push(QuoteRow { t, bid, ask });
    }
    by_venue
}

/// Every order event of the key in the window, with the order's own fields
/// (side, size, reason) and, on the `sent` row of an open, the decision the
/// calculator recorded.
async fn events_for(
    app: &App,
    q: &WindowQuery,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "select e.id, e.at, e.cloid, e.kind, e.status, e.batch, e.error,
                coalesce(e.side, o.side) as side, coalesce(e.tif, o.tif) as tif, o.parent_cloid,
                coalesce(e.reduce_only, o.reduce_only) as reduce_only,
                coalesce(e.reason, o.reason) as reason, coalesce(e.priority, o.priority) as priority,
                e.px::text as px, e.sz::text as sz, o.px::text as order_px, o.sz::text as order_sz,
                o.status as order_status, o.avg_px::text as order_avg_px, o.filled_sz::text as order_filled,
                e.oid, e.fill_id, e.fee::text as fee, e.closed_pnl::text as closed_pnl, e.source,
                o.mode, o.trace -> 'decision' as decision, o.trace -> 'slope' as slope,
                o.trace -> 'protection' as protection
         from bot_order_events e join bot_orders o on o.cloid = e.cloid
         where e.bot = $1 and upper(o.instrument) = upper($2)
           and e.at >= $3 and e.at <= $4
           and ($5::text is null or o.mode = $5)
           and ($6::text is null or coalesce(o.strategy, '') = $6)
         order by e.id",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(from)
    .bind(to)
    .bind(q.mode.as_deref().filter(|m| !m.is_empty()))
    .bind(q.strategy.as_deref())
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "t": r.get::<DateTime<Utc>, _>("at").timestamp_millis(),
                "cloid": r.get::<String, _>("cloid"),
                "kind": r.get::<String, _>("kind"),
                "status": r.get::<Option<String>, _>("status"),
                "batch": r.get::<Option<i64>, _>("batch"),
                "error": r.get::<Option<String>, _>("error"),
                "side": r.get::<Option<String>, _>("side"),
                "tif": r.get::<Option<String>, _>("tif"),
                "reduce_only": r.get::<Option<bool>, _>("reduce_only"),
                "reason": r.get::<Option<String>, _>("reason"),
                "priority": r.get::<Option<i32>, _>("priority"),
                "px": r.get::<Option<String>, _>("px"),
                "sz": r.get::<Option<String>, _>("sz"),
                "order_px": r.get::<Option<String>, _>("order_px"),
                "order_sz": r.get::<Option<String>, _>("order_sz"),
                "order_status": r.get::<String, _>("order_status"),
                "order_avg_px": r.get::<Option<String>, _>("order_avg_px"),
                "order_filled": r.get::<String, _>("order_filled"),
                "oid": r.get::<Option<i64>, _>("oid"),
                "fill_id": r.get::<Option<String>, _>("fill_id"),
                "fee": r.get::<Option<String>, _>("fee"),
                "closed_pnl": r.get::<Option<String>, _>("closed_pnl"),
                "source": r.get::<Option<String>, _>("source"),
                "mode": r.get::<String, _>("mode"),
                "decision": r.get::<Option<Value>, _>("decision"),
                "slope": r.get::<Option<Value>, _>("slope"),
                "protection": r.get::<Option<Value>, _>("protection"),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

impl App {
    /// One ClickHouse query over HTTP, the body as text.
    async fn ch(&self, sql: &str) -> Result<String, ApiError> {
        let resp = self
            .http
            .post(format!("{}/", self.ch_url))
            .basic_auth(&self.ch_user, Some(&self.ch_password))
            .body(sql.to_owned())
            .send()
            .await
            .map_err(|e| internal(format!("clickhouse unreachable at {}: {e}", self.ch_url)))?;
        let status = resp.status();
        let text = resp.text().await.map_err(internal)?;
        if !status.is_success() {
            return Err(internal(format!("clickhouse {status}: {}", text.trim())));
        }
        Ok(text)
    }
}
