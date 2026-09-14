// The page: pick a key, pick a moment, draw the window. Plotly with WebGL
// scatter traces (scattergl) so tens of thousands of quotes pan and zoom
// without stutter; every order event is one marker with the full record on
// hover.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { keys: [], orders: [], centreMs: null, selected: null, lastWindow: null };

  const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const fmtMs = (ms) => fmt(ms).slice(11, 23);
  const parseCentre = (s) => {
    const t = Date.parse(s.trim().replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
    return Number.isNaN(t) ? null : t;
  };
  const status = (msg, err = false) => { const el = $("status"); el.textContent = msg; el.className = err ? "err" : ""; };

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
    $("bot").innerHTML = bots.map((b) => `<option>${b}</option>`).join("");
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
    const list = [...seen.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    const prev = $("instrument").value;
    $("instrument").innerHTML = list.map((k) => `<option value="${k.instrument}">${k.instrument} (${k.orders})</option>`).join("");
    if (list.some((k) => k.instrument === prev)) $("instrument").value = prev;
  }

  // ---- orders of the key ----
  async function loadOrders() {
    const bot = $("bot").value, inst = $("instrument").value, mode = $("mode").value;
    if (!bot || !inst) { $("orders").querySelector("tbody").innerHTML = ""; return; }
    const { orders } = await api(`/api/orders?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&limit=300`);
    state.orders = orders;
    const tb = $("orders").querySelector("tbody");
    tb.innerHTML = orders.map((o) => `
      <tr class="o${state.selected === o.cloid ? " sel" : ""}" data-cloid="${o.cloid}" data-t="${Date.parse(o.sent_at)}">
        <td class="mono">${fmt(Date.parse(o.sent_at)).slice(5, 23)}</td>
        <td class="${o.side ?? ""}">${o.side ?? ""}</td>
        <td>${o.exec ?? ""}${o.reduce_only ? " ro" : ""}${o.priority ? ` p${o.priority}` : ""}</td>
        <td>${o.reason ?? ""}</td>
        <td class="mono">${o.px ?? ""}</td>
        <td class="mono">${o.sz ?? ""}</td>
        <td><span class="b b-${o.status}" title="${(o.error ?? "").replace(/"/g, "&quot;")}">${o.status}</span></td>
        <td class="mono">${Number(o.filled_sz) ? `${o.filled_sz}${o.avg_px ? " @ " + o.avg_px : ""}` : ""}</td>
      </tr>`).join("");
    for (const tr of tb.querySelectorAll("tr.o")) {
      tr.onclick = () => { state.selected = tr.dataset.cloid; setCentre(Number(tr.dataset.t)); };
    }
  }

  function setCentre(ms) {
    state.centreMs = ms;
    $("centre").value = fmt(ms);
    for (const tr of $("orders").querySelectorAll("tr.o")) tr.classList.toggle("sel", tr.dataset.cloid === state.selected);
    void draw();
  }

  // ---- the window ----
  // Every marker is coloured by side: buys green, sells red. An insert is a
  // triangle pointing right, solid when the order (partially) filled and
  // outline only when nothing filled; fills are dots; cancels and rejections
  // are crosses. Acks that merely confirm a resting or filled state draw
  // nothing of their own: the insert's marker already carries the outcome.
  const GREEN = "#3fb950", RED = "#f85149", OTHER = "#c9d1d9";
  const sideColor = (e) => (e.side === "buy" ? GREEN : e.side === "sell" ? RED : OTHER);
  const filled = (e) => e.order_status === "filled" || Number(e.order_filled) > 0;
  // kind key -> [symbol, size, label]
  const KIND = {
    "sent:filled": ["triangle-right", 13, "insert, filled"],
    "sent:unfilled": ["triangle-right-open", 13, "insert, not filled"],
    "acked:rejected": ["circle-x-open", 15, "REJECTED"],
    "acked:unknown": ["diamond-open", 12, "acked: unknown"],
    "fill": ["circle", 10, "fill"],
    "cancel_sent": ["x-open", 11, "cancel sent"],
    "cancelled:ok": ["x", 11, "cancelled"],
    "cancelled:failed": ["circle-x", 15, "cancel FAILED"],
    "left_resting": ["hexagon-open", 12, "left resting"],
  };
  const keyOf = (e) => {
    if (e.kind === "sent") return filled(e) ? "sent:filled" : "sent:unfilled";
    if (e.kind === "acked") return e.status === "rejected" || e.status === "unknown" ? `acked:${e.status}` : null;
    if (e.kind === "cancelled") return `cancelled:${e.status ?? "ok"}`;
    return KIND[e.kind] ? e.kind : null;
  };
  const priceOf = (e) => {
    const n = (v) => (v == null || v === "" ? null : Number(v));
    if (e.kind === "fill") return n(e.px);
    if (e.kind === "acked" && e.status === "filled") return n(e.px) ?? n(e.order_avg_px) ?? n(e.order_px);
    return n(e.order_px) ?? n(e.px);
  };
  const hover = (e) => {
    const lines = [
      `<b>${KIND[keyOf(e)]?.[2] ?? `${e.kind}${e.status ? ": " + e.status : ""}`}</b>  ${fmtMs(e.t)} UTC`,
      `${e.side ?? ""} ${e.exec ?? ""}${e.reduce_only ? " reduce-only" : ""}  reason ${e.reason ?? ""}${e.priority ? `  p${e.priority}` : ""}`,
      `order px ${e.order_px ?? ""}  sz ${e.order_sz ?? ""}  ->  ${e.order_status}${Number(e.order_filled) ? ` ${e.order_filled} @ ${e.order_avg_px}` : ""}`,
    ];
    if (e.kind === "fill") lines.push(`fill px ${e.px} sz ${e.sz}${e.fee ? ` fee ${e.fee}` : ""}${e.closed_pnl ? ` pnl ${e.closed_pnl}` : ""} (${e.source})`);
    if (e.kind === "acked" && e.status === "filled") lines.push(`filled ${e.sz} @ ${e.px}`);
    if (e.error) lines.push(`<span style="color:#f85149">${e.error}</span>`);
    if (e.batch != null) lines.push(`batch ${e.batch}  ${e.mode}  ${e.cloid.slice(0, 10)}..`);
    const d = e.decision;
    if (d) {
      lines.push(`<b>decision</b> dev ${d.deviation_bps?.toFixed?.(1)} bps (raw ${d.raw_deviation_bps?.toFixed?.(1)}), basis ${d.basis_bps == null ? "-" : d.basis_bps.toFixed(1)}`);
      lines.push(`threshold ${d.threshold_bps?.toFixed?.(1)} bps, gain ${d.gain_bps?.toFixed?.(1)} (raw ${d.raw_gain_bps?.toFixed?.(1)}), rho ${d.rho?.toFixed?.(2)}, delta ${d.delta_ms?.toFixed?.(0)} ms`);
      lines.push(`leader mid ${d.leader_mid}  lagger ${d.lagger_bid} / ${d.lagger_ask}`);
    }
    return lines.join("<br>");
  };

  async function draw() {
    const bot = $("bot").value, inst = $("instrument").value, mode = $("mode").value;
    if (!bot || !inst || state.centreMs == null) return;
    const span = Number($("span").value);
    const from = state.centreMs - span / 2, to = state.centreMs + span / 2;
    status("loading");
    let w;
    try {
      w = await api(`/api/window?bot=${encodeURIComponent(bot)}&instrument=${encodeURIComponent(inst)}&mode=${mode}&from_ms=${Math.floor(from)}&to_ms=${Math.ceil(to)}`);
    } catch (e) {
      status(e.message, true);
      return;
    }
    state.lastWindow = w;
    const traces = [];
    const venues = Object.keys(w.quotes.by_venue).sort();
    const styles = {
      binance_perps: { w: 1, bid: "#3d7bd6", ask: "#3d7bd6" },
      binance: { w: 1, bid: "#5aa0ff", ask: "#5aa0ff" },
      hyperliquid: { w: 2.2, bid: "#e3b341", ask: "#e3b341" },
    };
    for (const v of venues) {
      const rows = w.quotes.by_venue[v];
      const st = styles[v] ?? { w: 1.5, bid: "#aaa", ask: "#aaa" };
      const x = rows.map((r) => new Date(r.t));
      traces.push({ type: "scattergl", mode: "lines", name: `${v} bid`, x, y: rows.map((r) => r.bid), line: { shape: "hv", width: st.w, color: st.bid }, hoverinfo: "skip", legendgroup: v });
      traces.push({ type: "scattergl", mode: "lines", name: `${v} ask`, x, y: rows.map((r) => r.ask), line: { shape: "hv", width: st.w, color: st.ask, dash: "dot" }, hoverinfo: "skip", legendgroup: v });
    }
    // Events: one trace per kind and side so the legend can toggle them.
    const groups = {};
    for (const e of w.events) {
      const k = keyOf(e);
      if (!k) continue;
      const px = priceOf(e);
      if (px == null || !Number.isFinite(px)) continue;
      const g = `${e.side ?? "none"}|${k}`;
      (groups[g] ??= { k, side: e.side, color: sideColor(e), pts: [] }).pts.push({ x: new Date(e.t), y: px, text: hover(e) });
    }
    for (const g of Object.values(groups)) {
      const [symbol, size, label] = KIND[g.k];
      traces.push({
        type: "scattergl", mode: "markers", name: `${g.side ?? ""} ${label}`.trim(),
        x: g.pts.map((p) => p.x), y: g.pts.map((p) => p.y),
        text: g.pts.map((p) => p.text), hovertemplate: "%{text}<extra></extra>",
        marker: { symbol, color: g.color, size, line: { width: 1.6, color: g.color } },
      });
    }
    // Deviation pane: leader mid over lagger mid in bps, sampled at the lagger's quotes.
    const leader = w.quotes.by_venue.binance_perps ?? w.quotes.by_venue.binance ?? [];
    const lagger = w.quotes.by_venue.hyperliquid ?? [];
    if (leader.length && lagger.length) {
      const xs = [], ys = [];
      let i = 0;
      for (const q of lagger) {
        while (i + 1 < leader.length && leader[i + 1].t <= q.t) i++;
        if (leader[i].t > q.t) continue;
        const lm = (leader[i].bid + leader[i].ask) / 2, hm = (q.bid + q.ask) / 2;
        xs.push(new Date(q.t)); ys.push(10000 * (lm / hm - 1));
      }
      traces.push({ type: "scattergl", mode: "lines", name: "leader over lagger, bps", x: xs, y: ys, line: { width: 1.2, color: "#c9d1d9", shape: "hv" }, yaxis: "y2", hovertemplate: "%{y:.1f} bps<extra></extra>" });
      const last = [...w.events].reverse().find((e) => e.decision?.threshold_bps != null);
      if (last) {
        const th = last.decision.threshold_bps;
        for (const s of [th, -th]) traces.push({ type: "scattergl", mode: "lines", name: `threshold ${th.toFixed(1)} bps`, x: [new Date(from), new Date(to)], y: [s, s], line: { width: 1, dash: "dash", color: "#8b98a9" }, yaxis: "y2", hoverinfo: "skip", showlegend: s > 0 });
      }
    }
    const layout = {
      paper_bgcolor: "#0b0e13", plot_bgcolor: "#0f141b", font: { color: "#dde4ec", size: 11 },
      margin: { l: 70, r: 20, t: 10, b: 40 }, hovermode: "closest", dragmode: "zoom",
      legend: { orientation: "h", y: 1.02, x: 0 },
      xaxis: { type: "date", range: [new Date(from), new Date(to)], gridcolor: "#1f2733", tickformat: "%H:%M:%S.%L", hoverformat: "%H:%M:%S.%L" },
      yaxis: { title: inst, domain: [0.32, 1], gridcolor: "#1f2733", tickformat: ".6~g" },
      yaxis2: { title: "bps", domain: [0, 0.26], gridcolor: "#1f2733", zeroline: true, zerolinecolor: "#3a4656" },
      shapes: state.selected ? [] : [],
    };
    const config = { responsive: true, scrollZoom: false, displaylogo: false, doubleClick: "reset", modeBarButtonsToRemove: ["lasso2d", "select2d"] };
    await Plotly.react("plot", traces, layout, config);
    const nq = venues.reduce((a, v) => a + w.quotes.by_venue[v].length, 0);
    status(`${nq} quotes, ${w.events.length} events, ${fmt(from).slice(11, 19)} to ${fmt(to).slice(11, 19)} UTC${w.quotes.bucketed_ms ? `, bucketed to ${w.quotes.bucketed_ms} ms` : ""}`);
  }

  // ---- trackpad: two fingers pan, pinch (or ctrl/cmd + wheel) zooms ----
  // Plotly's own scroll handling only zooms, so the wheel is handled here.
  // The content follows the fingers; a pinch zooms both axes of the price
  // pane around the cursor and only the time axis of the bps pane.
  const plotEl = $("plot");
  let pending = null;
  plotEl.addEventListener("wheel", (ev) => {
    const fl = plotEl._fullLayout;
    if (!fl || !fl.xaxis || !fl.xaxis._length) return;
    ev.preventDefault();
    const xa = fl.xaxis, ya = fl.yaxis, y2 = fl.yaxis2;
    const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? fl.height : 1;
    const dx = ev.deltaX * scale, dy = ev.deltaY * scale;
    const [x0, x1] = xa.range.map(xa.r2l), [y0, y1] = ya.range.map(ya.r2l);
    const upd = {};
    if (ev.ctrlKey || ev.metaKey) {
      const f = Math.exp(dy * 0.01);
      const rect = plotEl.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (ev.clientX - rect.left - xa._offset) / xa._length));
      const fy = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top - ya._offset) / ya._length));
      const cx = x0 + fx * (x1 - x0), cy = y0 + fy * (y1 - y0);
      upd["xaxis.range"] = [xa.l2r(cx - (cx - x0) * f), xa.l2r(cx + (x1 - cx) * f)];
      upd["yaxis.range"] = [ya.l2r(cy - (cy - y0) * f), ya.l2r(cy + (y1 - cy) * f)];
    } else {
      const kx = (x1 - x0) / xa._length, ky = (y1 - y0) / ya._length;
      upd["xaxis.range"] = [xa.l2r(x0 + dx * kx), xa.l2r(x1 + dx * kx)];
      upd["yaxis.range"] = [ya.l2r(y0 - dy * ky), ya.l2r(y1 - dy * ky)];
    }
    if (y2 && y2.range) upd["yaxis2.range"] = y2.range;
    pending = upd;
    requestAnimationFrame(() => { if (pending) { const u = pending; pending = null; Plotly.relayout(plotEl, u); } });
  }, { passive: false });

  // ---- wiring ----
  $("bot").onchange = async () => { fillInstruments(); await loadOrders(); jumpLatest(); };
  $("instrument").onchange = async () => { await loadOrders(); jumpLatest(); };
  $("mode").onchange = async () => { fillInstruments(); await loadOrders(); jumpLatest(); };
  $("span").onchange = () => void draw();
  $("centre").onchange = () => { const t = parseCentre($("centre").value); if (t != null) { state.selected = null; setCentre(t); } };
  $("prev").onclick = () => setCentre(state.centreMs - Number($("span").value) / 2);
  $("next").onclick = () => setCentre(state.centreMs + Number($("span").value) / 2);
  $("latest").onclick = jumpLatest;
  $("reload").onclick = async () => { await loadKeys(); await loadOrders(); void draw(); };
  function jumpLatest() {
    const o = state.orders[0];
    if (o) { state.selected = o.cloid; setCentre(Date.parse(o.sent_at)); } else { status("no orders for this key"); Plotly.purge("plot"); }
  }
  (async () => {
    try {
      await loadKeys();
      await loadOrders();
      jumpLatest();
    } catch (e) {
      status(e.message, true);
    }
  })();
})();
