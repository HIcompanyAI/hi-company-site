(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x, d = 2) => (x == null || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
  const pct0 = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
  const yen = (v) => (v == null ? "—" : `${Math.round(v).toLocaleString("ja-JP")} 円`);
  const num = (v, d = 0) => (v == null ? "—" : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d }));
  const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  const DIR = { long: "買い", short: "売り建て", conditional: "条件付き" };
  const STRAT = { model: "回帰モデル", momentum: "順張り", fade: "逆張り(ギャップ埋め)", adr_revert: "ADR 乖離", nk_fade: "日経先物 米国逆張り", nk_momentum: "日経先物 順張り", nk_overnight: "日経先物 持ち越し" };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

  async function load(u) { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); }

  function renderPlan(p) {
    $("#meta").innerHTML = `生成: ${fmtTime(p.generated_at)} JST　|　資金 ${yen(p.capital)}　|　利確 ${pct(p.params.target, 1)} / 損切り ${pct(-p.params.stop, 1)} / 最大 ${p.params.topK} 銘柄`;
    const b = $("#banner");
    if (p.sample) { b.hidden = false; b.textContent = "⚠ 合成データによるサンプル表示です。実データで node plan.mjs --backtest → node plan.mjs を実行すると置き換わります。"; }
    $("#date").textContent = `${p.date} の東京市場(前夜の米国: ${Object.values(p.market)[0]?.date || "—"})`;
    $("#verdict-text").textContent = p.verdict;
    const st = p.strategy || {};
    $("#strategy").textContent = st.ranking?.length ? `採用手法: ${st.label}。検証順位: ` + st.ranking.map((r) => `${r.label} ${pct(r.avg_trade)}/回`).join("、") : "";
    $("#market").innerHTML = Object.entries(p.market).map(([k, m]) => `<span class="${m.ret >= 0 ? "up" : "down"}">${esc(m.label)} ${pct(m.ret)}</span>`).join("") +
      (p.futures_gap ? `<span class="${p.futures_gap.implied_gap >= 0 ? "up" : "down"}">日経先物が示す寄りギャップ ${pct(p.futures_gap.implied_gap)}</span>` : "");
    $("#plan-count").textContent = p.picks.length ? `${p.picks.length} 銘柄` : "";
    $("#plan").innerHTML = p.picks.length ? `<thead><tr><th>銘柄</th><th>方向</th><th>前日終値</th><th>想定寄値</th><th>利確</th><th>損切り</th><th>株数</th><th>スコア</th><th>検証(勝率 / 利確到達 / 平均)</th></tr></thead><tbody>` +
      p.picks.map((x) => `<tr><td>${esc(x.code)} ${esc(x.name)}<div class="cond">${esc(x.sector)}${x.condition ? "<br>" + esc(x.condition) : ""}</div></td>
        <td><span class="dir ${esc(x.direction)}">${DIR[x.direction] || x.direction}</span><div class="cond">${esc(x.entry)}</div></td>
        <td>${num(x.prev_close)}</td><td>${num(x.expected_open)} <span class="cond">(${pct(x.pred_gap, 1)})</span></td>
        <td>${x.target_price ? num(x.target_price) : pct(x.target_pct, 1)}</td><td>${x.stop_price ? num(x.stop_price) : pct(-x.stop_pct, 1)}</td>
        <td>${num(x.shares)}</td><td>${x.score}</td>
        <td>${x.hist ? `${pct0(x.hist.win_rate)} / ${pct0(x.hist.target_rate)} / <span class="${cls(x.hist.avg)}">${pct(x.hist.avg)}</span> <span class="cond">(${x.hist.n}回)</span>` : "—"}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td class="l" style="white-space:normal">本日の仕掛けはありません。${esc(p.verdict)}</td></tr></tbody>`;
    $("#rules").innerHTML = (p.rules || []).map((r) => `<li>${esc(r)}</li>`).join("");
    $("#cands").innerHTML = `<thead><tr><th>銘柄</th><th>方向</th><th>スコア</th><th>米国要因</th><th>予測ギャップ</th><th>予測日中</th><th>ADR 理論値</th><th>モデル相関</th></tr></thead><tbody>` +
      (p.candidates || []).map((x) => `<tr><td>${esc(x.code)} ${esc(x.name)}</td><td><span class="dir ${esc(x.direction)}">${DIR[x.direction] || x.direction}</span></td><td>${x.score}</td><td class="${cls(x.us_move)}">${pct(x.us_move)}</td><td class="${cls(x.pred_gap)}">${pct(x.pred_gap)}</td><td class="${cls(x.pred_intraday)}">${pct(x.pred_intraday)}</td><td>${x.adr_implied ? num(x.adr_implied) : "—"}</td><td>${x.model_corr}</td></tr>`).join("") + "</tbody>";
  }

  function lineChart(series, { height = 260, logScale = true } = {}) {
    // series: [{label, color, points:[{date, v}]}]
    const W = 900, H = height, pad = { l: 56, r: 16, t: 12, b: 28 };
    const all = series.flatMap((s) => s.points);
    if (!all.length) return "";
    const dates = [...new Set(all.map((p) => p.date))].sort();
    const xi = new Map(dates.map((d, i) => [d, i]));
    const vals = all.map((p) => (logScale ? Math.log(p.v) : p.v));
    const vmin = Math.min(...vals), vmax = Math.max(...vals);
    const X = (d) => pad.l + (xi.get(d) / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r);
    const Y = (v) => { const t = logScale ? Math.log(v) : v; return pad.t + (1 - (t - vmin) / ((vmax - vmin) || 1)) * (H - pad.t - pad.b); };
    const ticks = 4; let grid = "";
    for (let i = 0; i <= ticks; i++) {
      const t = vmin + ((vmax - vmin) * i) / ticks; const v = logScale ? Math.exp(t) : t; const y = pad.t + (1 - i / ticks) * (H - pad.t - pad.b);
      grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-secondary)">×${v >= 10 ? v.toFixed(0) : v.toFixed(2)}</text>`;
    }
    const xl = [0, Math.floor(dates.length / 2), dates.length - 1].map((i) => `<text x="${X(dates[i])}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}" font-size="11" fill="var(--text-secondary)">${dates[i]}</text>`).join("");
    const paths = series.map((s) => { const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(1)},${Y(p.v).toFixed(1)}`).join(""); const last = s.points[s.points.length - 1];
      const ly = Math.max(pad.t + 11, Y(last.v) - 6);
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/><text x="${X(last.date) - 4}" y="${ly}" text-anchor="end" font-size="11" fill="var(--text-primary)">${esc(s.label)} ×${last.v.toFixed(2)}</text>`; }).join("");
    const hover = `<g id="hover" style="display:none"><line y1="${pad.t}" y2="${H - pad.b}" stroke="var(--text-secondary)" stroke-dasharray="3,3"/><rect rx="4" fill="var(--surface-1)" stroke="var(--line)"/><text font-size="11" fill="var(--text-primary)"></text></g>`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="資産曲線" data-dates='${JSON.stringify(dates)}'>${grid}${xl}${paths}${hover}<rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/></svg>`;
    return { svg, attach(el) {
      const s = el.querySelector("svg"), hit = s.querySelector(".hit"), g = s.querySelector("#hover"), line = g.querySelector("line"), rect = g.querySelector("rect"), text = g.querySelector("text");
      hit.addEventListener("mousemove", (e) => {
        const r = s.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (dates.length - 1)); const d = dates[Math.max(0, Math.min(dates.length - 1, i))];
        const lines = [d, ...series.map((sr) => { const p = sr.points.find((q) => q.date === d); return p ? `${sr.label}: ×${p.v.toFixed(3)}` : null; }).filter(Boolean)];
        const px = X(d); line.setAttribute("x1", px); line.setAttribute("x2", px);
        text.innerHTML = lines.map((l, k) => `<tspan x="${px + 10}" dy="${k ? 14 : 0}">${esc(l)}</tspan>`).join(""); text.setAttribute("y", pad.t + 16);
        const bw = Math.max(...lines.map((l) => l.length)) * 6.5 + 12, bh = lines.length * 14 + 8; const bx = px + bw + 14 > W ? px - bw - 10 : px + 4;
        rect.setAttribute("x", bx); rect.setAttribute("y", pad.t + 4); rect.setAttribute("width", bw); rect.setAttribute("height", bh);
        if (px + bw + 14 > W) text.querySelectorAll("tspan").forEach((t) => t.setAttribute("x", bx + 6));
        g.style.display = "";
      });
      hit.addEventListener("mouseleave", () => { g.style.display = "none"; });
    } };
  }

  function renderBacktest(bt) {
    if (!bt) return;
    $("#bt-asof").textContent = `計算 ${fmtTime(bt.computed_at)} JST / ${bt.universe_size} 銘柄${bt.sample ? "(合成データ)" : ""}`;
    const S = bt.strategies; const best = Object.entries(S).filter(([, r]) => r.trades >= 100).sort((a, b) => (b[1].avg_trade ?? -1) - (a[1].avg_trade ?? -1))[0];
    const m = best ? best[1] : S.model; const name = best ? best[0] : "model";
    const T = bt.params.target;
    const kpis = `<div class="kpis">
      <div class="kpi hero"><div class="l">1 日 ${pct(T, 1)} 以上稼げた日の割合(最良手法: ${esc(STRAT[name])})</div><div class="v">${pct0(m.p_day_ge_target)}</div><div class="s">${m.days} 営業日中 / 仕掛けた日だけなら ${pct0(m.p_day_ge_target_active)}</div></div>
      <div class="kpi"><div class="l">1 取引の利確到達率</div><div class="v">${pct0(m.target_hit_rate)}</div><div class="s">損切り到達 ${pct0(m.stop_rate)}</div></div>
      <div class="kpi"><div class="l">勝率 / 平均損益</div><div class="v">${pct0(m.win_rate)}</div><div class="s">平均 <span class="${cls(m.avg_trade)}">${pct(m.avg_trade)}</span> / 回(手数料・滑り込み)</div></div>
      <div class="kpi"><div class="l">検証期間の資産倍率</div><div class="v">×${m.final_equity.toFixed(2)}</div><div class="s">目標(毎日 ${pct(T, 1)})は ×${m.target_equity >= 1000 ? m.target_equity.toExponential(1) : m.target_equity.toFixed(1)} / 日経 ×${m.bench_final?.toFixed(2) ?? "—"}</div></div>
      <div class="kpi"><div class="l">最大ドローダウン</div><div class="v">${pct0(-m.max_drawdown)}</div><div class="s">年率換算 ${pct(m.annualized, 0)}</div></div>
    </div>`;
    const stratTable = `<div class="table-wrap"><table><thead><tr><th>手法</th><th>取引数</th><th>勝率</th><th>利確到達</th><th>損切り</th><th>平均/回</th><th>日次平均</th><th>P(日 ≥ ${pct(T, 1)})</th><th>資産倍率</th><th>最大DD</th></tr></thead><tbody>` +
      Object.entries(S).map(([k, r]) => `<tr><td>${esc(STRAT[k] || k)}${k === name ? " ★" : ""}${r.leverage ? ` <span class="cond">(${r.params.contracts} 枚, レバ ${r.leverage.toFixed(1)}倍)</span>` : ""}</td><td>${r.trades}</td><td>${pct0(r.win_rate)}</td><td>${r.target_hit_rate == null ? "—" : pct0(r.target_hit_rate)}</td><td>${pct0(r.stop_rate)}</td><td class="${cls(r.avg_trade)}">${pct(r.avg_trade)}</td><td class="${cls(r.mean_daily)}">${pct(r.mean_daily)}</td><td>${pct0(r.p_day_ge_target)}</td><td>×${r.final_equity.toFixed(2)}</td><td>${pct0(-r.max_drawdown)}</td></tr>`).join("") + "</tbody></table></div>";
    const fut = Object.entries(S).filter(([k, r]) => k.startsWith("nk_") && r.monthly?.length);
    const monthlyTbl = fut.length ? `<details class="rules"><summary>日経先物戦略の月別損益(資金 ${num(fut[0][1].params.capital)} 円、${fut[0][1].params.contracts} 枚)</summary><div class="table-wrap"><table><thead><tr><th>月</th>${fut.map(([k]) => `<th>${esc(STRAT[k])}</th>`).join("")}</tr></thead><tbody>${fut[0][1].monthly.map((row, i) => `<tr><td>${esc(row.month)}</td>${fut.map(([, r]) => { const mm = r.monthly[i]; return `<td class="${cls(mm?.yen)}">${mm ? num(mm.yen) + " 円" : "—"}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div></details>` : "";
    const sweep = monthlyTbl + `<p class="note">利確幅を変えたときの到達率(回帰モデル): ` + bt.target_sweep.map((s) => `${pct(s.target, 1)} → 到達 ${pct0(s.target_hit_rate)} / 平均 ${pct(s.avg_trade)}`).join("　|　") + "</p>";
    const series = [
      { label: STRAT[name], color: "var(--series-1)", points: m.curve.map((c) => ({ date: c.date, v: c.equity })) },
      { label: `目標(毎日 ${pct(T, 1)})`, color: "var(--series-2)", points: m.curve.map((c) => ({ date: c.date, v: c.target })) },
      { label: "日経225 ETF", color: "var(--series-3)", points: m.bench_curve.map((c) => ({ date: c.date, v: c.equity })) },
    ];
    const ch = lineChart(series);
    $("#bt").innerHTML = kpis + `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div><div class="chart">${ch.svg}</div><p class="note">縦軸は対数(資産倍率)。目標曲線は複利 ${pct(T, 1)}/日。</p>` + stratTable + sweep +
      (m.per_stock?.length ? `<details class="rules"><summary>銘柄別(${esc(STRAT[name])})</summary><div class="table-wrap"><table><thead><tr><th>銘柄</th><th>回数</th><th>勝率</th><th>利確到達</th><th>平均/回</th></tr></thead><tbody>${m.per_stock.map((p) => `<tr><td>${esc(p.code)} ${esc(p.name)}</td><td>${p.n}</td><td>${pct0(p.win_rate)}</td><td>${pct0(p.target_rate)}</td><td class="${cls(p.avg)}">${pct(p.avg)}</td></tr>`).join("")}</tbody></table></div></details>` : "");
    ch.attach($("#bt"));
  }

  function renderPerf(perf, journal) {
    if (!perf || !perf.days) return;
    $("#perf-asof").textContent = `${perf.days} 営業日 / 計算 ${fmtTime(perf.computed_at)} JST`;
    const series = [
      { label: "実績", color: "var(--series-1)", points: perf.curve.map((c) => ({ date: c.date, v: c.equity })) },
      { label: "目標", color: "var(--series-2)", points: perf.curve.map((c) => ({ date: c.date, v: c.target })) },
    ];
    const ch = perf.curve.length > 1 ? lineChart(series, { height: 200 }) : null;
    const rows = (journal?.entries || []).slice(-30).reverse().map((e) => `<tr><td>${esc(e.date)}</td><td>${e.n}</td><td class="${cls(e.day_ret)}">${pct(e.day_ret)}</td><td class="${cls(e.pnl_yen)}">${num(e.pnl_yen)}</td><td class="l">${e.results.map((r) => `${esc(r.code)} ${DIR[r.direction] || r.direction} ${esc(r.exit)} ${pct(r.ret)}`).join(" / ")}</td></tr>`).join("");
    $("#perf").innerHTML = `<div class="kpis">
      <div class="kpi"><div class="l">現在資産</div><div class="v">${yen(perf.equity_yen)}</div><div class="s">目標どおりなら ${yen(perf.target_equity_yen)}</div></div>
      <div class="kpi"><div class="l">目標達成日の割合</div><div class="v">${pct0(perf.p_day_ge_target)}</div><div class="s">日次平均 ${pct(perf.mean_daily)}</div></div>
      <div class="kpi"><div class="l">勝率 / 利確到達</div><div class="v">${pct0(perf.win_rate)}</div><div class="s">利確到達 ${pct0(perf.target_hit_rate)} (${perf.trades} 回)</div></div>
    </div>` + (ch ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div><div class="chart">${ch.svg}</div>` : "") +
      `<div class="table-wrap"><table><thead><tr><th>日付</th><th>銘柄数</th><th>日次</th><th>損益(円)</th><th class="l">内訳</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    if (ch) ch.attach($("#perf"));
  }

  (async () => {
    try {
      const [plan, bt, perf, journal] = await Promise.all([load("data/latest.json"), load("data/backtest.json").catch(() => null), load("data/performance.json").catch(() => null), load("data/journal.json").catch(() => null)]);
      renderPlan(plan); renderBacktest(bt); renderPerf(perf, journal);
    } catch (e) {
      $("#meta").textContent = "データなし"; const b = $("#banner"); b.hidden = false; b.className = "banner err"; b.textContent = `データを読み込めません(${e.message})。scripts で node plan.mjs --backtest と node plan.mjs を実行してください。`;
    }
  })();
})();
