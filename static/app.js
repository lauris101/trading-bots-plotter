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
    drag: null, hoverPt: null, pinned: null, hoverCloid: null, raf: 0,
    firstFill: true,
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

  async function api(path) {
    const r = await fetch(path);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
    return body;
  }

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

  // ---- orders of the key ----
  async function loadOrders() {
    const bot = $("bot").value, inst = $("instrument").value, mode = $("mode").value;
    if (!bot || !inst) { $("orders").querySelector("tbody").innerHTML = ""; state.orders = []; return; }
    const { orders } = await api(`/api/orders?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&limit=300`);
    state.orders = orders;
    const tb = $("orders").querySelector("tbody");
    tb.innerHTML = orders.map((o) => `
      <tr class="o${state.selected === o.cloid ? " sel" : ""}" data-cloid="${esc(o.cloid)}" data-t="${Date.parse(o.sent_at)}">
        <td class="mono">${fmt(Date.parse(o.sent_at)).slice(5, 23)}</td>
        <td class="mono cloid" title="${esc(o.cloid)} (click to copy)">${esc(shortCloid(o.cloid))}</td>
        <td class="${esc(o.side)}">${esc(o.side)}</td>
        <td>${esc(o.exec)}${o.reduce_only ? " ro" : ""}${o.priority ? ` p${o.priority}` : ""}</td>
        <td>${esc(o.reason)}</td>
        <td class="mono">${esc(o.px)}</td>
        <td class="mono">${esc(o.sz)}</td>
        <td><span class="b b-${esc(o.status)}" title="${esc(o.error)}">${esc(o.status)}</span></td>
        <td class="mono">${Number(o.filled_sz) ? `${esc(o.filled_sz)}${o.avg_px ? " @ " + esc(o.avg_px) : ""}` : ""}</td>
      </tr>`).join("");
    for (const tr of tb.querySelectorAll("tr.o")) {
      tr.onclick = () => { state.selected = tr.dataset.cloid; setCentre(Number(tr.dataset.t)); };
      // Hovering the row rings every point the order left on the plot: the
      // insert, its fills, an amend, the cancel. One order is usually
      // several marks scattered across the window.
      tr.onmouseenter = () => { state.hoverCloid = tr.dataset.cloid; requestDraw(); };
      tr.onmouseleave = () => { if (state.hoverCloid === tr.dataset.cloid) { state.hoverCloid = null; requestDraw(); } };
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
    for (const tr of $("orders").querySelectorAll("tr.o")) tr.classList.toggle("sel", tr.dataset.cloid === state.selected);
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
      const what = !e.reduce_only ? "open" : e.exec === "alo" ? "rung" : "cross";
      return `${what}:${filled(e) ? "filled" : "unfilled"}`;
    }
    // A resting or filled ack repeats what the insert and the fills already
    // show; a rejection or an unknown is the whole story of that order.
    // An amend is a request: the answer that followed it on the same cloid
    // says whether the order actually moved (see `pairAmends`). A refused
    // one is drawn hollow at the price it did NOT reach.
    if (e.kind === "amend") return e.amend_ok === false ? "amend:refused" : "amend:ok";
    if (e.kind === "acked") return e.status === "rejected" || e.status === "unknown" ? `acked:${e.status}` : null;
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
  const hover = (e) => {
    const lines = [
      `<b>${esc(KIND[keyOf(e)]?.[3] ?? `${e.kind}${e.status ? ": " + e.status : ""}`)}</b>  ${fmtMs(e.t)} UTC`,
      `${esc(e.side)} ${esc(e.exec)}${e.reduce_only ? " reduce-only" : ""}  reason ${esc(e.reason)}${e.priority ? `  p${e.priority}` : ""}`,
      `order px ${esc(e.order_px)}  sz ${esc(e.order_sz)}  ->  ${esc(e.order_status)}${Number(e.order_filled) ? ` ${esc(e.order_filled)} @ ${esc(e.order_avg_px)}` : ""}`,
    ];
    if (e.kind === "amend") {
      lines.push(
        e.amend_ok === false
          ? `<span style="color:#f85149">REFUSED: it did not move to ${esc(e.px)}</span>`
          : e.amend_ok
            ? `moved to ${esc(e.px)}  sz ${esc(e.sz)}`
            : `re-price to ${esc(e.px)} requested (no answer yet in this window)`,
      );
      if (e.amend_error) lines.push(`<span style="color:#f85149">${esc(e.amend_error)}</span>`);
    }
    if (e.kind === "fill") lines.push(`fill px ${esc(e.px)} sz ${esc(e.sz)}${e.fee ? ` fee ${esc(e.fee)}` : ""}${e.closed_pnl ? ` pnl ${esc(e.closed_pnl)}` : ""} (${esc(e.source)})`);
    if (e.kind === "acked" && e.status === "filled") lines.push(`filled ${esc(e.sz)} @ ${esc(e.px)}`);
    if (e.error) lines.push(`<span style="color:#f85149">${esc(e.error)}</span>`);
    lines.push(`cloid ${esc(e.cloid)}${e.batch != null ? `  batch ${e.batch}` : ""}${e.mode ? `  ${esc(e.mode)}` : ""}${e.oid ? `  oid ${esc(e.oid)}` : ""}`);
    const d = e.decision;
    if (d) {
      const f = (v, p = 1) => (typeof v === "number" ? v.toFixed(p) : "-");
      lines.push(`<b>decision</b> dev ${f(d.deviation_bps)} bps (raw ${f(d.raw_deviation_bps)}), basis ${f(d.basis_bps)}`);
      lines.push(`threshold ${f(d.threshold_bps)} bps, gain ${f(d.gain_bps)} (raw ${f(d.raw_gain_bps)}), rho ${f(d.rho, 2)}, delta ${f(d.delta_ms, 0)} ms`);
      lines.push(`leader mid ${esc(d.leader_mid)}  lagger ${esc(d.lagger_bid)} / ${esc(d.lagger_ask)}`);
      if (d.trigger) lines.push(`trigger ${esc(d.trigger)}${d.impulse_bps != null ? ` (leader moved ${f(d.impulse_bps)} bps in the window)` : ""}  quote age: leader ${f(d.leader_age_ms, 0)} ms, lagger ${f(d.lagger_age_ms, 0)} ms`);
    }
    return lines.join("<br>");
  };

  // ---- load a window and build the drawable series ----
  const VENUE = {
    binance_perps: { width: 1, color: "#3d7bd6", label: "binance" },
    binance: { width: 1, color: "#5aa0ff", label: "binance spot" },
    hyperliquid: { width: 2, color: "#e3b341", label: "hyperliquid" },
  };

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
    status(range?.clamped ? "loading (range clamped to 6 h)" : "loading");
    let w;
    try {
      w = await api(`/api/window?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&from_ms=${from}&to_ms=${to}`);
    } catch (e) {
      status(e.message, true);
      return;
    }
    state.win = build(w, from, to, inst);
    state.view = { ...state.win.full };
    state.pinned = null;
    tip.hidden = true;
    tip.classList.remove("pinned");
    renderLegend();
    const nq = state.win.lines.reduce((a, l) => a + (l.id.endsWith(":bid") ? l.t.length : 0), 0);
    status(`${nq} quotes, ${w.events.length} events, ${fmt(from).slice(11, 19)} to ${fmt(to).slice(11, 19)} UTC${w.quotes.bucketed_ms ? `, bucketed to ${w.quotes.bucketed_ms} ms` : ""}`);
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
        .pts.push({ t: e.t, y: px, text: hover(e), cloid: e.cloid });
      if (px < lo) lo = px; if (px > hi) hi = px;
    }
    const marks = Object.values(groups);
    // Deviation: leader mid over lagger mid in bps, sampled at the lagger's quotes.
    const leader = w.quotes.by_venue.binance_perps ?? w.quotes.by_venue.binance ?? [];
    const lagger = w.quotes.by_venue.hyperliquid ?? [];
    const dev = { t: [], v: [] };
    let i = 0;
    for (const q of lagger) {
      while (i + 1 < leader.length && leader[i + 1].t <= q.t) i++;
      if (!leader.length || leader[i].t > q.t) continue;
      const lm = (leader[i].bid + leader[i].ask) / 2, hm = (q.bid + q.ask) / 2;
      dev.t.push(q.t); dev.v.push(10000 * (lm / hm - 1));
    }
    const last = [...w.events].reverse().find((e) => e.decision?.threshold_bps != null);
    const threshold = last ? last.decision.threshold_bps : null;
    const pad = Number.isFinite(lo) && hi > lo ? (hi - lo) * 0.06 : Math.abs(lo || 1) * 0.001;
    const full = { x0: from, x1: to, y0: Number.isFinite(lo) ? lo - pad : 0, y1: Number.isFinite(hi) ? hi + pad : 1 };
    return { inst, lines, marks, dev, threshold, full };
  }

  // ---- legend: every line and marker group toggles on its own ----
  function renderLegend() {
    const el = $("legend");
    const items = [
      ...state.win.lines.map((l) => ({ id: l.id, name: l.name, color: l.color, kind: l.dash ? "dash" : "line" })),
      ...state.win.marks.map((m) => ({ id: m.id, name: m.name, color: m.color, kind: m.symbol, solid: m.solid })),
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
  const M = { l: 74, r: 16, t: 10, b: 30, gap: 26 };
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
        if (state.hoverCloid && p.cloid === state.hoverCloid) ringed.push({ p, size: m.size });
      }
    }
    // After the symbols, so a ring is never drawn over.
    if (ringed.length) {
      ctx.strokeStyle = "#d29922";
      ctx.lineWidth = 1.5;
      for (const { p, size } of ringed) {
        ctx.beginPath();
        ctx.arc(xPx(P, p.t, v), yPx(P.price, p.y, v.y0, v.y1), size + 4, 0, Math.PI * 2);
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
    ctx.restore();
    ctx.save(); ctx.translate(14, P.bps.top + P.bps.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = "#8b98a9";
    ctx.fillText(w.threshold != null ? `leader over lagger, bps (dashed: threshold ${w.threshold.toFixed(1)})` : "leader over lagger, bps", 0, 0); ctx.restore();

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
  $("bot").onchange = async () => { fillInstruments(); await loadOrders(); jumpLatest(); };
  $("instrument").onchange = async () => { await loadOrders(); jumpLatest(); };
  $("mode").onchange = async () => { fillInstruments(); await loadOrders(); jumpLatest(); };
  $("search").oninput = async () => {
    const before = $("instrument").value;
    fillInstruments();
    if ($("instrument").value !== before) { await loadOrders(); jumpLatest(); }
  };
  $("span").onchange = () => void load();
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
  $("reload").onclick = async () => { await loadKeys(); await loadOrders(); void load(); };
  function jumpLatest() {
    const o = state.orders[0];
    if (o) { state.selected = o.cloid; setCentre(Date.parse(o.sent_at)); }
    else { status("no orders for this key"); state.win = null; state.view = null; $("legend").innerHTML = ""; requestDraw(); }
  }
  (async () => {
    try {
      resize();
      await loadKeys();
      await loadOrders();
      jumpLatest();
    } catch (e) {
      status(e.message, true);
    }
  })();
})();
