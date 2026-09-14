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
//! CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB, RUST_LOG.

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
    };
    let router = Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route(
            "/app.js",
            get(|| async { ([(header::CONTENT_TYPE, "application/javascript")], APP_JS) }),
        )
        .route("/api/bots", get(bots))
        .route("/api/orders", get(orders))
        .route("/api/window", get(window))
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

async fn bots(State(app): State<Arc<App>>) -> ApiResult {
    let rows = sqlx::query(
        "select bot, instrument, mode, count(*) as orders, max(created_at) as last_at
         from bot_orders where instrument is not null
         group by bot, instrument, mode order by max(created_at) desc",
    )
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "bot": r.get::<String, _>("bot"),
                "instrument": r.get::<String, _>("instrument"),
                "mode": r.get::<String, _>("mode"),
                "orders": r.get::<i64, _>("orders"),
                "last_at": r.get::<DateTime<Utc>, _>("last_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "keys": out })))
}

// ---- the recent orders of one key, to pick a moment ------------------------

#[derive(Deserialize)]
struct OrdersQuery {
    bot: String,
    instrument: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

async fn orders(State(app): State<Arc<App>>, Query(q): Query<OrdersQuery>) -> ApiResult {
    let rows = sqlx::query(
        "select cloid, mode, side, exec, reduce_only, reason, priority, px::text as px, sz::text as sz,
                status, error, filled_sz::text as filled_sz, avg_px::text as avg_px,
                coalesce(sent_at, created_at) as sent_at, done_at, trace::text as trace
         from bot_orders
         where bot = $1 and upper(instrument) = upper($2) and ($3::text is null or mode = $3)
         order by coalesce(sent_at, created_at) desc limit $4",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(q.mode.as_deref().filter(|m| !m.is_empty()))
    .bind(q.limit.unwrap_or(200).clamp(1, 2_000))
    .fetch_all(&app.pool)
    .await
    .map_err(internal)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "cloid": r.get::<String, _>("cloid"),
                "mode": r.get::<String, _>("mode"),
                "side": r.get::<Option<String>, _>("side"),
                "exec": r.get::<Option<String>, _>("exec"),
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

    let (quotes, events) = tokio::join!(
        quotes_for(&app, &q.instrument, from, to),
        events_for(&app, &q, from, to),
    );
    Ok(Json(json!({
        "from_ms": q.from_ms,
        "to_ms": q.to_ms,
        "quotes": quotes?,
        "events": events?,
    })))
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
    let counted: String = app
        .ch(&format!(
            "SELECT venue, count() FROM {db}.quotes WHERE upper(instrument) = upper('{inst}') \
             AND ts_venue BETWEEN '{f}' AND '{t}' GROUP BY venue FORMAT TSV",
            db = app.ch_db
        ))
        .await?;
    let mut max_count = 0i64;
    for line in counted.lines() {
        if let Some((_, n)) = line.split_once('\t') {
            max_count = max_count.max(n.trim().parse().unwrap_or(0));
        }
    }
    // Bucket only when a venue exceeds the payload budget; keep the last
    // quote of each bucket, which is what a step line would show anyway.
    let sql = if max_count > MAX_QUOTES_PER_VENUE {
        let bucket_ms = (span_ms / MAX_QUOTES_PER_VENUE).max(1);
        format!(
            "SELECT venue, toUnixTimestamp64Milli(t) AS t, bid, ask FROM ( \
                SELECT venue, toStartOfInterval(ts_venue, INTERVAL {bucket_ms} MILLISECOND) AS t, \
                       argMax(bid, ts_venue) AS bid, argMax(ask, ts_venue) AS ask \
                FROM {db}.quotes WHERE upper(instrument) = upper('{inst}') \
                  AND ts_venue BETWEEN '{f}' AND '{t}' GROUP BY venue, t) \
             ORDER BY venue, t FORMAT TSV",
            db = app.ch_db
        )
    } else {
        format!(
            "SELECT venue, toUnixTimestamp64Milli(ts_venue) AS t, bid, ask FROM {db}.quotes \
             WHERE upper(instrument) = upper('{inst}') AND ts_venue BETWEEN '{f}' AND '{t}' \
             ORDER BY venue, ts_venue FORMAT TSV",
            db = app.ch_db
        )
    };
    let body = app.ch(&sql).await?;
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
    Ok(json!({
        "bucketed_ms": if max_count > MAX_QUOTES_PER_VENUE { Some((span_ms / MAX_QUOTES_PER_VENUE).max(1)) } else { None },
        "by_venue": by_venue,
    }))
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
                coalesce(e.side, o.side) as side, coalesce(e.exec, o.exec) as exec,
                coalesce(e.reduce_only, o.reduce_only) as reduce_only,
                coalesce(e.reason, o.reason) as reason, coalesce(e.priority, o.priority) as priority,
                e.px::text as px, e.sz::text as sz, o.px::text as order_px, o.sz::text as order_sz,
                o.status as order_status, o.avg_px::text as order_avg_px, o.filled_sz::text as order_filled,
                e.oid, e.fill_id, e.fee::text as fee, e.closed_pnl::text as closed_pnl, e.source,
                o.mode, o.trace -> 'decision' as decision
         from bot_order_events e join bot_orders o on o.cloid = e.cloid
         where e.bot = $1 and upper(o.instrument) = upper($2)
           and e.at >= $3 and e.at <= $4
           and ($5::text is null or o.mode = $5)
         order by e.id",
    )
    .bind(&q.bot)
    .bind(&q.instrument)
    .bind(from)
    .bind(to)
    .bind(q.mode.as_deref().filter(|m| !m.is_empty()))
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
                "exec": r.get::<Option<String>, _>("exec"),
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
