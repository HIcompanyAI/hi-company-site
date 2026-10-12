/**
 * ウォークフォワード検証。各日、過去データだけで学習し、翌日の寄りで仕掛ける。
 *  執行ルール(日足 OHLC から判定、保守的):
 *   ロング: 寄り O で買い。安値 ≤ 損切り値なら損切り(利確と同日に両方到達なら損切り優先)。高値 ≥ 利確値なら利確。どちらも無ければ大引け決済。
 *   ショート: 対称。
 */
import { alignStock, featureNames, fit, signal } from "./model.mjs";
import { mean, std } from "./util.mjs";

export const DEFAULT_PARAMS = { target: 0.015, stop: 0.01, topK: 3, minScore: 0.15, cost: 0.0006, refitEvery: 10, window: 250, warmup: 120, allowShort: true };

export function tradeOutcome(row, direction, { target, stop, cost }) {
  const O = row.o;
  if (direction === "long") {
    const tgt = O * (1 + target), stp = O * (1 - stop);
    if (row.l <= stp) return { ret: -stop - cost, exit: "stop" };
    if (row.h >= tgt) return { ret: target - cost, exit: "target" };
    return { ret: row.c / O - 1 - cost, exit: "close" };
  }
  const tgt = O * (1 - target), stp = O * (1 + stop);
  if (row.h >= stp) return { ret: -stop - cost, exit: "stop" };
  if (row.l <= tgt) return { ret: target - cost, exit: "target" };
  return { ret: 1 - row.c / O - cost, exit: "close" };
}

/**
 * strategy:
 *  model     回帰で予測した日中リターンの符号・大きさで選ぶ(本命)
 *  momentum  前夜の米国要因と同じ方向に乗る(単純順張り)
 *  fade      前夜の米国要因と逆方向(ギャップ埋め狙い)
 *  adr_revert ADR 理論値より寄りが安ければ買い、高ければ売り(ADR 銘柄のみ)
 */
export function runBacktest(data, params = {}, strategy = "model") {
  const P = { ...DEFAULT_PARAMS, ...params };
  const fx = data.factors.USDJPY || null;
  const stocks = data.stocks.map((s) => ({ s, names: featureNames(s), rows: alignStock(s, data.factors, fx) })).filter((x) => x.rows.length > P.warmup + 20);
  const dates = [...new Set(stocks.flatMap((x) => x.rows.map((r) => r.date)))].sort();
  const byDate = stocks.map((x) => new Map(x.rows.map((r) => [r.date, r])));
  const models = stocks.map(() => null);
  const days = []; const trades = []; const perStock = {};
  for (let di = P.warmup; di < dates.length; di++) {
    const d = dates[di];
    if ((di - P.warmup) % P.refitEvery === 0) {
      stocks.forEach((x, i) => { models[i] = fit(x.rows.filter((r) => r.date < d), x.names, { window: P.window }); });
    }
    const cands = [];
    stocks.forEach((x, i) => {
      const row = byDate[i].get(d); if (!row) return;
      let dir = null, score = 0;
      if (strategy === "model") {
        const sg = signal(x.s, models[i], row.feats); if (!sg) return;
        dir = sg.direction; score = Math.abs(sg.score);
      } else if (strategy === "momentum" || strategy === "fade") {
        const us = mean(x.s.factors.filter((f) => f !== "USDJPY").map((f) => row.feats[f])) * (x.s.inverse ? -1 : 1);
        dir = (us >= 0) === (strategy === "momentum") ? "long" : "short"; score = Math.abs(us) / 0.01;
      } else if (strategy === "adr_revert") {
        if (row.adrGap == null) return;
        const diff = row.adrGap - row.gap; // 理論ギャップ − 実際のギャップ
        dir = diff >= 0 ? "long" : "short"; score = Math.abs(diff) / 0.004;
      }
      if (!dir) return;
      if (dir === "short" && !P.allowShort) return;
      if (score < P.minScore) return;
      cands.push({ i, row, dir, score });
    });
    cands.sort((a, b) => b.score - a.score);
    const picked = cands.slice(0, P.topK);
    const rets = [];
    for (const c of picked) {
      const o = tradeOutcome(c.row, c.dir, P);
      rets.push(o.ret);
      const code = stocks[c.i].s.code;
      trades.push({ date: d, code, dir: c.dir, score: +c.score.toFixed(2), ret: o.ret, exit: o.exit });
      const ps = (perStock[code] ||= { code, name: stocks[c.i].s.name, n: 0, wins: 0, targets: 0, stops: 0, sum: 0 });
      ps.n++; ps.sum += o.ret; if (o.ret > 0) ps.wins++; if (o.exit === "target") ps.targets++; if (o.exit === "stop") ps.stops++;
    }
    days.push({ date: d, n: picked.length, ret: rets.length ? mean(rets) : 0 });
  }
  return summarize(days, trades, perStock, P, strategy, data);
}

