// The live page: both venues' quotes and one address's orders and fills,
// drawn as they arrive. Three sockets from the browser to the venues: the
// Binance futures book ticker for the leader, Hyperliquid's bbo for the
// lagger, and Hyperliquid's orderUpdates + userFills for the address. The
// server only supplies the choices (addresses, symbols) from control.
(() => {
  const $ = (id) => document.getElementById(id);
  const BINANCE_WS = "wss://fstream.binance.com/ws/";
  const HL_WS = "wss://api.hyperliquid.xyz/ws";
  const LEADER = "#58a6ff", LAGGER = "#dde4ec", GREEN = "#3fb950", RED = "#f85149", AMBER = "#d29922", MUTED = "#8b98a9", LINE = "#273140";

  const state = {
    setup: null,
    instrument: null, // {canonical, binance, hl}
    address: "",
    leader: [], // {t, bid, ask}
    lagger: [],
    orders: new Map(), // oid -> {oid, cloid, side, px, sz, origSz, status, t, coin}
    fills: [], // {t, side, px, sz, fee, pnl, oid, cloid, crossed}
    sockets: { binance: null, hlbbo: null, hluser: null },
    timers: [],
    raf: 0,
    hover: null,
  };

  const status = (msg, bad = false) => { const el = $("status"); el.textContent = msg; el.className = bad ? "meta bad" : "meta"; };
  const pill = (id, on) => { const el = $(id); el.className = `pill ${on === null ? "" : on ? "on" : "off"}`; };
  const fmtT = (ms) => new Date(ms).toISOString().slice(11, 23);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const spanMs = () => Number($("span").value);

  // ---- choices ----
  async function loadSetup() {
    const r = await fetch("/api/live/setup");
    if (!r.ok) { status(`setup: ${(await r.text()).slice(0, 200)}`, true); return; }
    state.setup = await r.json();
    const seen = new Set();
    $("address").innerHTML = state.setup.accounts
      .filter((a) => (seen.has(a.address) ? false : (seen.add(a.address), true)))
      .map((a) => `<option value="${esc(a.address)}">${esc(a.bot)} ${esc(a.label)} ${esc(a.address.slice(0, 8))}..${esc(a.address.slice(-4))}</option>`)
      .join("");
    const list = [...state.setup.instruments].sort((a, b) => a.canonical.localeCompare(b.canonical));
    $("instrument").innerHTML = list.map((i) => `<option value="${esc(i.canonical)}">${esc(i.canonical)} (${esc(i.binance)} / ${esc(i.hl)})</option>`).join("");
    // Open on the address with a strategy and an instrument of a subaccount
    // strategy when there is one: the thing most likely being watched.
    const sub = state.setup.accounts.find((a) => a.label && String(a.label).startsWith("sub") && (a.strategies ?? []).length);
    if (sub) $("address").value = sub.address;
    const q = new URLSearchParams(location.search);
    if (q.get("address")) $("address").value = q.get("address");
    if (q.get("instrument") && list.some((i) => i.canonical === q.get("instrument"))) $("instrument").value = q.get("instrument");
    start();
  }

  // ---- sockets ----
  function closeAll() {
    for (const k of Object.keys(state.sockets)) {
      const s = state.sockets[k];
      if (s) { s.onclose = null; try { s.close(); } catch { /* closing */ } }
      state.sockets[k] = null;
    }
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
  }

  function start() {
    closeAll();
    const canonical = $("instrument").value;
    state.instrument = state.setup.instruments.find((i) => i.canonical === canonical) ?? null;
    state.address = $("address").value;
    state.leader = []; state.lagger = []; state.orders = new Map(); state.fills = [];
    $("log").querySelector("tbody").innerHTML = "";
    if (!state.instrument) { status("pick an instrument"); return; }
    const url = new URL(location.href);
    url.searchParams.set("address", state.address); url.searchParams.set("instrument", canonical);
    history.replaceState(null, "", url);
    status(`${canonical}: ${state.instrument.binance} on binance, ${state.instrument.hl} on hyperliquid; ${state.address}`);
    openBinance(); openHlBbo(); openHlUser();
    requestDraw();
  }

  /** Open a socket that reconnects while it is still the current one. */
  function socket(key, url, onopen, onmessage) {
    let ws;
    const connect = () => {
      pill(`s-${key}`, null);
      ws = new WebSocket(url);
      state.sockets[key] = ws;
      ws.onopen = () => { pill(`s-${key}`, true); onopen(ws); };
      ws.onmessage = (ev) => { try { onmessage(JSON.parse(ev.data)); } catch { /* not json */ } };
      ws.onerror = () => pill(`s-${key}`, false);
      ws.onclose = () => { pill(`s-${key}`, false); if (state.sockets[key] === ws) setTimeout(connect, 1500); };
    };
    connect();
  }

  function openBinance() {
    const sym = state.instrument.binance.toLowerCase();
    socket("binance", `${BINANCE_WS}${sym}@bookTicker`, () => {}, (m) => {
      if (m.e !== "bookTicker") return;
      const bid = Number(m.b), ask = Number(m.a);
      if (!(bid > 0 && ask > 0)) return;
      push(state.leader, { t: Number(m.E ?? m.T ?? Date.now()), bid, ask });
    });
  }

  function openHlBbo() {
    const coin = state.instrument.hl;
    socket("hlbbo", HL_WS, (ws) => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
      state.timers.push(setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" })); }, 30000));
    }, (m) => {
      if (m.channel !== "bbo" || !m.data || m.data.coin !== coin) return;
      const [b, a] = m.data.bbo ?? [];
      const bid = b ? Number(b.px) : NaN, ask = a ? Number(a.px) : NaN;
      if (!(bid > 0 && ask > 0)) return;
      push(state.lagger, { t: Number(m.data.time ?? Date.now()), bid, ask });
    });
  }

  function openHlUser() {
    const user = state.address, coin = state.instrument.hl;
    socket("hluser", HL_WS, (ws) => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates", user } }));
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user } }));
      state.timers.push(setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" })); }, 30000));
    }, (m) => {
      if (m.channel === "orderUpdates") {
        for (const u of m.data ?? []) {
          const o = u.order ?? {};
          if (o.coin !== coin) continue;
          const rec = {
            oid: o.oid, cloid: o.cloid ?? null, side: o.side === "B" ? "buy" : "sell", px: Number(o.limitPx), sz: Number(o.sz), origSz: Number(o.origSz),
            status: u.status, t: Number(u.statusTimestamp ?? o.timestamp ?? Date.now()), placed: Number(o.timestamp ?? Date.now()),
          };
          const prev = state.orders.get(o.oid);
          state.orders.set(o.oid, { ...(prev ?? {}), ...rec, placed: prev?.placed ?? rec.placed });
          log(rec.t, `order ${u.status}`, rec.side, rec.px, `${rec.sz}/${rec.origSz}`, rec.cloid ? rec.cloid.slice(-8) : `oid ${o.oid}`);
        }
      } else if (m.channel === "userFills") {
        const snap = m.data?.isSnapshot === true;
        for (const f of m.data?.fills ?? []) {
          if (f.coin !== coin) continue;
          const rec = { t: Number(f.time), side: f.side === "B" ? "buy" : "sell", px: Number(f.px), sz: Number(f.sz), fee: Number(f.fee), pnl: Number(f.closedPnl), oid: f.oid, cloid: f.cloid ?? null, crossed: f.crossed, dir: f.dir };
          if (state.fills.some((x) => x.oid === rec.oid && x.t === rec.t && x.px === rec.px && x.sz === rec.sz)) continue;
          state.fills.push(rec);
          if (!snap || Date.now() - rec.t < spanMs()) log(rec.t, `fill${snap ? " (earlier)" : ""}`, rec.side, rec.px, rec.sz, `${rec.dir ?? ""} fee ${rec.fee.toFixed(4)}${rec.pnl ? ` pnl ${rec.pnl.toFixed(4)}` : ""}${rec.crossed ? " taker" : " maker"}`);
        }
        state.fills.sort((a, b) => a.t - b.t);
      }
      requestDraw();
    });
  }

  function push(arr, q) {
    arr.push(q);
    const cutoff = Date.now() - Math.max(spanMs(), 1800000) - 5000;
    let n = 0;
    while (n < arr.length && arr[n].t < cutoff) n++;
    if (n > 0) arr.splice(0, n);
    requestDraw();
  }

  function log(t, what, side, px, sz, note) {
    const tb = $("log").querySelector("tbody");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="mono">${fmtT(t)}</td><td>${esc(what)}</td><td class="${side}">${esc(side)}</td><td class="mono">${esc(px)}</td><td class="mono">${esc(sz)}</td><td class="meta">${esc(note)}</td>`;
    tb.insertBefore(tr, tb.firstChild);
    while (tb.children.length > 300) tb.removeChild(tb.lastChild);
  }

  // ---- drawing ----
  const cv = $("cv"), ctx = cv.getContext("2d"), wrap = $("plotwrap");
  let W = 100, H = 100;
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
  // The clock keeps moving even when nothing arrives.
  setInterval(requestDraw, 250);

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const P = { left: 8, right: 70, top: 10, bottom: 24 };
    const w = W - P.left - P.right, h = H - P.top - P.bottom;
    const now = Date.now(), x0 = now - spanMs(), x1 = now;
    const mode = $("mode").value;
    const vis = (arr) => arr.filter((q) => q.t >= x0 - 1000);
    const L = vis(state.leader), G = vis(state.lagger);
    let lo = Infinity, hi = -Infinity;
    const take = (q) => { if (mode === "mid") { const m = (q.bid + q.ask) / 2; lo = Math.min(lo, m); hi = Math.max(hi, m); } else { lo = Math.min(lo, q.bid); hi = Math.max(hi, q.ask); } };
    L.forEach(take); G.forEach(take);
    for (const o of state.orders.values()) if (o.t >= x0 && o.px > 0) { lo = Math.min(lo, o.px); hi = Math.max(hi, o.px); }
    for (const f of state.fills) if (f.t >= x0) { lo = Math.min(lo, f.px); hi = Math.max(hi, f.px); }
    if (!(lo < hi)) { ctx.fillStyle = MUTED; ctx.font = "12px system-ui"; ctx.fillText("waiting for quotes", P.left + 10, P.top + 20); return; }
    const pad = (hi - lo) * 0.08 || lo * 0.0005;
    lo -= pad; hi += pad;
    const X = (t) => P.left + ((t - x0) / (x1 - x0)) * w;
    const Y = (p) => P.top + (1 - (p - lo) / (hi - lo)) * h;

    // grid + axes
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.fillStyle = MUTED; ctx.font = "10px ui-monospace, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const dp = Math.max(2, Math.min(7, Math.ceil(-Math.log10((hi - lo) / 6)) + 1));
    for (let i = 0; i <= 6; i++) {
      const p = lo + ((hi - lo) * i) / 6, y = Y(p);
      ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + w, y); ctx.stroke();
      ctx.fillText(p.toFixed(dp), P.left + w + 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = spanMs() / 6;
    for (let i = 0; i <= 6; i++) { const t = x0 + step * i; ctx.fillText(fmtT(t).slice(0, 8), X(t), H - P.bottom + 6); }
    ctx.textAlign = "left"; ctx.textBaseline = "middle";

    // quotes as steps
    const line = (arr, pick, color, width, dash) => {
      if (!arr.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash ?? []);
      ctx.beginPath();
      let px = X(arr[0].t), py = Y(pick(arr[0]));
      ctx.moveTo(px, py);
      for (let i = 1; i < arr.length; i++) { const nx = X(arr[i].t), ny = Y(pick(arr[i])); ctx.lineTo(nx, py); ctx.lineTo(nx, ny); px = nx; py = ny; }
      ctx.lineTo(X(x1), py);
      ctx.stroke(); ctx.setLineDash([]);
    };
    if (mode === "mid") {
      line(L, (q) => (q.bid + q.ask) / 2, LEADER, 1.4);
      line(G, (q) => (q.bid + q.ask) / 2, LAGGER, 1.8);
    } else {
      line(L, (q) => q.bid, LEADER, 1, [3, 3]); line(L, (q) => q.ask, LEADER, 1, [3, 3]);
      line(G, (q) => q.bid, LAGGER, 1.6); line(G, (q) => q.ask, LAGGER, 1.6);
    }

    // orders: a triangle at the limit price (up for a buy, down for a sell);
    // hollow while open, filled once filled, crossed when cancelled. Drawn
    // from placement to its last status, so a resting order reads as a bar.
    for (const o of state.orders.values()) {
      if (!(o.px > 0) || o.t < x0 - 1000) continue;
      const y = Y(o.px), xa = X(Math.max(o.placed, x0)), xb = o.status === "open" ? X(x1) : X(o.t);
      ctx.strokeStyle = AMBER; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
      const x = X(Math.max(o.placed, x0));
      tri(x, y, o.side === "buy", o.status === "filled", AMBER);
      if (o.status === "canceled" || o.status === "rejected" || o.status === "marginCanceled") cross(X(o.t), y, MUTED);
      ctx.fillStyle = MUTED; ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`${o.status} ${o.sz}`, xb + 4, y - 7);
    }
    // fills: a dot at the fill price, green buy / red sell
    for (const f of state.fills) {
      if (f.t < x0) continue;
      const x = X(f.t), y = Y(f.px);
      ctx.fillStyle = f.side === "buy" ? GREEN : RED;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0b0e13"; ctx.lineWidth = 1; ctx.stroke();
    }
    // latest values
    ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "left";
    const last = (arr) => arr.length ? arr[arr.length - 1] : null;
    const l = last(L), g = last(G);
    let yy = P.top + 4;
    if (l) { ctx.fillStyle = LEADER; ctx.fillText(`binance ${l.bid} / ${l.ask}  ${fmtT(l.t)}`, P.left + 6, yy); yy += 14; }
    if (g) { ctx.fillStyle = LAGGER; ctx.fillText(`hyperliquid ${g.bid} / ${g.ask}  ${fmtT(g.t)}`, P.left + 6, yy); yy += 14; }
    if (l && g) {
      const edge = (((l.bid + l.ask) / 2 - (g.bid + g.ask) / 2) / ((g.bid + g.ask) / 2)) * 10000;
      ctx.fillStyle = edge >= 0 ? GREEN : RED; ctx.fillText(`edge ${edge >= 0 ? "+" : ""}${edge.toFixed(1)} bps (binance over hl)`, P.left + 6, yy);
    }
  }
  function tri(x, y, up, solid, color) {
    ctx.beginPath();
    if (up) { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); } else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y - 4); ctx.lineTo(x + 5, y - 4); }
    ctx.closePath();
    if (solid) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  function cross(x, y, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }

  // ---- wiring ----
  $("address").onchange = start;
  $("instrument").onchange = start;
  $("span").onchange = requestDraw;
  $("mode").onchange = requestDraw;
  loadSetup().catch((e) => status(String(e), true));
})();
