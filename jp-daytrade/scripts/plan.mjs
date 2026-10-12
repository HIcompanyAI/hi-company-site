#!/usr/bin/env node
/**
 * 日本株デイトレ計画・採点・検証。
 *   node plan.mjs                 朝(07:30 JST 目安): 前夜の米国要因から本日の売買プランを作る → data/latest.json
 *   node plan.mjs --score         夕方(15:45 JST 以降): 本日プランを実際の OHLC で採点 → data/journal.json / performance.json
 *   node plan.mjs --backtest      ウォークフォワード検証 → data/backtest.json(週 1 回程度)
 *   node plan.mjs --sample        合成データで全工程を実行(ネット不要)
 *   オプション: --target=0.015 --stop=0.01 --topk=3 --capital=1000000 --offline
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll, DATA_DIR } from "./lib/data.mjs";
import { makeSynthetic } from "./lib/synthetic.mjs";
import { alignStock, featureNames, fit, latestFeatures, signal } from "./lib/model.mjs";
import { runBacktest, runIndexStrategy, tradeOutcome, DEFAULT_PARAMS, INDEX_DEFAULTS } from "./lib/backtest.mjs";
import { readJson, writeJson, log, ymd, mean, pct } from "./lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const universe = readJson(path.join(here, "lib", "universe.json"), null);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const SAMPLE = Boolean(args.sample);
const P = { ...DEFAULT_PARAMS, target: +(args.target || process.env.TARGET_PCT || DEFAULT_PARAMS.target), stop: +(args.stop || process.env.STOP_PCT || DEFAULT_PARAMS.stop), topK: +(args.topk || process.env.TOP_K || DEFAULT_PARAMS.topK) };
const CAPITAL = +(args.capital || process.env.CAPITAL || 1000000);
const CONTRACTS = +(args.contracts || process.env.CONTRACTS || 1);
const MIN_EDGE_TRADES = 30;

async function getData() {
  if (SAMPLE) return makeSynthetic(universe, { days: 420, seed: +(args.seed || 7) });
  return loadAll(universe, { offline: Boolean(args.offline) });
}

/* ---------- 朝: プラン ---------- */
async function makePlan() {
  const prevBt = readJson(path.join(DATA_DIR, "backtest.json"), null);
  if (!SAMPLE && (!prevBt || Date.now() - new Date(prevBt.computed_at).getTime() > 7 * 86400 * 1000)) { log("backtest stale → refresh"); await backtest(); }
  const data = await getData();
  const today = SAMPLE ? nextBiz(data.stocks[0].bars[data.stocks[0].bars.length - 1].date) : (args.date || ymd());
  const fx = data.factors.USDJPY || null;
  const bt = readJson(path.join(DATA_DIR, "backtest.json"), null);
  // 検証で最も期待値が高かった手法を採用(取引 100 回以上、平均損益がプラスのもの)。無ければ model を表示のみ
  const LABEL = { model: "回帰モデル", momentum: "順張り(米国と同方向)", fade: "逆張り(ギャップ埋め)", adr_revert: "ADR 理論値との乖離", nk_fade: "日経先物 米国逆張り", nk_momentum: "日経先物 順張り", nk_overnight: "日経先物 持ち越し(引け買い→翌寄り売り)" };
  const ranked = Object.entries(bt?.strategies || {}).filter(([, r]) => r.trades >= 100).sort((a, b) => (b[1].avg_trade ?? -1) - (a[1].avg_trade ?? -1));
  const best = ranked[0] || null;
  const STRAT = best && best[1].avg_trade > 0 ? best[0] : "model";
  const edgeOk = Boolean(best && best[1].avg_trade > 0);
  const perStock = Object.fromEntries((bt?.strategies?.[STRAT]?.per_stock || []).map((p) => [p.code, p]));
  const market = {};
  for (const [k, bars] of Object.entries(data.factors)) {
    const a = bars[bars.length - 1], b = bars[bars.length - 2];
    market[k] = { label: universe.factors[k]?.label || k, date: a.date, close: a.c, ret: a.c / b.c - 1 };
  }
  let futuresGap = null;
  if (data.futures && data.factors.NKY) {
    const f = data.futures[data.futures.length - 1], n = data.factors.NKY[data.factors.NKY.length - 1];
    if (f.date >= n.date) futuresGap = { futures_close: f.c, nikkei_close: n.c, implied_gap: f.c / n.c - 1, date: f.date };
  }
  const cands = []; const skipped = [];
  for (const s of data.stocks) {
    const rows = alignStock(s, data.factors, fx);
    const names = featureNames(s);
    const model = fit(rows, names, { window: P.window });
    const lastDate = s.bars[s.bars.length - 1].date;
    const lf = latestFeatures(s, data.factors, fx, lastDate);
    if (!model || !lf) { skipped.push({ code: s.code, reason: !model ? "学習データ不足" : "前夜の米国データ未確定" }); continue; }
    const sg = signal(s, model, lf.feats);
    if (!sg) { skipped.push({ code: s.code, reason: "特徴量不足" }); continue; }
    const prevClose = s.bars[s.bars.length - 1].c;
    const expectedOpen = prevClose * (1 + sg.predGap);
    const hist = perStock[s.code] || null;
    // 手法ごとの方向とスコア
    const usMove = mean(s.factors.filter((f) => f !== "USDJPY").map((f) => lf.feats[f])) * (s.inverse ? -1 : 1);
    let direction = sg.direction, score = sg.score, entry = "寄り成行", condition = null;
    if (STRAT === "momentum") { direction = usMove >= 0 ? "long" : "short"; score = usMove / 0.01; }
    else if (STRAT === "fade") { direction = usMove >= 0 ? "short" : "long"; score = usMove / 0.01; }
    else if (STRAT === "adr_revert") {
      if (lf.adrImplied == null) { skipped.push({ code: s.code, reason: "ADR なし" }); continue; }
      direction = "conditional"; score = Math.abs(lf.feats.ADR) / 0.004;
      entry = "寄り後に成行(条件付き)";
      condition = `寄り付きが ADR 理論値 ${Math.round(lf.adrImplied).toLocaleString("ja-JP")} 円より 0.4% 以上安ければ買い、高ければ売り建て。乖離 0.4% 未満なら見送り`;
    }
    cands.push({
      code: s.code, name: s.name, sector: s.sector, direction, score: +(+score).toFixed(2), model_corr: +sg.confidence.toFixed(3),
      prev_close: prevClose, prev_date: lastDate, pred_gap: sg.predGap, expected_open: expectedOpen, pred_intraday: sg.predInt, us_move: usMove,
      adr_implied: lf.adrImplied, factors: lf.detail,
      entry, condition, target_pct: P.target, stop_pct: P.stop,
      target_price: direction === "conditional" ? null : expectedOpen * (direction === "long" ? 1 + P.target : 1 - P.target),
      stop_price: direction === "conditional" ? null : expectedOpen * (direction === "long" ? 1 - P.stop : 1 + P.stop),
      hist: hist ? { n: hist.n, win_rate: hist.win_rate, target_rate: hist.target_rate, avg: hist.avg } : null,
    });
  }
  cands.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  // 採用条件: スコア閾値、過去検証で期待値が負の銘柄は除外
  let picks = edgeOk ? cands.filter((c) => Math.abs(c.score) >= P.minScore && !(c.hist && c.hist.n >= MIN_EDGE_TRADES && c.hist.avg <= 0)).slice(0, P.topK) : [];
  const perPos = Math.floor(CAPITAL / P.topK);
  for (const p of picks) { p.position_yen = perPos; p.shares = Math.max(100, Math.floor(perPos / p.expected_open / 100) * 100); }
  // 先物戦略が最良なら、プランは先物 1 行に置き換える
  if (STRAT.startsWith("nk_") && edgeOk && data.factors.NKY && data.factors.SPX) {
    const nk = data.factors.NKY[data.factors.NKY.length - 1], sp = data.factors.SPX, spLast = sp[sp.length - 1], spPrev = sp[sp.length - 2];
    const us = spLast.c / spPrev.c - 1;
    let direction, condition, entry;
    if (STRAT === "nk_overnight") { direction = "long"; entry = "15:40 頃に買い建て(日中立会の引け)"; condition = "翌朝 8:45 の寄り付きで成行決済。損切りは夜間に建値 −1% の逆指値"; }
    else {
      const fade = us > 0 ? "short" : "long"; direction = STRAT === "nk_fade" ? fade : fade === "long" ? "short" : "long";
      if (Math.abs(us) < INDEX_DEFAULTS.threshold) { direction = "flat"; }
      entry = "8:45 の寄り付きで成行"; condition = direction === "flat" ? `前夜の S&P 500 が ${pct(us)} と小動きのため見送り(閾値 ±${pct(INDEX_DEFAULTS.threshold, 1)})` : `前夜の S&P 500 ${pct(us)} → ${direction === "short" ? "売り建て" : "買い建て"}。15:40 までに成行決済。損切りは寄値 ${direction === "short" ? "+" : "−"}${(P.stop * 100).toFixed(1)}%(約 ${Math.round(nk.c * P.stop)} 円幅)`;
    }
    const etfCode = direction === "short" ? "1357" : "1570";
    const etf = data.stocks.find((x) => x.code === etfCode);
    const etfPx = etf ? etf.bars[etf.bars.length - 1].c : null;
    const targetExposure = nk.c * 10 * CONTRACTS; // 先物と同じ想定元本
    const etfYen = Math.round(targetExposure / 2); // 2 倍型 ETF なので半分の金額
    const etfShares = etfPx ? Math.max(1, Math.floor(etfYen / etfPx)) : null;
    const etfAlt = direction === "flat" || !etfPx ? null : { code: etfCode, name: etfCode === "1357" ? "日経ダブルインバース(-2倍)" : "日経レバレッジ(2倍)", action: "買い(現物)", shares: etfShares, approx_yen: etfShares ? Math.round(etfShares * etfPx) : null, last_price: etfPx, stop_pct: P.stop * 2, note: `9:00 寄り成行で買い → 15:20 までに成行で売り。損切りは買値 −${(P.stop * 200).toFixed(0)}%(2 倍型なので先物の −${(P.stop * 100).toFixed(0)}% に相当)の逆指値` };
    picks = direction === "flat" ? [] : [{ code: "NKM", name: "日経225マイクロ先物", etf_alternative: etfAlt, sector: `${CONTRACTS} 枚(1 枚 = 日経平均 × 10 円)`, direction, score: +(Math.abs(us) / 0.01).toFixed(2), model_corr: null, prev_close: nk.c, prev_date: nk.date, pred_gap: null, expected_open: nk.c, pred_intraday: null, us_move: us, adr_implied: null, entry, condition, target_pct: null, stop_pct: P.stop, target_price: null, stop_price: direction === "long" ? nk.c * (1 - P.stop) : nk.c * (1 + P.stop), shares: CONTRACTS, position_yen: Math.round(nk.c * 10 * CONTRACTS), hist: perStock.NKM ? { n: perStock.NKM.n, win_rate: perStock.NKM.win_rate, target_rate: null, avg: perStock.NKM.avg } : null }];
  }
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const holiday = (universe.jp_holidays || []).includes(today) || dow === 0 || dow === 6;
  if (holiday) picks = [];
  const edge = bt?.strategies?.[STRAT] || null;
  const verdict = holiday ? "東京市場は休場: 発注なし" : !bt ? "検証データなし: 先に --backtest を実行" : !edgeOk ? "検証した全手法の期待値がマイナス: 本日は見送り" : picks.length === 0 ? "本日は見送り(シグナル弱)" : STRAT.startsWith("nk_") ? `${LABEL[STRAT]}: ${picks[0].direction === "short" ? "売り建て" : "買い建て"} ${CONTRACTS} 枚` : `${picks.length} 銘柄を仕掛け(${LABEL[STRAT]})`;
  const plan = {
    date: today, generated_at: new Date().toISOString(), sample: SAMPLE, params: P, capital: CAPITAL, holiday,
    strategy: { name: STRAT, label: LABEL[STRAT], edge_ok: edgeOk, ranking: ranked.map(([k, r]) => ({ name: k, label: LABEL[k], avg_trade: r.avg_trade, win_rate: r.win_rate, trades: r.trades })) },
    market, futures_gap: futuresGap, verdict, picks, candidates: cands.slice(0, 15), skipped,
    rules: [
      `仕掛け: 9:00 の寄り付きで成行(${P.topK} 銘柄まで、各 ${perPos.toLocaleString("ja-JP")} 円)`,
      `利確: 寄値 ${pct(P.target, 1)} に指値(OCO)`,
      `損切り: 寄値 ${pct(-P.stop, 1)} に逆指値(必ず入れる。約定を確認するまで離席しない)`,
      "どちらにも届かなければ 15:25 までに成行で手仕舞い。持ち越し禁止",
      "寄り付きが想定寄値から ±1% 以上ずれたら、その銘柄は見送り(想定と違う材料が出ている)",
      "1 日の損失が資金の 2% に達したら、その日は終了",
    ],
    backtest_summary: edge ? { trades: edge.trades, win_rate: edge.win_rate, target_hit_rate: edge.target_hit_rate, avg_trade: edge.avg_trade, p_day_ge_target: edge.p_day_ge_target, mean_daily: edge.mean_daily, annualized: edge.annualized, max_drawdown: edge.max_drawdown } : null,
  };
  writeJson(path.join(DATA_DIR, "plans", `${today}.json`), plan);
  writeJson(path.join(DATA_DIR, "latest.json"), plan);
  fs.writeFileSync(path.join(DATA_DIR, "brief.txt"), brief(plan));
  log(`plan ${today}: ${verdict} ${picks.map((p) => `${p.code}${p.direction === "long" ? "買" : "売"}`).join(" ")}`);
  return plan;
}
export function brief(plan) {
  const m = plan.market; const line = [];
  line.push(`【${plan.date} 朝のプラン】${plan.verdict}`);
  line.push(`前夜: S&P500 ${pct(m.SPX?.ret)} / NASDAQ100 ${pct(m.NDX?.ret)} / SOX ${pct(m.SOX?.ret)} / ドル円 ${pct(m.USDJPY?.ret)}`);
  for (const p of plan.picks) {
    if (p.code === "NKM") {
      line.push(`■ 先物口座がある場合: 日経225マイクロ先物を ${p.direction === "short" ? "売り建て" : "買い建て"} ${p.shares} 枚、${p.entry}。損切り: ${Math.round(p.stop_price).toLocaleString("ja-JP")} 付近(寄値から ${p.direction === "short" ? "+" : "−"}${(p.stop_pct * 100).toFixed(1)}%)の逆指値。15:40 までに成行決済`);
      if (p.etf_alternative) { const e = p.etf_alternative; line.push(`■ 先物口座が無い場合: ${e.code} ${e.name} を現物で ${e.shares} 株(約 ${e.approx_yen?.toLocaleString("ja-JP")} 円)${e.note}`); }
    } else {
      line.push(`■ ${p.code} ${p.name}: ${p.direction === "long" ? "買い" : "売り"} ${p.shares} 株、${p.entry}。利確 ${Math.round(p.target_price || 0).toLocaleString("ja-JP")} / 損切り ${Math.round(p.stop_price || 0).toLocaleString("ja-JP")}`);
    }
  }
  if (!plan.picks.length) line.push("本日の発注はありません。");
  if (plan.backtest_summary) line.push(`参考(検証): 勝率 ${(plan.backtest_summary.win_rate * 100).toFixed(0)}%、1 日平均 ${pct(plan.backtest_summary.avg_trade)}、最大DD ${(plan.backtest_summary.max_drawdown * 100).toFixed(0)}%`);
  line.push("※ 損切りの逆指値は約定確認後すぐに入れる。寄り付きが想定と大きく違う(前夜の米国と逆に窓を開けた等)ときは見送り。");
  return line.join("\n") + "\n";
}
function nextBiz(d) { const x = new Date(d + "T00:00:00Z"); do { x.setUTCDate(x.getUTCDate() + 1); } while ([0, 6].includes(x.getUTCDay())); return x.toISOString().slice(0, 10); }