function summarize(days, trades, perStock, P, strategy, data) {
  let eq = 1, peak = 1, maxDD = 0; const curve = [];
  for (const d of days) { eq *= 1 + d.ret; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, 1 - eq / peak); curve.push({ date: d.date, equity: eq, target: (1 + P.target) ** (curve.length + 1) }); }
  const active = days.filter((d) => d.n > 0);
  const tr = trades.map((t) => t.ret);
  // ベンチマーク: 日経 225 ETF(1321)の終値ベース買い持ち
  const bench = data.stocks.find((s) => s.code === "1321") || data.stocks[0];
  let benchCurve = [];
  if (bench && days.length) {
    const m = new Map(bench.bars.map((b) => [b.date, b.c])); const start = m.get(days[0].date) || bench.bars[0].c;
    benchCurve = days.map((d) => ({ date: d.date, equity: (m.get(d.date) || start) / start }));
  }
  return {
    strategy, params: P,
    days: days.length, active_days: active.length,
    trades: trades.length,
    win_rate: tr.length ? tr.filter((r) => r > 0).length / tr.length : null,
    target_hit_rate: tr.length ? trades.filter((t) => t.exit === "target").length / tr.length : null,
    stop_rate: tr.length ? trades.filter((t) => t.exit === "stop").length / tr.length : null,
    avg_trade: tr.length ? mean(tr) : null,
    mean_daily: days.length ? mean(days.map((d) => d.ret)) : null,
    std_daily: std(days.map((d) => d.ret)),
    p_day_ge_target: days.length ? days.filter((d) => d.ret >= P.target).length / days.length : null,
    p_day_ge_target_active: active.length ? active.filter((d) => d.ret >= P.target).length / active.length : null,
    final_equity: eq, max_drawdown: maxDD,
    target_equity: (1 + P.target) ** days.length,
    bench_final: benchCurve.length ? benchCurve[benchCurve.length - 1].equity : null,
    annualized: days.length ? eq ** (245 / days.length) - 1 : null,
    per_stock: Object.values(perStock).map((p) => ({ ...p, win_rate: p.wins / p.n, target_rate: p.targets / p.n, avg: p.sum / p.n })).sort((a, b) => b.avg - a.avg),
    curve: thin(curve, 300), bench_curve: thin(benchCurve, 300),
    recent_trades: trades.slice(-60),
  };
}
function thin(arr, max) { if (arr.length <= max) return arr; const step = arr.length / max; return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]).concat([arr[arr.length - 1]]); }

/* ======================= 日経先物(指数)戦略 ======================= */
/**
 * 日経 225 の寄値・終値(日中立会)を先物の代理として使う。
 *  nk_fade      前夜の S&P 500 が +0.2% 以上なら寄りで売り、−0.2% 以下なら買い、引けで決済(米国逆張り)
 *  nk_momentum  その逆(順張り)
 *  nk_overnight 毎日引けで買い、翌朝の寄りで売る(持ち越し。夜間の上昇を取る)
 *  サイズ: 日経マイクロ(1 ポイント = 10 円)× contracts 枚。損切りは寄値 −stop%(日中戦略のみ)。
 */
export const INDEX_DEFAULTS = { contracts: 2, multiplier: 10, capital: 1000000, threshold: 0.002, stop: 0.01, costPts: 5 };

