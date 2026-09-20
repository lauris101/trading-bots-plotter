// The page: pick a key, pick a moment, draw the window.
//
// One 2D canvas, drawn by hand. Nothing runs while nothing happens: a
// redraw is scheduled only by an interaction (zoom, pan, hover, toggle) or
// by new data, and takes a few milliseconds for a window of tens of
// thousands of quotes. No WebGL contexts, no library.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    keys: [], orders: [], centreMs: null, selected: null,
    win: null,          // the built window: lines, marks, deviation, full range
    view: null,         // {x0, x1, y0, y1} in ms and price
    hidden: new Set(),  // series ids toggled off in the legend
    drag: null, hoverPt: null, pinned: null, hoverCloid: null, hoverEvent: null, selectedEvent: null, keepZoom: null, raf: 0,
    firstFill: true,
    loadSeq: 0,         // the newest window request; older answers are dropped
    abort: null,        // the in-flight window request, cancelled by the next
  };

  const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const fmtMs = (ms) => fmt(ms).slice(11, 23);
  const parseCentre = (s) => {
    const t = Date.parse(s.trim().replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
    return Number.isNaN(t) ? null : t;
  };
  // The window the server will serve at most ("a window is at most 6
  // hours", src/main.rs): clamped here so a wide range reports rather than
  // coming back as a 400.
  const MAX_WINDOW_MS = 6 * 3600 * 1000;
  /** An explicit from/to, when both parse and read forwards. Null means the
   *  centre and the window picker decide, as they always have. */
  const customRange = () => {
    const a = parseCentre($("from").value), b = parseCentre($("to").value);
    if (a == null || b == null || b <= a) return null;
    return { from: a, to: Math.min(b, a + MAX_WINDOW_MS), clamped: b - a > MAX_WINDOW_MS };
  };
  /** Back to centre + window. */
  const clearRange = () => { $("from").value = ""; $("to").value = ""; };
  const status = (msg, err = false) => { const el = $("status"); el.textContent = msg; el.className = err ? "err" : ""; };
  // A cloid is 34 characters and only its ends identify it; the full one is
  // on hover and one click away, which is what an investigation needs.
  const shortCloid = (c) => (String(c ?? "").length > 14 ? `${c.slice(0, 8)}..${c.slice(-6)}` : String(c ?? ""));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function api(path, signal) {
    const r = await fetch(path, { signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
    return body;
  }

  // ---- the window cache ----
  //
  // A window is two database round trips away (Postgres and ClickHouse,
  // both remote: 1.5-2 s measured from this box), so one already fetched
  // is kept. Keyed on exactly what was asked for; stepping back to a
  // window seen a moment ago costs nothing. A dozen is a session's worth.
  const WINDOW_CACHE = 12;
  const windowCache = new Map();
  const cachedWindow = (key) => {
    const w = windowCache.get(key);
    if (w) { windowCache.delete(key); windowCache.set(key, w); } // most recent last
    return w;
  };
  const rememberWindow = (key, w) => {
    windowCache.set(key, w);
    while (windowCache.size > WINDOW_CACHE) windowCache.delete(windowCache.keys().next().value);
  };
  /** The plot says it is waiting: dimmed, with the word on it, and the
   *  pointer says so too. Cleared when the window that was asked for last
   *  has arrived (or failed), never by an older one. */
  const setLoading = (on) => { $("plotwrap").classList.toggle("loading", on); };

  // ---- keys ----
  async function loadKeys() {
    const { keys } = await api("/api/bots");
    state.keys = keys;
    const bots = [...new Set(keys.map((k) => k.bot))];
    $("bot").innerHTML = bots.map((b) => `<option>${esc(b)}</option>`).join("");
    fillInstruments();
  }
  function fillInstruments() {
    const bot = $("bot").value;
    const mode = $("mode").value;
    const seen = new Map();
    for (const k of state.keys) {
      if (k.bot !== bot || (mode && k.mode !== mode)) continue;
      const cur = seen.get(k.instrument);
      if (!cur || k.last_at > cur.last_at) seen.set(k.instrument, k);
    }
    const all = [...seen.values()];
    // Alphabetical and filtered by the search box; the page still OPENS on
    // the key with the newest orders.
    const newest = all.reduce((a, b) => (a && a.last_at > b.last_at ? a : b), null);
    const q = $("search").value.trim().toUpperCase();
    const list = all
      .filter((k) => !q || k.instrument.toUpperCase().includes(q))
      .sort((a, b) => a.instrument.localeCompare(b.instrument));
    const prev = $("instrument").value;
    $("instrument").innerHTML = list.map((k) => `<option value="${esc(k.instrument)}">${esc(k.instrument)} (${k.orders})</option>`).join("");
    if (list.some((k) => k.instrument === prev)) $("instrument").value = prev;
    else if (state.firstFill && newest && list.some((k) => k.instrument === newest.instrument)) $("instrument").value = newest.instrument;
    state.firstFill = false;
    $("instcount").textContent = q ? `${list.length} of ${all.length}` : `${all.length} instruments`;
  }

  // ---- every event of the key ----
  //
  // One row per EVENT, each on its own clock, so a move can be replayed
  // step by step: the insert when it left us, the ack when the answer was
  // read, the fill when the venue matched it. Newest first.
  const eventLabel = (e) => {
    // Named for what the order IS, as the legend already does: "rung" and
    // "cross" are the code's ladder vocabulary and mean nothing to a reader.
    if (e.kind === "sent") return !e.reduce_only ? "open IOC" : e.tif === "ioc" ? "close IOC" : `close ${String(e.tif ?? "").toUpperCase()}`;
    if (e.kind === "acked") return e.status ?? "acked";
    if (e.kind === "cancelled") return `cancel ${e.status ?? "ok"}`;
    if (e.kind === "cancel_sent") return "cancel sent";
    if (e.kind === "amend") return e.amend_ok === false ? "amend refused" : e.amend_ok ? "amend landed" : "amend";
    return e.kind;
  };
  const badgeClass = (e) => (e.kind === "acked" || e.kind === "cancelled" ? esc(e.status ?? e.kind) : esc(e.kind));
  // Which clock an event's `at` is on. A fill is stamped by the venue at the
  // match; everything else is stamped by us, when we sent it or read it.
  const venueClock = (e) => e.kind === "fill";
  const noteOf = (e) => {
    const bits = [];
    if (e.reason) bits.push(e.reason);
    if (e.batch != null) bits.push(`b${e.batch}`);
    if (e.kind === "fill") {
      if (e.fee) bits.push(`fee ${e.fee}`);
      if (e.closed_pnl && Number(e.closed_pnl)) bits.push(`pnl ${e.closed_pnl}`);
      if (e.received_at) bits.push(`seen +${Math.max(0, Date.parse(e.received_at) - e.t)} ms`);
    }
    if (e.kind === "sent" && e.slope && Number.isFinite(e.slope.bps_per_s)) {
      bits.push(`slope ${e.slope.bps_per_s >= 0 ? "+" : ""}${e.slope.bps_per_s.toFixed(1)}${e.slope.verdict && e.slope.verdict !== "none" ? " " + e.slope.verdict : ""}`);
    }
    if (e.error) bits.push(e.error);
    return bits.join("  ");
  };

  // ---- the bot's parameters for the key ----
  //
  // The page's gate and slope inputs are seeded from the bot's CURRENT
  // config for the key (control's stored document, defaults with the
  // instrument's overrides), so a change made in the bot shows on the plot
  // without retyping. Typed values stand until the next key change. Without
  // CONTROL_URL on the server the inputs keep the page's own defaults.
  async function loadParams() {
    const bot = $("bot").value, inst = $("instrument").value;
    if (!bot || !inst) return;
    let p;
    try {
      p = await api(`/api/params?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}`);
    } catch (e) {
      $("paramsrc").textContent = `inputs: page defaults (${e.message})`;
      return;
    }
    const t = p.params?.taker ?? {};
    const set = (id, v) => { if (v != null && v !== "") $(id).value = String(v); };
    const se = t.exit?.slope_exit ?? {};
    set("slopefast", se.fast_ms); set("slopeslow", se.slow_ms);
    if (se.source === "leader" || se.source === "lagger") $("slopesrc").value = se.source;
    const en = t.entry ?? {};
    set("impulsehl", en.leader_impulse_halftime_ms); set("impulsemin", en.leader_impulse_min_bps); set("impulsefrac", en.leader_impulse_fraction);
    set("basishl", t.signal?.basis_halftime_ms);
    $("paramsrc").textContent = `inputs: ${esc(p.strategy ?? "")} config v${p.version ?? "?"}`;
  }

  async function loadEvents() {
    const bot = $("bot").value, inst = $("instrument").value, mode = $("mode").value;
    if (!bot || !inst) { $("events").querySelector("tbody").innerHTML = ""; state.events = []; return; }
    await loadParams();
    const { events } = await api(`/api/events?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&limit=600`);
    // Pairing reads forwards in time; the list reads newest first.
    pairAmends([...events].sort((a, b) => a.t - b.t || a.id - b.id));
    state.events = events;
    const tb = $("events").querySelector("tbody");
    tb.innerHTML = events.map((e) => {
      const px = e.px ?? e.order_px;
      return `
      <tr class="o${state.selectedEvent === e.id ? " ev-sel" : ""}" data-cloid="${esc(e.cloid)}" data-id="${e.id}" data-t="${e.t}" data-px="${esc(px ?? "")}">
        <td class="mono${venueClock(e) ? " venue" : ""}" title="${venueClock(e) ? "the venue's fill time" : "our clock"}">${fmt(e.t).slice(5, 23)}</td>
        <td><span class="b b-${badgeClass(e)}" title="${esc(e.kind)}${e.status ? ": " + esc(e.status) : ""}">${esc(eventLabel(e))}</span></td>
        <td class="mono cloid" title="${esc(e.cloid)} (click to copy)">${esc(shortCloid(e.cloid))}</td>
        <td class="${esc(e.side)}">${esc(e.side)}${e.reduce_only ? " ro" : ""}</td>
        <td class="mono${e.px == null ? " meta" : ""}" title="${e.px == null ? "the order's price; this event carries none of its own" : ""}">${esc(px)}</td>
        <td class="mono">${esc(e.sz ?? "")}</td>
        <td class="meta">${esc(noteOf(e))}</td>
      </tr>`;
    }).join("");
    for (const tr of tb.querySelectorAll("tr.o")) {
      tr.onclick = () => {
        state.selected = tr.dataset.cloid;
        state.selectedEvent = Number(tr.dataset.id);
        centreOn(Number(tr.dataset.t), Number(tr.dataset.px));
      };
      // Hovering the row rings every point the order left on the plot: the
      // insert, its fills, an amend, the cancel. One order is usually
      // several marks scattered across the window.
      tr.onmouseenter = () => { state.hoverCloid = tr.dataset.cloid; state.hoverEvent = Number(tr.dataset.id); requestDraw(); };
      tr.onmouseleave = () => { if (state.hoverCloid === tr.dataset.cloid) { state.hoverCloid = null; state.hoverEvent = null; requestDraw(); } };
      const cell = tr.querySelector("td.cloid");
      if (cell) {
        cell.onclick = (ev) => {
          // Copying is what this cell is for; centring the plot is what the
          // rest of the row is for.
          ev.stopPropagation();
          const full = tr.dataset.cloid;
          navigator.clipboard?.writeText(full).then(
            () => { cell.textContent = "copied"; setTimeout(() => { cell.textContent = shortCloid(full); }, 800); },
            () => {},
          );
        };
      }
    }
  }

  function setCentre(ms) {
    // Centring on something is the other way of choosing a window; an
    // explicit range would just override it silently.
    clearRange();
    state.centreMs = ms;
    $("centre").value = fmt(ms);
    for (const tr of $("events").querySelectorAll("tr.o")) {
      tr.classList.toggle("sel", tr.dataset.cloid === state.selected);
      tr.classList.toggle("ev-sel", Number(tr.dataset.id) === state.selectedEvent);
    }
    void load();
  }

  // ---- events -> markers ----
  // Every marker is coloured by side: buys green, sells red. An insert is a
  // triangle pointing right, solid when the order (partially) filled and
  // outline only when nothing filled; fills are dots; cancels and rejections
  // are crosses. Acks that merely confirm a resting or filled state draw
  // nothing of their own: the insert's marker already carries the outcome.
  const GREEN = "#3fb950", RED = "#f85149", OTHER = "#c9d1d9";
  const sideColor = (e) => (e.side === "buy" ? GREEN : e.side === "sell" ? RED : OTHER);
  const filled = (e) => e.order_status === "filled" || Number(e.order_filled) > 0;
  // kind key -> [symbol, size px, solid, label]
  // Every decision the bot took is on the plot, and what KIND of order it
  // was is the shape: an opening IOC is a triangle pointing right, a
  // closing ALO rung a square, a closing IOC (the escalation) a triangle
  // pointing left. Solid when the order filled at all, outline when it did
  // not - so a refused ALO rung is an outline square with the REJECTED
  // cross on it, and is never confused with the open that preceded it.
  const KIND = {
    "open:filled": ["tri", 9, true, "open IOC, filled"],
    "open:unfilled": ["tri", 9, false, "open IOC, no fill"],
    "rung:filled": ["square", 7, true, "close ALO, filled"],
    "rung:unfilled": ["square", 7, false, "close ALO, no fill"],
    "cross:filled": ["tri-left", 9, true, "close IOC, filled"],
    "cross:unfilled": ["tri-left", 9, false, "close IOC, no fill"],
    "acked:resting": ["circle", 4, false, "acked: resting (our clock)"],
    "acked:filled": ["diamond", 5, true, "acked: filled (our clock; the fills sit at the venue's time)"],
    "acked:rejected": ["circle-x", 9, false, "REJECTED"],
    "acked:unknown": ["diamond", 8, false, "acked: unknown"],
    "amend:ok": ["arrow", 9, true, "amended to here"],
    "amend:refused": ["arrow", 9, false, "amend REFUSED (it stayed put)"],
    "fill": ["circle", 5, true, "fill"],
    "cancel_sent": ["x", 6, false, "cancel sent"],
    "cancelled:ok": ["x", 6, true, "cancelled"],
    "cancelled:failed": ["circle-x", 9, true, "cancel FAILED"],
    "left_resting": ["hexagon", 8, false, "left resting"],
    // Nothing is dropped for want of a shape.
    "other": ["diamond", 7, false, "event"],
  };
  const keyOf = (e) => {
    if (e.kind === "sent") {
      // A resting close is a rung whatever it rests as (ALO or GTC); only
      // an IOC close is the escalation's cross.
      const what = !e.reduce_only ? "open" : e.tif === "ioc" ? "cross" : "rung";
      return `${what}:${filled(e) ? "filled" : "unfilled"}`;
    }
    // A resting or filled ack repeats what the insert and the fills already
    // show; a rejection or an unknown is the whole story of that order.
    // An amend is a request: the answer that followed it on the same cloid
    // says whether the order actually moved (see `pairAmends`). A refused
    // one is drawn hollow at the price it did NOT reach.
    if (e.kind === "amend") return e.amend_ok === false ? "amend:refused" : "amend:ok";
    // Every event is on the plot, an ack included: it marks the moment the
    // answer was READ here, which against the fill's venue time is the
    // round trip made visible.
    if (e.kind === "acked") return KIND[`acked:${e.status}`] ? `acked:${e.status}` : "acked:unknown";
    if (e.kind === "cancelled") return `cancelled:${e.status ?? "ok"}`;
    return KIND[e.kind] ? e.kind : "other";
  };
  const priceOf = (e) => {
    const n = (v) => (v == null || v === "" ? null : Number(v));
    if (e.kind === "acked" && e.status === "filled") return n(e.px) ?? n(e.order_avg_px) ?? n(e.order_px);
    // Every event plots where IT happened: an insert at the price it was
    // sent at, an amend at the price it moved to, a fill at the fill. The
    // order's own price is only the fallback - an amend rewrites it, and an
    // insert marker must not slide to a price it never had.
    return n(e.px) ?? n(e.order_px);
  };
  // Price times size, as money: what a line of the tooltip is actually
  // worth. Blank when either is missing rather than a misleading 0.
  const usd = (px, sz) => {
    const n = Number(px) * Number(sz);
    return Number.isFinite(n) && px != null && sz != null && px !== "" && sz !== "" ? `  = $${n.toFixed(2)}` : "";
  };
  const hover = (e) => {
    const lines = [
      `<b>${esc(KIND[keyOf(e)]?.[3] ?? `${e.kind}${e.status ? ": " + e.status : ""}`)}</b>  ${fmtMs(e.t)} UTC`,
      `${esc(e.side)} ${esc(String(e.tif ?? "").toUpperCase())}${e.reduce_only ? " reduce-only" : ""}  reason ${esc(e.reason)}${e.priority ? `  p${e.priority}` : ""}`,
      `order px ${esc(e.order_px)}  sz ${esc(e.order_sz)}${usd(e.order_px, e.order_sz)}  ->  ${esc(e.order_status)}${Number(e.order_filled) ? ` ${esc(e.order_filled)} @ ${esc(e.order_avg_px)}${usd(e.order_avg_px, e.order_filled)}` : ""}`,
    ];
    if (e.kind === "amend") {
      lines.push(
        e.amend_ok === false
          ? `<span style="color:#f85149">REFUSED: it did not move to ${esc(e.px)}</span>`
          : e.amend_ok
            ? `moved to ${esc(e.px)}  sz ${esc(e.sz)}${usd(e.px, e.sz)}`
            : `re-price to ${esc(e.px)} requested (no answer yet in this window)`,
      );
      if (e.amend_error) lines.push(`<span style="color:#f85149">${esc(e.amend_error)}</span>`);
    }
    if (e.kind === "fill") lines.push(`fill px ${esc(e.px)} sz ${esc(e.sz)}${usd(e.px, e.sz)}${e.fee ? `  fee $${esc(e.fee)}` : ""}${e.closed_pnl ? `  pnl $${esc(e.closed_pnl)}` : ""} (${esc(e.source)})`);
    const s = e.slope;
    if (s && Number.isFinite(s.bps_per_s)) {
      // What the bot read off the lagger's slope when it decided this close, and what it did with it.
      const f = (v, p = 1) => (typeof v === "number" ? v.toFixed(p) : "-");
      lines.push(`<b>${esc(s.source ?? "lagger")} slope</b> ${s.bps_per_s >= 0 ? "+" : ""}${f(s.bps_per_s)} bps/s ${s.in_favour ? "in favour" : "against"}${s.significant ? "" : ", below the noise floor"}`
        + `  ->  ${esc(s.verdict)}${s.enabled ? "" : " (slope exit off: recorded only)"}`);
      lines.push(`slope emas fast ${f(s.fast, 6)} slow ${f(s.slow, 6)} mid ${f(s.mid, 6)}`);
    }
    if (e.kind === "acked" && e.status === "filled") lines.push(`filled ${esc(e.sz)} @ ${esc(e.px)}${usd(e.px, e.sz)}`);
    if (e.error) lines.push(`<span style="color:#f85149">${esc(e.error)}</span>`);
    lines.push(`cloid ${esc(e.cloid)}${e.batch != null ? `  batch ${e.batch}` : ""}${e.mode ? `  ${esc(e.mode)}` : ""}${e.oid ? `  oid ${esc(e.oid)}` : ""}`);
    if (e.parent_cloid) lines.push(`closes open ${esc(shortCloid(e.parent_cloid))}`);
    const d = e.decision;
    if (d) {
      const f = (v, p = 1) => (typeof v === "number" ? v.toFixed(p) : "-");
      lines.push(`<b>decision</b> dev ${f(d.deviation_bps)} bps (raw ${f(d.raw_deviation_bps)}), basis ${f(d.basis_bps)}`);
      lines.push(`threshold ${f(d.threshold_bps)} bps, gain ${f(d.gain_bps)} (raw ${f(d.raw_gain_bps)}), rho ${f(d.rho, 2)}, delta ${f(d.delta_ms, 0)} ms`);
      lines.push(`leader mid ${esc(d.leader_mid)}  lagger ${esc(d.lagger_bid)} / ${esc(d.lagger_ask)}`);
      if (d.leader_impulse_bps != null) lines.push(`leader impulse ${f(d.leader_impulse_bps)} bps off its short ema`);
      lines.push(`quote age: leader ${f(d.leader_age_ms, 0)} ms, lagger ${f(d.lagger_age_ms, 0)} ms`);
    }
    return lines.join("<br>");
  };

  // ---- load a window and build the drawable series ----
  const SLOPE_COLOR = "#ff9f43";
  const IMPULSE_COLOR = "#c084fc";
  const VENUE = {
    binance_perps: { width: 1, color: "#3d7bd6", label: "binance" },
    binance: { width: 1, color: "#5aa0ff", label: "binance spot" },
    hyperliquid: { width: 2, color: "#e3b341", label: "hyperliquid" },
  };

  /** Bring an event to the middle WITHOUT changing the zoom: the visible
   *  width and height stay what they are, the view slides so the dot is
   *  centred. Inside the loaded window that is a pan and a redraw; outside
   *  it the window is reloaded around the event and the same zoom applied
   *  to it. Showing the whole window again is what double-click is for. */
  function centreOn(t, px) {
    const v = state.view, win = state.win;
    if (!v || !win) { setCentre(t); return; }
    const w = v.x1 - v.x0, h = v.y1 - v.y0;
    const nv = { x0: t - w / 2, x1: t + w / 2, y0: v.y0, y1: v.y1 };
    // Bring the dot into the price range only when it is outside it; a dot
    // already on screen does not move the y axis under the reader.
    if (Number.isFinite(px) && (px < v.y0 || px > v.y1)) { nv.y0 = px - h / 2; nv.y1 = px + h / 2; }
    if (nv.x0 >= win.full.x0 && nv.x1 <= win.full.x1) {
      state.view = nv;
      for (const tr of $("events").querySelectorAll("tr.o")) {
        tr.classList.toggle("sel", tr.dataset.cloid === state.selected);
        tr.classList.toggle("ev-sel", Number(tr.dataset.id) === state.selectedEvent);
      }
      $("centre").value = fmt(t);
      state.centreMs = t;
      requestDraw();
      return;
    }
    // Off the loaded window: fetch a new one around it, keep the zoom.
    state.keepZoom = { w, h, px };
    setCentre(t);
  }

  async function load() {
    const bot = $("bot").value, inst = $("instrument").value, mode = $("mode").value;
    if (!bot || !inst || state.centreMs == null) return;
    const range = customRange();
    const span = Number($("span").value);
    const from = range ? range.from : Math.floor(state.centreMs - span / 2);
    const to = range ? range.to : Math.ceil(state.centreMs + span / 2);
    // The rest of the page still thinks in a centre: keep it on the range's
    // middle so the arrows, the order list and the plot agree.
    if (range) state.centreMs = Math.round((from + to) / 2);
    // Only the NEWEST request may land. Two clicks in quick succession used
    // to race: the first answer, arriving last, replaced the window the
    // second click had asked for, and the plot sat on the wrong order.
    const seq = ++state.loadSeq;
    if (state.abort) state.abort.abort();
    const abort = new AbortController();
    state.abort = abort;
    const key = `${bot}|${inst}|${mode}|${from}|${to}`;
    let w = cachedWindow(key);
    if (!w) {
      status(range?.clamped ? "loading (range clamped to 6 h)" : "loading");
      setLoading(true);
      try {
        w = await api(`/api/window?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&from_ms=${from}&to_ms=${to}`, abort.signal);
      } catch (e) {
        if (seq !== state.loadSeq) return; // superseded: the newer request reports
        setLoading(false);
        status(e.message, true);
        return;
      }
      if (seq !== state.loadSeq) return;
      rememberWindow(key, w);
    }
    setLoading(false);
    state.abort = null;
    state.raw = { w, from, to, inst };
    state.win = build(w, from, to, inst);
    state.view = { ...state.win.full };
    // A centring that crossed out of the old window arrives here with the
    // zoom it had; apply it around the new centre if it fits.
    const keep = state.keepZoom;
    state.keepZoom = null;
    if (keep && keep.w < to - from) {
      const full = state.win.full;
      const nv = { x0: state.centreMs - keep.w / 2, x1: state.centreMs + keep.w / 2, y0: full.y0, y1: full.y1 };
      if (Number.isFinite(keep.px) && keep.h > 0) { nv.y0 = keep.px - keep.h / 2; nv.y1 = keep.px + keep.h / 2; }
      state.view = nv;
    }
    state.pinned = null;
    tip.hidden = true;
    tip.classList.remove("pinned");
    renderLegend();
    const nq = state.win.lines.reduce((a, l) => a + (l.id.endsWith(":bid") ? l.t.length : 0), 0);
    status(`${nq} quotes, ${w.events.length} events, ${(w.conditions ?? []).length} conditions, ${fmt(from).slice(11, 19)} to ${fmt(to).slice(11, 19)} UTC${w.quotes.bucketed_ms ? `, bucketed to ${w.quotes.bucketed_ms} ms` : ""}`);
    requestDraw();
  }

  /** Mark every amend with the answer that came back for it: the next ack
   *  on the same cloid. `resting` means the order moved; a rejection or an
   *  unknown means it stayed where it was. */
  function pairAmends(events) {
    const waiting = new Map(); // cloid -> the amends still unanswered
    for (const e of events) {
      if (e.kind === "amend") {
        e.amend_ok = null;
        e.amend_error = null;
        const q = waiting.get(e.cloid) ?? [];
        q.push(e);
        waiting.set(e.cloid, q);
        continue;
      }
      if (e.kind !== "acked") continue;
      const q = waiting.get(e.cloid);
      if (!q || q.length === 0) continue;
      const amend = q.shift();
      amend.amend_ok = e.status === "resting" || e.status === "filled";
      if (!amend.amend_ok) amend.amend_error = e.error ?? e.status ?? "refused";
    }
  }

  function build(w, from, to, inst) {
    const venues = Object.keys(w.quotes.by_venue).sort();
    const lines = [];
    let lo = Infinity, hi = -Infinity;
    for (const v of venues) {
      const rows = w.quotes.by_venue[v];
      const st = VENUE[v] ?? { width: 1.5, color: "#aaa", label: v };
      const t = new Float64Array(rows.length), bid = new Float64Array(rows.length), ask = new Float64Array(rows.length);
      rows.forEach((r, i) => { t[i] = r.t; bid[i] = r.bid; ask[i] = r.ask; if (r.bid < lo) lo = r.bid; if (r.ask > hi) hi = r.ask; });
      lines.push({ id: `${v}:bid`, name: `${st.label} bid`, color: st.color, width: st.width, dash: null, t, v: bid });
      lines.push({ id: `${v}:ask`, name: `${st.label} ask`, color: st.color, width: st.width, dash: [4, 3], t, v: ask });
    }
    // The EMA of the Hyperliquid mid at the chosen half-life -- the bot's
    // own definition, so the line is what the strategy sees, not a textbook
    // EMA: the estimate moves toward the observation it has been HOLDING by
    // 1 - 0.5^(dt / halftime) when the next one arrives, then holds that.
    // Time-based, so irregular ticks are weighted by how long they stood.
    // On a bucketed window the input is the bucket's last quote, which
    // smooths the line more than the bot saw; the status line says when.
    const emaMs = Number($("ema").value);
    const hl = w.quotes.by_venue.hyperliquid;
    /** The bot's EMA of the Hyperliquid mid at `halftimeMs`, one value per
     *  quote, evaluated as of that quote. */
    const emaOf = (halftimeMs) => {
      const v = new Float64Array(hl.length);
      let est = 0, held = 0, ts = 0;
      hl.forEach((r, i) => {
        const mid = (r.bid + r.ask) / 2;
        if (i === 0) { est = mid; held = mid; ts = r.t; }
        else {
          const dt = Math.max(0, r.t - ts);
          est += (held - est) * (1 - Math.pow(0.5, dt / halftimeMs));
          held = mid; ts = Math.max(ts, r.t);
        }
        v[i] = est;
      });
      return v;
    };
    if (emaMs > 0 && hl && hl.length) {
      const t = Float64Array.from(hl, (r) => r.t);
      const st = VENUE.hyperliquid;
      lines.push({ id: "hyperliquid:ema", name: `${st.label} mid ema ${emaMs} ms`, color: "#f5dc8c", width: 1.5, dash: [8, 3], t, v: emaOf(emaMs) });
    }
    // The exit slope, as the bot reads it (taker.exit.slope_exit.fast_ms /
    // slow_ms): two EMAs of the mid, slope = (fast - slow) /
    // (tau_slow - tau_fast) with tau = half-life / ln 2, in bps of the mid
    // per second. Drawn on the lower pane's right axis; the tangent at each
    // exit IOC comes from the slope the bot RECORDED with that order when
    // there is one, else from this series at that instant.
    const slopeFast = Number($("slopefast").value), slopeSlow = Number($("slopeslow").value);
    // Whose mid (taker.exit.slope_exit.source): the lagger's, or the
    // leader's, which quotes first and so turns first.
    const slopeSrc = $("slopesrc").value === "leader" ? "leader" : "lagger";
    const srcRows = slopeSrc === "leader" ? (w.quotes.by_venue.binance_perps ?? w.quotes.by_venue.binance) : hl;
    let slope = null;
    if (slopeFast > 0 && slopeSlow > slopeFast && srcRows && srcRows.length) {
      const emaOfRows = (rows, halftimeMs) => {
        const v = new Float64Array(rows.length);
        let est = 0, held = 0, ts = 0;
        rows.forEach((r, i) => {
          const mid = (r.bid + r.ask) / 2;
          if (i === 0) { est = mid; held = mid; ts = r.t; }
          else { const dt = Math.max(0, r.t - ts); est += (held - est) * (1 - Math.pow(0.5, dt / halftimeMs)); held = mid; ts = Math.max(ts, r.t); }
          v[i] = est;
        });
        return v;
      };
      const fast = emaOfRows(srcRows, slopeFast), slow = emaOfRows(srcRows, slopeSlow);
      const dtau = (slopeSlow - slopeFast) / Math.LN2; // ms
      const t = Float64Array.from(srcRows, (r) => r.t), v = new Float64Array(srcRows.length);
      srcRows.forEach((r, i) => {
        const mid = (r.bid + r.ask) / 2;
        v[i] = mid > 0 ? ((fast[i] - slow[i]) / dtau) * 1000 / mid * 10000 : 0;
      });
      slope = { t, v, fast: slopeFast, slow: slopeSlow, source: slopeSrc };
    }
    pairAmends(w.events);
    const groups = {};
    for (const e of w.events) {
      const k = keyOf(e);
      if (!k) continue;
      const px = priceOf(e);
      if (px == null || !Number.isFinite(px)) continue;
      const id = `${e.side ?? "none"}|${k}`;
      const [symbol, size, solid, label] = KIND[k];
      (groups[id] ??= { id, name: `${e.side ?? ""} ${label}`.trim(), color: sideColor(e), symbol, size, solid, pts: [] })
        .pts.push({ t: e.t, y: px, text: hover(e), cloid: e.cloid, id: e.id, k, side: e.side, slope: e.slope ?? null });
      if (px < lo) lo = px; if (px > hi) hi = px;
    }
    const marks = Object.values(groups);
    // Deviation: leader mid over lagger mid in bps, sampled at the lagger's quotes.
    const leader = w.quotes.by_venue.binance_perps ?? w.quotes.by_venue.binance ?? [];
    const lagger = w.quotes.by_venue.hyperliquid ?? [];
    const dev = { t: [], v: [], basis: false };
    let i = 0;
    for (const q of lagger) {
      while (i + 1 < leader.length && leader[i + 1].t <= q.t) i++;
      if (!leader.length || leader[i].t > q.t) continue;
      const lm = (leader[i].bid + leader[i].ask) / 2, hm = (q.bid + q.ask) / 2;
      dev.t.push(q.t); dev.v.push(10000 * (lm / hm - 1));
    }
    // The bot's DEVIATION is the edge less its basis, the slow EMA of the
    // edge (taker.signal.basis_halftime_ms): a standing offset between the
    // venues is not a signal. With a half-life set, the pane shows that,
    // as the bot sees it; 0 shows the raw edge.
    const basisHl = Number($("basishl").value);
    if (basisHl > 0 && dev.t.length) {
      let est = dev.v[0], held = dev.v[0], ts = dev.t[0];
      for (let k = 0; k < dev.t.length; k++) {
        if (k > 0) {
          const dt = Math.max(0, dev.t[k] - ts);
          est += (held - est) * (1 - Math.pow(0.5, dt / basisHl));
          held = dev.v[k]; ts = Math.max(ts, dev.t[k]);
        }
        dev.v[k] -= est;
      }
      dev.basis = true;
    }
    // The impulse gate's reading (taker.entry.leader_impulse_*): at every
    // leader quote, how far the new mid stands from the EMA of the mids
    // before it, at the chosen half-life, in bps and signed (up positive).
    // The bot's EMA holds each observation until the next, so the estimate
    // at a quote is the previous one moved toward the held mid by
    // 1 - 0.5^(dt / half-life); the gap is the new mid over that estimate.
    // A jump shows whole; a drift shows as rate x tau, small.
    const impulseHl = Number($("impulsehl").value), impulseMin = Number($("impulsemin").value);
    let impulse = null;
    const impulseFrac = Number($("impulsefrac").value);
    if (impulseHl > 0 && leader.length) {
      const t = new Float64Array(leader.length), v = new Float64Array(leader.length);
      const ema = new Float64Array(leader.length), heldAt = new Float64Array(leader.length);
      let est = 0, held = 0, ts = 0;
      leader.forEach((r, i) => {
        const mid = (r.bid + r.ask) / 2;
        if (i === 0) { est = mid; held = mid; ts = r.t; v[i] = 0; }
        else {
          const dt = Math.max(0, r.t - ts);
          est += (held - est) * (1 - Math.pow(0.5, dt / impulseHl));
          v[i] = est > 0 ? 10000 * (mid / est - 1) : 0;
          held = mid; ts = Math.max(ts, r.t);
        }
        t[i] = r.t; ema[i] = est; heldAt[i] = held;
      });
      // The reading at ANY instant: the estimate as of the last quote,
      // moved toward the held mid by the time since, and the held mid over
      // it. Between quotes the impulse decays; this is that decay.
      const at = (when) => {
        let k = lowerBound(t, when);
        if (k >= t.length || t[k] > when) k--;
        if (k < 0) return 0;
        const dt = Math.max(0, when - t[k]);
        const value = ema[k] + (heldAt[k] - ema[k]) * (1 - Math.pow(0.5, dt / impulseHl));
        return value > 0 ? 10000 * (heldAt[k] / value - 1) : 0;
      };
      impulse = { t, v, hl: impulseHl, min: impulseMin, frac: impulseFrac, at };
      // The leader's EMA itself, on the price pane: the level the impulse
      // is measured from.
      lines.push({ id: "binance:ema", name: `binance mid ema ${impulseHl} ms (impulse)`, color: "#8fb8ff", width: 1.5, dash: [8, 3], t, v: ema });
    }
    const last = [...w.events].reverse().find((e) => e.decision?.threshold_bps != null);
    const threshold = last ? last.decision.threshold_bps : null;
    // Where the gate would have let an open through: the deviation past the
    // threshold AND the impulse, at that instant and the deviation's way,
    // at least max(min, fraction x |deviation|). +1 open, -1 refused by the
    // impulse, 0 nothing to open. (The threshold is the last decision's in
    // the window; rho, the half spread and the holds are not modelled.)
    if (impulse && threshold != null) {
      dev.gate = new Int8Array(dev.t.length);
      for (let k = 0; k < dev.t.length; k++) {
        const dv = dev.v[k];
        if (Math.abs(dv) <= threshold) continue;
        const gap = impulse.at(dev.t[k]) * Math.sign(dv);
        const needed = Math.max(impulse.min, impulse.frac * Math.abs(dv));
        dev.gate[k] = gap >= needed ? 1 : -1;
      }
    }
    const pad = Number.isFinite(lo) && hi > lo ? (hi - lo) * 0.06 : Math.abs(lo || 1) * 0.001;
    const full = { x0: from, x1: to, y0: Number.isFinite(lo) ? lo - pad : 0, y1: Number.isFinite(hi) ? hi + pad : 1 };
    // Time-anchored, not price-anchored: a hold has no price, and what it
    // explains is the ABSENCE of orders in that stretch.
    const conditions = (w.conditions ?? [])
      .filter((c) => CONDITION[c.kind])
      .map((c) => ({ t: c.t, kind: c.kind, details: c.details ?? {} }));
    return { inst, lines, marks, dev, threshold, full, conditions, slope, impulse };
  }

  /** The conditions worth a rule on the chart, and how they are drawn. A
   *  hold is why nothing was traded, so it belongs where the eye is already
   *  looking for the missing order. */
  const CONDITION = {
    shock_hold:     ["#d29922", "shock"],
    no_follow_hold: ["#db6d28", "no follow"],
    phase:          ["#f85149", "phase"],
    resync:         ["#a371f7", "resync"],
  };

  // ---- legend: every line and marker group toggles on its own ----
  function renderLegend() {
    const el = $("legend");
    const items = [
      ...state.win.lines.map((l) => ({ id: l.id, name: l.name, color: l.color, kind: l.dash ? "dash" : "line" })),
      ...state.win.marks.map((m) => ({ id: m.id, name: m.name, color: m.color, kind: m.symbol, solid: m.solid })),
      ...(state.win.slope
        ? [
            { id: "slope:line", name: `${state.win.slope.source} slope ${state.win.slope.fast}/${state.win.slope.slow} ms (bps/s, right axis)`, color: SLOPE_COLOR, kind: "line" },
            { id: "slope:tangent", name: "slope at the exit IOC", color: SLOPE_COLOR, kind: "dash" },
          ]
        : []),
      ...(state.win.impulse
        ? [
            { id: "leader:impulse", name: `leader impulse ${state.win.impulse.hl} ms (bps${state.win.impulse.min > 0 ? `, gate ${state.win.impulse.min}` : ""})`, color: IMPULSE_COLOR, kind: "line" },
            ...(state.win.dev.gate ? [{ id: "gate:overlay", name: "gate bands: green an open would have gone through, red the impulse refused it", color: GREEN, kind: "line" }] : []),
          ]
        : []),
    ];
    el.innerHTML = items.map((it) => `<button class="lg${state.hidden.has(it.id) ? " off" : ""}" data-id="${esc(it.id)}"><canvas width="22" height="14"></canvas>${esc(it.name)}</button>`).join("")
      + `<span class="help"><b>drag</b> selects an area to zoom, <b>two fingers</b> pan, <b>pinch</b> (or ctrl + wheel) zooms, <b>double-click</b> shows the whole window</span>`;
    for (const btn of el.querySelectorAll("button.lg")) {
      const it = items.find((x) => x.id === btn.dataset.id);
      const c = btn.querySelector("canvas").getContext("2d");
      if (it.kind === "line" || it.kind === "dash") {
        c.strokeStyle = it.color; c.lineWidth = 2; if (it.kind === "dash") c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(1, 7); c.lineTo(21, 7); c.stroke();
      } else {
        drawSymbol(c, it.kind, 11, 7, 6, it.color, it.solid);
      }
      btn.onclick = () => {
        if (state.hidden.has(it.id)) state.hidden.delete(it.id); else state.hidden.add(it.id);
        btn.classList.toggle("off", state.hidden.has(it.id));
        requestDraw();
      };
    }
  }

  // ---- the canvas ----
  const cv = $("plot"), ctx = cv.getContext("2d"), wrap = $("plotwrap"), tip = $("tip");
  // Room on the right for the slope's own axis in the lower pane.
  const M = { l: 74, r: 54, t: 10, b: 30, gap: 26 };
  let W = 0, H = 0; // css pixels
  function panes() {
    const inner = H - M.t - M.b - M.gap;
    const ph = Math.max(50, inner * 0.7);
    return {
      price: { top: M.t, h: ph },
      bps: { top: M.t + ph + M.gap, h: Math.max(30, inner - ph) },
      left: M.l, w: Math.max(10, W - M.l - M.r),
    };
  }
  const xPx = (P, t, v) => P.left + ((t - v.x0) / (v.x1 - v.x0)) * P.w;
  const pxX = (P, x, v) => v.x0 + ((x - P.left) / P.w) * (v.x1 - v.x0);
  const yPx = (pane, val, lo, hi) => pane.top + ((hi - val) / (hi - lo)) * pane.h;
  const pxY = (pane, y, lo, hi) => hi - ((y - pane.top) / pane.h) * (hi - lo);

  function resize() {
    const r = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = Math.max(100, Math.floor(r.width)); H = Math.max(100, Math.floor(r.height));
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }
  new ResizeObserver(resize).observe(wrap);

  function requestDraw() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; draw(); });
  }

  // binary search: first index with t[i] >= x
  function lowerBound(t, x) {
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** The slope at a marker, bps/s: what the bot recorded with the order if
   *  it did, else the page's series as of the marker's instant. */
  function slopeAt(slope, p) {
    if (p.slope && Number.isFinite(p.slope.bps_per_s)) return p.slope.bps_per_s;
    if (!slope || !slope.t.length) return null;
    let i = lowerBound(slope.t, p.t);
    if (i >= slope.t.length || slope.t[i] > p.t) i--;
    return i >= 0 ? slope.v[i] : null;
  }

  function timeTicks(v, wpx) {
    const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];
    const span = v.x1 - v.x0;
    const step = steps.find((s) => span / s <= wpx / 95) ?? 3600000;
    const out = [];
    for (let t = Math.ceil(v.x0 / step) * step; t <= v.x1; t += step) out.push({ t, label: step < 1000 ? fmtMs(t) : fmt(t).slice(11, 19) });
    return out;
  }
  function valueTicks(lo, hi, hpx, minPx = 38) {
    if (!(hi > lo)) return [];
    const raw = (hi - lo) / Math.max(1, hpx / minPx);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const dp = Math.max(0, -Math.floor(Math.log10(step)) + (step / mag === 2.5 ? 1 : 0));
    const out = [];
    for (let y = Math.ceil(lo / step) * step; y <= hi + step * 1e-9; y += step) out.push({ y, label: y.toFixed(Math.min(dp, 10)) });
    return out;
  }

  function drawSymbol(c, sym, x, y, s, color, solid) {
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = solid && sym === "x" ? 2.6 : 1.6;
    c.beginPath();
    switch (sym) {
      case "tri": c.moveTo(x - s * 0.7, y - s * 0.8); c.lineTo(x + s * 0.9, y); c.lineTo(x - s * 0.7, y + s * 0.8); c.closePath(); break;
      case "tri-left": c.moveTo(x + s * 0.7, y - s * 0.8); c.lineTo(x - s * 0.9, y); c.lineTo(x + s * 0.7, y + s * 0.8); c.closePath(); break;
      case "square": c.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6); break;
      case "circle": c.arc(x, y, s, 0, Math.PI * 2); break;
      case "x": c.moveTo(x - s, y - s); c.lineTo(x + s, y + s); c.moveTo(x + s, y - s); c.lineTo(x - s, y + s); break;
      case "circle-x": c.arc(x, y, s, 0, Math.PI * 2); c.moveTo(x - s * 0.6, y - s * 0.6); c.lineTo(x + s * 0.6, y + s * 0.6); c.moveTo(x + s * 0.6, y - s * 0.6); c.lineTo(x - s * 0.6, y + s * 0.6); break;
      case "diamond": c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); break;
      case "arrow":
        // A short horizontal bar with a tick: the price this rung moved to.
        c.moveTo(x - s, y); c.lineTo(x + s, y);
        c.moveTo(x + s * 0.4, y - s * 0.5); c.lineTo(x + s, y); c.lineTo(x + s * 0.4, y + s * 0.5);
        break;
      case "hexagon": for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; const px = x + s * Math.cos(a), py = y + s * Math.sin(a); if (k) c.lineTo(px, py); else c.moveTo(px, py); } c.closePath(); break;
      default: c.arc(x, y, s, 0, Math.PI * 2);
    }
    if (solid && sym !== "x" && sym !== "circle-x") c.fill();
    if (sym === "arrow") {
      // Dashed when the venue refused the move: the order never got here.
      if (!solid) c.setLineDash([3, 3]);
      c.stroke();
      c.setLineDash([]);
      return;
    }
    if (sym === "circle-x" && solid) { c.stroke(); c.beginPath(); c.arc(x, y, s, 0, Math.PI * 2); c.globalAlpha = 0.35; c.fill(); c.globalAlpha = 1; return; }
    c.stroke();
  }

  /** The gate as background bands across `pane`: green where an open would
   *  have gone through, red where the deviation was there but the impulse
   *  refused it. Runs of consecutive samples become one band, so a stretch
   *  reads as a stretch. Drawn under everything else in both panes. */
  function paintGate(P, pane, v, d) {
    if (!d.gate || state.hidden.has("gate:overlay")) return;
    let i0 = lowerBound(d.t, v.x0); if (i0 > 0) i0--;
    const i1 = Math.min(d.t.length - 1, lowerBound(d.t, v.x1));
    for (const [want, color] of [[1, "rgba(63,185,80,0.22)"], [-1, "rgba(248,81,73,0.18)"]]) {
      ctx.fillStyle = color;
      let i = i0;
      while (i <= i1) {
        if (d.gate[i] !== want) { i++; continue; }
        let j = i;
        while (j + 1 <= i1 && d.gate[j + 1] === want) j++;
        const x0 = Math.max(P.left, xPx(P, d.t[i], v));
        const x1 = Math.min(P.left + P.w, j + 1 < d.t.length ? xPx(P, d.t[j + 1], v) : P.left + P.w);
        ctx.fillRect(x0, pane.top, Math.max(1.5, x1 - x0), pane.h);
        i = j + 1;
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0b0e13"; ctx.fillRect(0, 0, W, H);
    const w = state.win, v = state.view;
    if (!w || !v) return;
    const P = panes();
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";

    // panes' background and grid
    for (const pane of [P.price, P.bps]) { ctx.fillStyle = "#0f141b"; ctx.fillRect(P.left, pane.top, P.w, pane.h); }
    const xt = timeTicks(v, P.w);
    ctx.strokeStyle = "#1f2733"; ctx.lineWidth = 1;
    for (const tk of xt) {
      const x = Math.round(xPx(P, tk.t, v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, P.price.top); ctx.lineTo(x, P.price.top + P.price.h); ctx.moveTo(x, P.bps.top); ctx.lineTo(x, P.bps.top + P.bps.h); ctx.stroke();
    }
    ctx.fillStyle = "#8b98a9"; ctx.textAlign = "center";
    for (const tk of xt) ctx.fillText(tk.label, xPx(P, tk.t, v), H - M.b / 2);

    // ---- price pane ----
    const yt = valueTicks(v.y0, v.y1, P.price.h);
    ctx.textAlign = "right";
    for (const tk of yt) {
      const y = Math.round(yPx(P.price, tk.y, v.y0, v.y1)) + 0.5;
      ctx.strokeStyle = "#1f2733"; ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + P.w, y); ctx.stroke();
      ctx.fillStyle = "#8b98a9"; ctx.fillText(tk.label, P.left - 6, y);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(P.left, P.price.top, P.w, P.price.h); ctx.clip();
    // The gate first of all: where an open would have gone through, as a
    // band across the whole pane, under the quotes and the markers.
    paintGate(P, P.price, v, w.dev);
    // Conditions next, so every quote line and marker sits on top of them:
    // they are background, not something to read a price off.
    for (const c of w.conditions ?? []) {
      if (c.t < v.x0 || c.t > v.x1) continue;
      const [color, label] = CONDITION[c.kind];
      const x = xPx(P, c.t, v);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, P.price.top); ctx.lineTo(x, P.price.top + P.price.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.font = "10px ui-monospace, monospace";
      ctx.save();
      ctx.translate(x + 3, P.price.top + 4);
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      const ms = c.details?.hold_ms;
      ctx.fillText(Number.isFinite(ms) ? `${label} ${Math.round(ms / 100) / 10}s` : label, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    for (const l of w.lines) {
      if (state.hidden.has(l.id) || !l.t.length) continue;
      let i0 = lowerBound(l.t, v.x0); if (i0 > 0) i0--;
      const i1 = Math.min(l.t.length - 1, lowerBound(l.t, v.x1));
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width; ctx.setLineDash(l.dash ?? []);
      ctx.beginPath();
      let px = xPx(P, l.t[i0], v), py = yPx(P.price, l.v[i0], v.y0, v.y1);
      ctx.moveTo(px, py);
      for (let i = i0 + 1; i <= i1; i++) {
        const nx = xPx(P, l.t[i], v), ny = yPx(P.price, l.v[i], v.y0, v.y1);
        // step: hold the old value to the new time, then jump
        if (nx - px >= 0.5 || Math.abs(ny - py) >= 0.5) { ctx.lineTo(nx, py); ctx.lineTo(nx, ny); px = nx; py = ny; }
      }
      ctx.lineTo(P.left + P.w, py);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const ringed = [];
    for (const m of w.marks) {
      if (state.hidden.has(m.id)) continue;
      for (const p of m.pts) {
        if (p.t < v.x0 || p.t > v.x1) continue;
        drawSymbol(ctx, m.symbol, xPx(P, p.t, v), yPx(P.price, p.y, v.y0, v.y1), m.size, m.color, m.solid);
        if (state.hoverCloid && p.cloid === state.hoverCloid) ringed.push({ p, size: m.size, own: p.id === state.hoverEvent });
      }
    }
    // The slope at each exit IOC, as a tangent through the marker: the
    // bot's recorded read when the order carries one, else this page's
    // series at that instant. Green when the mid was running the close's
    // way (up for a closing sell, down for a closing buy), red against.
    if (w.slope && !state.hidden.has("slope:tangent")) {
      const halfMs = (v.x1 - v.x0) * 0.08;
      for (const m of w.marks) {
        if (state.hidden.has(m.id)) continue;
        for (const p of m.pts) {
          if (!String(p.k).startsWith("cross:") || p.t < v.x0 || p.t > v.x1) continue;
          const bps = slopeAt(w.slope, p);
          if (bps == null) continue;
          const favour = p.side === "sell" ? bps > 0 : bps < 0;
          const dy = (bps / 10000) * p.y * (halfMs / 1000); // price over halfMs
          ctx.strokeStyle = favour ? GREEN : RED; ctx.lineWidth = 1.6; ctx.setLineDash(p.slope ? [] : [4, 3]);
          ctx.beginPath();
          ctx.moveTo(xPx(P, p.t - halfMs, v), yPx(P.price, p.y - dy, v.y0, v.y1));
          ctx.lineTo(xPx(P, p.t + halfMs, v), yPx(P.price, p.y + dy, v.y0, v.y1));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = favour ? GREEN : RED; ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
          ctx.fillText(`${bps >= 0 ? "+" : ""}${bps.toFixed(1)} bps/s${p.slope?.verdict && p.slope.verdict !== "none" ? " " + p.slope.verdict : ""}`, xPx(P, p.t + halfMs, v) + 3, yPx(P.price, p.y + dy, v.y0, v.y1));
          ctx.textBaseline = "middle";
        }
      }
    }
    // After the symbols, so a ring is never drawn over.
    if (ringed.length) {
      for (const { p, size, own } of ringed) {
        // The order's other events ring amber; the hovered row's own event
        // rings in its own colour and heavier, so the eye finds it first.
        ctx.strokeStyle = own ? "#ff7b72" : "#d29922";
        ctx.lineWidth = own ? 2.5 : 1.2;
        ctx.beginPath();
        ctx.arc(xPx(P, p.t, v), yPx(P.price, p.y, v.y0, v.y1), size + (own ? 6 : 4), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const marked = state.pinned ?? state.hoverPt;
    if (marked) {
      ctx.strokeStyle = state.pinned ? "#58a6ff" : "#dde4ec";
      ctx.lineWidth = state.pinned ? 2 : 1.2;
      ctx.beginPath(); ctx.arc(xPx(P, marked.t, v), yPx(P.price, marked.y, v.y0, v.y1), marked.size + 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    ctx.save(); ctx.translate(14, P.price.top + P.price.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = "#8b98a9"; ctx.fillText(w.inst, 0, 0); ctx.restore();

    // ---- bps pane: autoscaled to what is visible ----
    let blo = -1, bhi = 1;
    const d = w.dev;
    if (d.t.length) {
      let i0 = lowerBound(d.t, v.x0); if (i0 > 0) i0--;
      const i1 = Math.min(d.t.length - 1, lowerBound(d.t, v.x1));
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) { if (d.v[i] < lo) lo = d.v[i]; if (d.v[i] > hi) hi = d.v[i]; }
      if (w.threshold != null) { lo = Math.min(lo, -w.threshold); hi = Math.max(hi, w.threshold); }
      const im = w.impulse;
      if (im && im.t.length && !state.hidden.has("leader:impulse")) {
        let j0 = lowerBound(im.t, v.x0); if (j0 > 0) j0--;
        const j1 = Math.min(im.t.length - 1, lowerBound(im.t, v.x1));
        for (let i = j0; i <= j1; i++) { if (im.v[i] < lo) lo = im.v[i]; if (im.v[i] > hi) hi = im.v[i]; }
        if (im.min > 0) { lo = Math.min(lo, -im.min); hi = Math.max(hi, im.min); }
      }
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
      if (Number.isFinite(lo) && hi > lo) { const pad = (hi - lo) * 0.08; blo = lo - pad; bhi = hi + pad; }
    }
    const bt = valueTicks(blo, bhi, P.bps.h, 28);
    ctx.textAlign = "right";
    for (const tk of bt) {
      const y = Math.round(yPx(P.bps, tk.y, blo, bhi)) + 0.5;
      ctx.strokeStyle = tk.y === 0 ? "#3a4656" : "#1f2733"; ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + P.w, y); ctx.stroke();
      ctx.fillStyle = "#8b98a9"; ctx.fillText(tk.label, P.left - 6, y);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(P.left, P.bps.top, P.w, P.bps.h); ctx.clip();
    paintGate(P, P.bps, v, w.dev);
    if (w.threshold != null) {
      ctx.strokeStyle = "#8b98a9"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      for (const s of [w.threshold, -w.threshold]) { const y = yPx(P.bps, s, blo, bhi); ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + P.w, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (d.t.length) {
      let i0 = lowerBound(d.t, v.x0); if (i0 > 0) i0--;
      const i1 = Math.min(d.t.length - 1, lowerBound(d.t, v.x1));
      ctx.strokeStyle = "#c9d1d9"; ctx.lineWidth = 1.2; ctx.beginPath();
      let py = yPx(P.bps, d.v[i0], blo, bhi);
      ctx.moveTo(xPx(P, d.t[i0], v), py);
      for (let i = i0 + 1; i <= i1; i++) { const x = xPx(P, d.t[i], v); ctx.lineTo(x, py); py = yPx(P.bps, d.v[i], blo, bhi); ctx.lineTo(x, py); }
      ctx.lineTo(P.left + P.w, py);
      ctx.stroke();
    }
    // The leader's impulse on the same bps axis as the deviation, with the
    // gate's threshold dashed either side of zero: an open needed the
    // impulse past the dashed line on the deviation's side.
    const im = w.impulse;
    if (im && im.t.length && !state.hidden.has("leader:impulse")) {
      if (im.min > 0) {
        ctx.strokeStyle = IMPULSE_COLOR; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.7;
        for (const s of [im.min, -im.min]) { const y = yPx(P.bps, s, blo, bhi); ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + P.w, y); ctx.stroke(); }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      let i0 = lowerBound(im.t, v.x0); if (i0 > 0) i0--;
      const i1 = Math.min(im.t.length - 1, lowerBound(im.t, v.x1));
      ctx.strokeStyle = IMPULSE_COLOR; ctx.lineWidth = 1.2; ctx.beginPath();
      // Spikes, not steps: the impulse is a reading AT each quote, and what
      // it does between quotes is decay, which the line does not pretend to
      // draw.
      for (let i = i0; i <= i1; i++) { const x = xPx(P, im.t[i], v); ctx.moveTo(x, yPx(P.bps, 0, blo, bhi)); ctx.lineTo(x, yPx(P.bps, im.v[i], blo, bhi)); }
      ctx.stroke();
    }
    // The lagger's slope on its own (right-hand) axis, autoscaled to what is
    // visible and always including zero, so the sign reads at a glance.
    let slopeAxis = null;
    const sl = w.slope;
    if (sl && sl.t.length && !state.hidden.has("slope:line")) {
      let i0 = lowerBound(sl.t, v.x0); if (i0 > 0) i0--;
      const i1 = Math.min(sl.t.length - 1, lowerBound(sl.t, v.x1));
      let lo = 0, hi = 0;
      for (let i = i0; i <= i1; i++) { if (sl.v[i] < lo) lo = sl.v[i]; if (sl.v[i] > hi) hi = sl.v[i]; }
      if (hi <= lo) { lo = -1; hi = 1; }
      const pad = (hi - lo) * 0.08;
      slopeAxis = { lo: lo - pad, hi: hi + pad };
      ctx.strokeStyle = SLOPE_COLOR; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9; ctx.beginPath();
      let py = yPx(P.bps, sl.v[i0], slopeAxis.lo, slopeAxis.hi);
      ctx.moveTo(xPx(P, sl.t[i0], v), py);
      for (let i = i0 + 1; i <= i1; i++) { const x = xPx(P, sl.t[i], v); ctx.lineTo(x, py); py = yPx(P.bps, sl.v[i], slopeAxis.lo, slopeAxis.hi); ctx.lineTo(x, py); }
      ctx.lineTo(P.left + P.w, py);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (slopeAxis) {
      // Right-axis ticks for the slope, in the slope's colour.
      ctx.textAlign = "left"; ctx.fillStyle = SLOPE_COLOR;
      for (const tk of valueTicks(slopeAxis.lo, slopeAxis.hi, P.bps.h, 28)) {
        const y = Math.round(yPx(P.bps, tk.y, slopeAxis.lo, slopeAxis.hi)) + 0.5;
        ctx.fillText(tk.label, P.left + P.w + 4, y);
      }
    }
    ctx.save(); ctx.translate(14, P.bps.top + P.bps.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = "#8b98a9";
    ctx.fillText(`${w.dev.basis ? "deviation (leader over lagger, less basis)" : "leader over lagger"}, bps${w.threshold != null ? ` (dashed: threshold ${w.threshold.toFixed(1)})` : ""}`, 0, 0); ctx.restore();

    // ---- rubber band ----
    if (state.drag && state.drag.moved) {
      const dg = state.drag;
      ctx.strokeStyle = "#58a6ff"; ctx.fillStyle = "rgba(88,166,255,0.12)"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      const x = Math.min(dg.x0, dg.x), y = Math.min(dg.y0, dg.y), bw = Math.abs(dg.x - dg.x0), bh = Math.abs(dg.y - dg.y0);
      ctx.fillRect(x, y, bw, bh); ctx.strokeRect(x + 0.5, y + 0.5, bw, bh); ctx.setLineDash([]);
    }
  }

  // ---- interaction ----
  const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const inPrice = (P, y) => y >= P.price.top && y <= P.price.top + P.price.h;

  /** The marker within a dozen pixels of `p`, or null. */
  function nearestMark(p) {
    if (!state.win || !state.view) return null;
    const P = panes(), v = state.view;
    if (!inPrice(P, p.y)) return null;
    let best = null, bd = 12 * 12;
    for (const m of state.win.marks) {
      if (state.hidden.has(m.id)) continue;
      for (const pt of m.pts) {
        if (pt.t < v.x0 || pt.t > v.x1) continue;
        const dx = xPx(P, pt.t, v) - p.x, dy = yPx(P.price, pt.y, v.y0, v.y1) - p.y, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = { ...pt, size: m.size }; }
      }
    }
    return best;
  }

  /** Put the panel next to `p`. Pinned: it stays until the next click, takes
   *  the pointer (so its text can be selected) and says how to close. */
  function showTip(pt, p, pinned) {
    tip.innerHTML = pt.text + (pinned ? `<div class="tip-hint">click anywhere on the plot to close</div>` : "");
    tip.hidden = false;
    tip.classList.toggle("pinned", !!pinned);
    const tx = Math.min(p.x + 14, W - tip.offsetWidth - 8), ty = Math.min(p.y + 14, H - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(0, tx)}px`;
    tip.style.top = `${Math.max(0, ty)}px`;
  }

  cv.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || !state.view) return;
    const p = pos(ev);
    state.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false };
    ev.preventDefault();
  });
  window.addEventListener("mousemove", (ev) => {
    if (!state.view) return;
    const p = pos(ev);
    if (state.drag) {
      state.drag.x = p.x; state.drag.y = p.y;
      if (Math.abs(p.x - state.drag.x0) > 4 || Math.abs(p.y - state.drag.y0) > 4) state.drag.moved = true;
      requestDraw();
      return;
    }
    const P = panes(), v = state.view;
    if (ev.target !== cv) { if (state.hoverPt) { state.hoverPt = null; if (!state.pinned) tip.hidden = true; requestDraw(); } return; }
    // A pinned panel is the one being read: hovering does not replace it.
    if (!state.pinned) {
      const best = nearestMark(p);
      if (best) showTip(best, p, false); else tip.hidden = true;
      if ((best?.t !== state.hoverPt?.t) || (best?.y !== state.hoverPt?.y)) { state.hoverPt = best; requestDraw(); }
    }
    if (p.x >= P.left && p.x <= P.left + P.w) {
      const t = pxX(P, p.x, v);
      $("cursor").textContent = inPrice(P, p.y) ? `${fmtMs(t)}  ${pxY(P.price, p.y, v.y0, v.y1).toPrecision(6)}` : fmtMs(t);
    }
  });
  window.addEventListener("mouseup", (ev) => {
    const dg = state.drag;
    if (!dg) return;
    state.drag = null;
    if (!dg.moved) {
      // A click pins the marker under it, or closes whatever is pinned.
      const p = pos(ev);
      const hit = nearestMark(p);
      state.pinned = hit;
      if (hit) showTip(hit, p, true);
      else { tip.hidden = true; tip.classList.remove("pinned"); }
      requestDraw();
      return;
    }
    const P = panes(), v = state.view;
    const xa = Math.min(dg.x0, dg.x), xb = Math.max(dg.x0, dg.x);
    const nv = { ...v, x0: pxX(P, xa, v), x1: pxX(P, xb, v) };
    if (inPrice(P, dg.y0) && inPrice(P, dg.y)) {
      const ya = Math.min(dg.y0, dg.y), yb = Math.max(dg.y0, dg.y);
      nv.y1 = pxY(P.price, ya, v.y0, v.y1); nv.y0 = pxY(P.price, yb, v.y0, v.y1);
    }
    if (nv.x1 - nv.x0 >= 5 && nv.y1 > nv.y0) state.view = nv;
    requestDraw();
  });
  cv.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    state.drag = null;
    if (state.win) { state.view = { ...state.win.full }; requestDraw(); }
  });
  // Trackpad: two fingers pan (the content follows the fingers), pinch or
  // ctrl/cmd + wheel zooms around the cursor. The bps pane follows the time axis.
  cv.addEventListener("wheel", (ev) => {
    if (!state.view) return;
    ev.preventDefault();
    const P = panes(), v = state.view, p = pos(ev);
    const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? H : 1;
    const dx = ev.deltaX * scale, dy = ev.deltaY * scale;
    if (ev.ctrlKey || ev.metaKey) {
      const f = Math.exp(dy * 0.01);
      const fx = Math.min(1, Math.max(0, (p.x - P.left) / P.w));
      const cx = v.x0 + fx * (v.x1 - v.x0);
      const nv = { x0: cx - (cx - v.x0) * f, x1: cx + (v.x1 - cx) * f, y0: v.y0, y1: v.y1 };
      if (inPrice(P, p.y)) {
        const cy = pxY(P.price, p.y, v.y0, v.y1);
        nv.y0 = cy - (cy - v.y0) * f; nv.y1 = cy + (v.y1 - cy) * f;
      }
      if (nv.x1 - nv.x0 >= 5) state.view = nv;
    } else {
      const kx = (v.x1 - v.x0) / P.w, ky = (v.y1 - v.y0) / P.price.h;
      state.view = { x0: v.x0 + dx * kx, x1: v.x1 + dx * kx, y0: v.y0 - dy * ky, y1: v.y1 - dy * ky };
    }
    requestDraw();
  }, { passive: false });
  cv.addEventListener("mouseleave", () => {
    if (!state.pinned) tip.hidden = true;
    if (state.hoverPt) { state.hoverPt = null; requestDraw(); }
  });

  // ---- the splitter between the order list and the plot ----
  (() => {
    const split = $("split"), body = document.querySelector(".body");
    const KEY = "plotter:side-w";
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) body.style.setProperty("--side-w", `${saved}px`);
    } catch { /* private mode */ }
    let dragging = false;
    split.addEventListener("mousedown", (ev) => { dragging = true; split.classList.add("on"); ev.preventDefault(); });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const w = Math.round(Math.max(220, Math.min(ev.clientX - body.getBoundingClientRect().left, window.innerWidth - 320)));
      body.style.setProperty("--side-w", `${w}px`);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; split.classList.remove("on");
      try { localStorage.setItem(KEY, String(parseInt(body.style.getPropertyValue("--side-w"), 10) || 420)); } catch { /* private mode */ }
    });
  })();

  // ---- wiring ----
  $("bot").onchange = async () => { fillInstruments(); await loadEvents(); jumpLatest(); };
  $("instrument").onchange = async () => { await loadEvents(); jumpLatest(); };
  $("mode").onchange = async () => { fillInstruments(); await loadEvents(); jumpLatest(); };
  $("search").oninput = async () => {
    const before = $("instrument").value;
    fillInstruments();
    if ($("instrument").value !== before) { await loadEvents(); jumpLatest(); }
  };
  $("span").onchange = () => void load();
  // A derived line only: rebuild from the window already fetched, and keep
  // the zoom -- changing the half-life is looking harder at the same place.
  const rebuildDerived = () => {
    if (!state.raw) return;
    const view = state.view;
    state.win = build(state.raw.w, state.raw.from, state.raw.to, state.raw.inst);
    state.view = view;
    renderLegend();
    requestDraw();
  };
  $("ema").onchange = rebuildDerived;
  $("slopefast").onchange = rebuildDerived;
  $("slopeslow").onchange = rebuildDerived;
  $("slopesrc").onchange = rebuildDerived;
  $("impulsehl").onchange = rebuildDerived;
  $("impulsemin").onchange = rebuildDerived;
  $("impulsefrac").onchange = rebuildDerived;
  $("basishl").onchange = rebuildDerived;
  $("centre").onchange = () => { const t = parseCentre($("centre").value); if (t != null) { state.selected = null; setCentre(t); } };
  // An explicit range shifts by half ITS length and stays explicit; the
  // centre + window pair keeps its old behaviour.
  const shift = (dir) => {
    const range = customRange();
    if (!range) {
      setCentre(state.centreMs + (dir * Number($("span").value)) / 2);
      return;
    }
    const by = dir * ((range.to - range.from) / 2);
    $("from").value = fmt(range.from + by);
    $("to").value = fmt(range.to + by);
    void load();
  };
  $("prev").onclick = () => shift(-1);
  $("next").onclick = () => shift(1);
  for (const id of ["from", "to"]) {
    $(id).onchange = () => {
      const a = parseCentre($("from").value), b = parseCentre($("to").value);
      const both = $("from").value.trim() && $("to").value.trim();
      if (both && (a == null || b == null)) { status("range: use YYYY-MM-DD HH:MM:SS.mmm", true); return; }
      if (both && b <= a) { status("range: `to` must be after `from`", true); return; }
      void load();
    };
  }
  $("latest").onclick = jumpLatest;
  // Reload means "ask the databases again": the remembered windows go too.
  $("reload").onclick = async () => { windowCache.clear(); await loadKeys(); await loadEvents(); void load(); };
  function jumpLatest() {
    const e = state.events[0];
    if (e) { state.selected = e.cloid; state.selectedEvent = e.id; setCentre(e.t); }
    else { status("no events for this key"); state.win = null; state.view = null; $("legend").innerHTML = ""; requestDraw(); }
  }
  (async () => {
    try {
      resize();
      await loadKeys();
      await loadEvents();
      jumpLatest();
    } catch (e) {
      status(e.message, true);
    }
  })();
})();