/* ---------- 夕方: 採点 ---------- */
async function score() {
  const data = await getData();
  const journalFile = path.join(DATA_DIR, "journal.json");
  const journal = readJson(journalFile, { entries: [] });
  const done = new Set(journal.entries.map((e) => e.date));
  const plansDir = path.join(DATA_DIR, "plans");
  const files = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((f) => f.endsWith(".json")).sort() : [];
  let scored = 0;
  for (const f of files) {
    const plan = readJson(path.join(plansDir, f), null);
    if (!plan || done.has(plan.date)) continue;
    const results = [];
    for (const p of plan.picks || []) {
      if (p.code === "NKM") {
        const nk = data.factors.NKY; const i = SAMPLE ? nk.length - 1 : nk.findIndex((b) => b.date === plan.date); if (i < 1) continue;
        const bar = nk[i]; let yen;
        if (plan.strategy?.name === "nk_overnight") yen = (bar.o - nk[i - 1].c - 5) * 10 * p.shares;
        else { const o = tradeOutcome(bar, p.direction, { target: 10, stop: plan.params.stop, cost: 0 }); yen = (o.ret * bar.o - 5) * 10 * p.shares; }
        results.push({ code: "NKM", name: p.name, direction: p.direction, open: bar.o, high: bar.h, low: bar.l, close: bar.c, expected_open: bar.o, open_vs_expected: 0, skipped: false, ret: yen / plan.capital, exit: "close", pnl_yen: Math.round(yen) });
        continue;
      }
      const s = data.stocks.find((x) => x.code === p.code); if (!s) continue;
      const bar = SAMPLE ? s.bars[s.bars.length - 1] : s.bars.find((b) => b.date === plan.date);
      if (!bar) continue;
      let dir = p.direction;
      if (dir === "conditional") {
        const dev = bar.o / p.adr_implied - 1;
        if (Math.abs(dev) < 0.004) { results.push({ code: p.code, name: p.name, direction: "見送り", open: bar.o, close: bar.c, ret: 0, exit: "条件未達", pnl_yen: 0, skipped: true }); continue; }
        dir = dev < 0 ? "long" : "short";
      }
      const o = tradeOutcome(bar, dir, plan.params);
      const gapErr = p.direction === "conditional" ? 0 : bar.o / p.expected_open - 1;
      results.push({ code: p.code, name: p.name, direction: dir, open: bar.o, high: bar.h, low: bar.l, close: bar.c, expected_open: p.expected_open, open_vs_expected: gapErr, skipped: Math.abs(gapErr) > 0.01, ret: Math.abs(gapErr) > 0.01 ? 0 : o.ret, exit: Math.abs(gapErr) > 0.01 ? "見送り" : o.exit, pnl_yen: Math.abs(gapErr) > 0.01 ? 0 : Math.round(p.position_yen * o.ret) });
    }
    if (!results.length && (plan.picks || []).length) continue; // まだ当日の足が無い
    const isFut = results.some((r) => r.code === "NKM");
    const dayRet = !results.length ? 0 : isFut ? results.reduce((s, r) => s + r.ret, 0) : mean(results.map((r) => r.ret)) * (results.length / (plan.params.topK || results.length));
    journal.entries.push({ date: plan.date, verdict: plan.verdict, n: results.length, day_ret: dayRet, pnl_yen: results.reduce((s, r) => s + r.pnl_yen, 0), results });
    done.add(plan.date); scored++;
  }
  journal.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeJson(journalFile, journal);
  // 実績サマリ
  let eq = CAPITAL; const curve = [];
  for (const e of journal.entries) { eq += e.pnl_yen; curve.push({ date: e.date, equity: eq / CAPITAL, target: (1 + P.target) ** (curve.length + 1) }); }
  const tr = journal.entries.flatMap((e) => e.results.filter((r) => !r.skipped));
  const perf = {
    computed_at: new Date().toISOString(), capital: CAPITAL, days: journal.entries.length, trades: tr.length,
    win_rate: tr.length ? tr.filter((r) => r.ret > 0).length / tr.length : null,
    target_hit_rate: tr.length ? tr.filter((r) => r.exit === "target").length / tr.length : null,
    p_day_ge_target: journal.entries.length ? journal.entries.filter((e) => e.day_ret >= P.target).length / journal.entries.length : null,
    mean_daily: journal.entries.length ? mean(journal.entries.map((e) => e.day_ret)) : null,
    equity_yen: Math.round(eq), target_equity_yen: Math.round(CAPITAL * (1 + P.target) ** journal.entries.length), curve,
  };
  writeJson(path.join(DATA_DIR, "performance.json"), perf);
  const last = journal.entries[journal.entries.length - 1];
  const sb = last ? `【${last.date} 採点】${last.n ? last.results.map((r) => `${r.code} ${r.direction === "long" ? "買い" : r.direction === "short" ? "売り" : r.direction} ${r.exit} ${pct(r.ret)} (${(r.pnl_yen || 0).toLocaleString("ja-JP")} 円)`).join(" / ") : "発注なし"}\n累計: ${perf.equity_yen.toLocaleString("ja-JP")} 円(開始 ${perf.capital.toLocaleString("ja-JP")} 円、${perf.days} 営業日、勝率 ${perf.win_rate == null ? "—" : (perf.win_rate * 100).toFixed(0) + "%"})\n` : "採点対象なし\n";
  fs.writeFileSync(path.join(DATA_DIR, "brief.txt"), sb);
  log(`score: ${scored} day(s) graded, equity ${perf.equity_yen} yen vs target ${perf.target_equity_yen}`);
}