export function runIndexStrategy(data, params = {}, strategy = "nk_fade") {
  const P = { ...DEFAULT_PARAMS, ...INDEX_DEFAULTS, ...params };
  const nk = data.factors.NKY, spx = data.factors.SPX;
  if (!nk || !spx) return null;
  const spxIdx = new Map(spx.map((b, i) => [b.date, i]));
  const lastSpxBefore = (date) => { let lo = 0, hi = spx.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (spx[m].date < date) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  const days = []; const trades = []; const perStock = {};
  const start = Math.max(1, nk.length - 600);
  for (let j = start; j < nk.length; j++) {
    const cur = nk[j], prev = nk[j - 1];
    const notional = P.contracts * P.multiplier * cur.o;
    const lev = notional / P.capital;
    let retPts = 0, dir = null, exit = "none";
    if (strategy === "nk_overnight") {
      // 前日引けで買い → 本日寄りで売り
      dir = "long"; retPts = cur.o - prev.c - P.costPts; exit = "open";
    } else {
      const a = lastSpxBefore(cur.date), b = lastSpxBefore(prev.date);
      if (a < 1 || b < 0 || a === b) { days.push({ date: cur.date, n: 0, ret: 0 }); continue; }
      const us = spx[a].c / spx[b].c - 1;
      if (Math.abs(us) < P.threshold) { days.push({ date: cur.date, n: 0, ret: 0 }); continue; }
      const fadeDir = us > 0 ? "short" : "long";
      dir = strategy === "nk_fade" ? fadeDir : fadeDir === "long" ? "short" : "long";
      const o = tradeOutcome(cur, dir, { target: 10, stop: P.stop, cost: 0 }); // 利確なし(target 1000%)、損切りのみ
      retPts = o.ret * cur.o - P.costPts; exit = o.exit;
    }
    const yen = retPts * P.multiplier * P.contracts;
    const ret = yen / P.capital;
    trades.push({ date: cur.date, code: "NKM", dir, score: 0, ret, exit, yen: Math.round(yen) });
    const ps = (perStock.NKM ||= { code: "NKM", name: "日経225マイクロ先物", n: 0, wins: 0, targets: 0, stops: 0, sum: 0 });
    ps.n++; ps.sum += ret; if (ret > 0) ps.wins++; if (exit === "stop") ps.stops++;
    days.push({ date: cur.date, n: 1, ret, lev });
  }
  const out = summarizeIndex(days, trades, perStock, P, strategy, data);
  out.leverage = days.find((d) => d.lev)?.lev ?? null;
  return out;
}
function summarizeIndex(days, trades, perStock, P, strategy, data) {
  // 既存 summarize と同じ形にそろえる(UI 共有のため)
  let eq = 1, peak = 1, maxDD = 0; const curve = [];
  for (const d of days) { eq *= 1 + d.ret; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, 1 - eq / peak); curve.push({ date: d.date, equity: eq, target: (1 + P.target) ** (curve.length + 1) }); }
  const active = days.filter((d) => d.n > 0); const tr = trades.map((t) => t.ret);
  const nk = data.factors.NKY; const start = nk.find((b) => b.date === days[0]?.date)?.c || nk[0].c;
  const benchCurve = days.map((d) => ({ date: d.date, equity: (nk.find((b) => b.date === d.date)?.c || start) / start }));
  const m = tr.length ? tr.reduce((s, x) => s + x, 0) / tr.length : 0;
  const sd = tr.length > 1 ? Math.sqrt(tr.reduce((s, x) => s + (x - m) ** 2, 0) / (tr.length - 1)) : 0;
  return {
    strategy, params: P, days: days.length, active_days: active.length, trades: trades.length,
    win_rate: tr.length ? tr.filter((r) => r > 0).length / tr.length : null,
    target_hit_rate: null, stop_rate: tr.length ? trades.filter((t) => t.exit === "stop").length / tr.length : null,
    avg_trade: tr.length ? m : null, mean_daily: days.length ? days.reduce((s, d) => s + d.ret, 0) / days.length : null, std_daily: sd,
    sharpe: sd > 1e-9 ? (m / sd) * Math.sqrt(245) : null,
    p_day_ge_target: days.length ? days.filter((d) => d.ret >= P.target).length / days.length : null,
    p_day_ge_target_active: active.length ? active.filter((d) => d.ret >= P.target).length / active.length : null,
    final_equity: eq, max_drawdown: maxDD, target_equity: (1 + P.target) ** days.length,
    bench_final: benchCurve.length ? benchCurve[benchCurve.length - 1].equity : null,
    annualized: days.length ? eq ** (245 / days.length) - 1 : null,
    per_stock: Object.values(perStock).map((p) => ({ ...p, win_rate: p.wins / p.n, target_rate: 0, avg: p.sum / p.n })),
    curve: curve.length > 300 ? curve.filter((_, i) => i % Math.ceil(curve.length / 300) === 0).concat([curve[curve.length - 1]]) : curve,
    bench_curve: benchCurve.length > 300 ? benchCurve.filter((_, i) => i % Math.ceil(benchCurve.length / 300) === 0).concat([benchCurve[benchCurve.length - 1]]) : benchCurve,
    recent_trades: trades.slice(-60),
    monthly: monthly(days, P.capital),
  };
}
function monthly(days, capital) {
  const m = {};
  for (const d of days) { const k = d.date.slice(0, 7); m[k] = (m[k] || 0) + d.ret; }
  return Object.entries(m).map(([month, ret]) => ({ month, ret, yen: Math.round(ret * capital) }));
}