/* ---------- 検証 ---------- */
async function backtest() {
  const data = await getData();
  const strategies = {};
  for (const st of ["model", "momentum", "fade", "adr_revert"]) {
    strategies[st] = runBacktest(data, { ...P, capital: CAPITAL }, st);
    const r = strategies[st];
    log(`${st.padEnd(12)} trades ${r.trades} win ${pct(r.win_rate, 0)} target-hit ${pct(r.target_hit_rate, 0)} avg ${pct(r.avg_trade)} P(day≥${pct(P.target, 1)}) ${pct(r.p_day_ge_target, 0)} final ${r.final_equity.toFixed(3)} (target ${r.target_equity.toExponential(2)}) DD ${pct(r.max_drawdown, 0)}`);
  }
  for (const st of ["nk_fade", "nk_momentum", "nk_overnight"]) {
    const r = runIndexStrategy(data, { ...P, capital: CAPITAL, contracts: CONTRACTS }, st);
    if (!r) continue;
    strategies[st] = r;
    log(`${st.padEnd(12)} days ${r.trades} win ${pct(r.win_rate, 0)} avg ${pct(r.avg_trade)} sharpe ${r.sharpe?.toFixed(2)} final ${r.final_equity.toFixed(3)} DD ${pct(r.max_drawdown, 0)} lev ${r.leverage?.toFixed(2)}`);
  }
  // 1.5% 目標の感度: 利確幅を変えたときの到達確率
  const sweep = [0.005, 0.01, 0.015, 0.02, 0.03].map((t) => { const r = runBacktest(data, { ...P, target: t }, "model"); return { target: t, target_hit_rate: r.target_hit_rate, avg_trade: r.avg_trade, p_day_ge_target: r.p_day_ge_target, final_equity: r.final_equity }; });
  const out = { computed_at: new Date().toISOString(), sample: SAMPLE, params: P, universe_size: data.stocks.length, strategies, target_sweep: sweep };
  writeJson(path.join(DATA_DIR, "backtest.json"), out);
  return out;
}

(async () => {
  try {
    if (args.backtest) await backtest();
    else if (args.score) await score();
    else if (SAMPLE) { await backtest(); await makePlan(); await score(); }
    else await makePlan();
  } catch (e) { console.error("FAILED:", e?.stack || e); process.exit(1); }
})();
