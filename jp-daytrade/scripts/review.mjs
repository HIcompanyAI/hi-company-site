#!/usr/bin/env node
/**
 * 日次レビュー(改善サイクル用の診断レポート)。
 *   node review.mjs            標準出力にレポート(プレーンテキスト)
 *   環境変数: US_THRESHOLD(閾値, 既定 0.01) CONTRACTS(枚数) CAPITAL(資金) STOP_PCT(損切り)
 * 内容: 直近取引日の明細 / 期間別の成績(直近 20・60・120・250 日) / 閾値×損切りの格子 / 紙上運用の累計 / データ鮮度
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll, DATA_DIR } from "./lib/data.mjs";
import { tradeOutcome } from "./lib/backtest.mjs";
import { readJson, pct } from "./lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const universe = readJson(path.join(here, "lib", "universe.json"), null);
const LIVE = { threshold: +(process.env.US_THRESHOLD || 0.01), contracts: +(process.env.CONTRACTS || 4), capital: +(process.env.CAPITAL || 1000000), stop: +(process.env.STOP_PCT || 0.01) };
const yen = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString("ja-JP")}`;
const data = await loadAll(universe, { offline: process.argv.includes("--offline") });

function stats(trades) {
  const n = trades.length; if (!n) return { n: 0, win: null, total: 0, dd: 0, sharpe: null, avg: 0, stops: 0 };
  let eq = 0, pk = 0, dd = 0; for (const t of trades) { eq += t.yen; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const r = trades.map((t) => t.ret); const m = r.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  return { n, win: trades.filter((t) => t.yen > 0).length / n, total: eq, dd, sharpe: sd > 1e-9 ? (m / sd) * Math.sqrt(245) : null, avg: eq / n, stops: trades.filter((t) => t.exit === "stop").length };
}
const fmt = (s) => s.n ? `${String(s.n).padStart(3)} 回  勝率 ${(s.win * 100).toFixed(0).padStart(3)}%  損益 ${yen(s.total).padStart(9)} 円  1 回平均 ${yen(s.avg).padStart(7)} 円  最大DD ${yen(-s.dd).padStart(8)} 円  Sharpe ${s.sharpe == null ? "  —" : s.sharpe.toFixed(2).padStart(5)}  損切り ${s.stops} 回` : "  取引なし";

/** 運用設定での逆張り取引を全件再構築(backtest.mjs の runIndexStrategy と同じ執行ルール) */
function fadeTrades(p) {
  const P = { ...LIVE, ...p }; const spx = data.factors.SPX, idx = data.factors.NKY, etf = data.stocks.find((s) => s.code === "1321").bars;
  const lastBefore = (b, d) => { let lo = 0, hi = b.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m].date < d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const level = new Map(idx.map((b) => [b.date, b.c])); const out = [];
  for (let j = Math.max(1, etf.length - 600); j < etf.length; j++) {
    const c = etf[j], pv = etf[j - 1]; if (Math.abs(c.o / pv.c - 1) > 0.15) continue;
    const a = lastBefore(spx, c.date), b = lastBefore(spx, pv.date); if (a < 1 || a === b) continue;
    const us = spx[a].c / spx[b].c - 1; if (Math.abs(us) < P.threshold) continue;
    const dir = us > 0 ? "short" : "long"; const o = tradeOutcome(c, dir, { target: 10, stop: P.stop, cost: 0 });
    const lv = level.get(pv.date) || c.o; const y = (o.ret * lv - 5) * 10 * P.contracts;
    out.push({ date: c.date, us, dir, o: c.o, h: c.h, l: c.l, c: c.c, exit: o.exit, frac: o.ret, yen: y, ret: y / P.capital });
  }
  return out;
}
const T = fadeTrades({});
const etf = data.stocks.find((s) => s.code === "1321").bars; const lastDate = etf[etf.length - 1].date;
const dates = etf.map((b) => b.date);
const since = (nDays) => dates[Math.max(0, dates.length - nDays)];

console.log(`===== 日次レビュー ${new Date().toISOString().slice(0, 10)} =====`);
console.log(`運用設定: 日経先物 米国逆張り / S&P 閾値 ±${(LIVE.threshold * 100).toFixed(1)}% / ${LIVE.contracts} 枚 / 損切り ${(LIVE.stop * 100).toFixed(1)}% / 資金 ${LIVE.capital.toLocaleString("ja-JP")} 円`);
console.log(`データ鮮度: S&P ${data.factors.SPX.at(-1).date}  日経 ${data.factors.NKY.at(-1).date}  ETF1321 ${lastDate}  VIX ${data.factors.VIX?.at(-1).date ?? "—"}`);

console.log(`\n--- 直近の取引日(${lastDate}) ---`);
{
  const spx = data.factors.SPX; const j = etf.length - 1; const pv = etf[j - 1];
  const a = spx.findLastIndex((b) => b.date < lastDate), b = spx.findLastIndex((x) => x.date < pv.date);
  const us = a > 0 && a !== b ? spx[a].c / spx[b].c - 1 : null;
  const t = T.find((x) => x.date === lastDate);
  console.log(`前夜 S&P ${us == null ? "—" : pct(us)} → ${us == null ? "判定不能" : Math.abs(us) < LIVE.threshold ? "見送り(閾値未満)" : us > 0 ? "売り" : "買い"}`);
  const f1 = (v) => (+v).toFixed(1); console.log(`ETF1321  寄 ${f1(etf[j].o)} 高 ${f1(etf[j].h)} 安 ${f1(etf[j].l)} 引 ${f1(etf[j].c)}  (寄→引 ${pct(etf[j].c / etf[j].o - 1)}, 前日比ギャップ ${pct(etf[j].o / pv.c - 1)})`);
  if (t) {
    console.log(`結果: ${t.dir === "short" ? "売り" : "買い"} ${t.exit === "stop" ? "損切り" : "引け決済"} ${pct(t.frac)} = ${yen(t.yen)} 円`);
    for (const s of [0.005, 0.007, 0.015, 10]) { const o = tradeOutcome(etf[j], t.dir, { target: 10, stop: s, cost: 0 }); const lv = data.factors.NKY.find((x) => x.date === pv.date)?.c || etf[j].o; console.log(`  もし損切り ${s >= 10 ? "なし " : (s * 100).toFixed(1) + "%"} なら: ${o.exit === "stop" ? "損切り" : "引け"} ${pct(o.ret)} = ${yen((o.ret * lv - 5) * 10 * LIVE.contracts)} 円`); }
  }
}

console.log("\n--- 期間別の成績(運用設定、ETF1321 実売買価格ベース) ---");
for (const n of [20, 60, 120, 250, 600]) { const from = since(n); console.log(`直近 ${String(n).padStart(3)} 営業日(${from}〜) ${fmt(stats(T.filter((t) => t.date >= from)))}`); }

console.log("\n--- 月別(直近 12 か月) ---");
{ const m = {}; for (const t of T) { const k = t.date.slice(0, 7); (m[k] ||= { n: 0, y: 0, w: 0 }); m[k].n++; m[k].y += t.yen; if (t.yen > 0) m[k].w++; }
  for (const [k, v] of Object.entries(m).slice(-12)) console.log(`${k}  ${String(v.n).padStart(2)} 回  勝 ${v.w}  ${yen(v.y).padStart(9)} 円`); }

console.log("\n--- 閾値 × 損切り の格子(直近 250 営業日 / 全期間 600 日、枚数は運用設定) ---");
console.log("閾値   損切り | 直近250: 回数 勝率 損益 最大DD Sharpe | 全期間: 回数 勝率 損益 最大DD Sharpe");
for (const th of [0.005, 0.007, 0.01, 0.015]) for (const st of [0.007, 0.01, 0.015, 10]) {
  const tr = fadeTrades({ threshold: th, stop: st }); const a = stats(tr.filter((t) => t.date >= since(250))), b = stats(tr);
  const cell = (s) => `${String(s.n).padStart(3)} ${s.win == null ? " —%" : (s.win * 100).toFixed(0).padStart(3) + "%"} ${yen(s.total).padStart(9)} ${yen(-s.dd).padStart(8)} ${s.sharpe == null ? "   —" : s.sharpe.toFixed(2).padStart(5)}`;
  console.log(`${(th * 100).toFixed(1)}%  ${st >= 10 ? "なし " : (st * 100).toFixed(1) + "%"}${th === LIVE.threshold && st === LIVE.stop ? "*" : " "} | ${cell(a)} | ${cell(b)}`);
}
console.log("(* = 現在の運用設定)");

console.log("\n--- 条件別(全期間、運用設定): どんな日に効いているか ---");
{
  const by = (label, f) => console.log(`${label.padEnd(22)} ${fmt(stats(T.filter(f)))}`);
  by("S&P 上昇日(売り)", (t) => t.dir === "short"); by("S&P 下落日(買い)", (t) => t.dir === "long");
  by("|S&P| 1.0〜1.5%", (t) => Math.abs(t.us) < 0.015); by("|S&P| 1.5〜2.5%", (t) => Math.abs(t.us) >= 0.015 && Math.abs(t.us) < 0.025); by("|S&P| 2.5% 以上", (t) => Math.abs(t.us) >= 0.025);
  const vix = data.factors.VIX; if (vix) { const vmap = new Map(vix.map((b) => [b.date, b.c])); const lastVix = (d) => { let v = null; for (const b of vix) { if (b.date < d) v = b.c; else break; } return v; }; by("VIX < 20", (t) => (lastVix(t.date) ?? 99) < 20); by("VIX 20〜30", (t) => { const v = lastVix(t.date) ?? 0; return v >= 20 && v < 30; }); by("VIX 30 以上", (t) => (lastVix(t.date) ?? 0) >= 30); }
  by("月曜(週末明け)", (t) => new Date(t.date + "T00:00:00Z").getUTCDay() === 1); by("火〜金", (t) => new Date(t.date + "T00:00:00Z").getUTCDay() !== 1);
  by("寄りが米国と同方向に窓", (t) => (t.dir === "short" ? t.o > T_prev(t) : t.o < T_prev(t))); by("寄りが米国と逆方向に窓", (t) => (t.dir === "short" ? t.o <= T_prev(t) : t.o >= T_prev(t)));
  function T_prev(t) { const i = etf.findIndex((b) => b.date === t.date); return etf[i - 1].c; }
}

console.log("\n--- 紙上運用の累計(2026-10-13 開始、採点リプレイ) ---");
{
  const perf = readJson(path.join(DATA_DIR, "performance.json"), null); const j = readJson(path.join(DATA_DIR, "journal.json"), { entries: [] });
  if (!perf) console.log("performance.json なし(先に plan.mjs --score --replay-from=2026-10-13 を実行)");
  else { console.log(`資産 ${perf.equity_yen.toLocaleString("ja-JP")} 円(開始 ${perf.capital.toLocaleString("ja-JP")} 円) ${perf.days} 営業日 取引 ${perf.trades} 回 勝率 ${perf.win_rate == null ? "—" : (perf.win_rate * 100).toFixed(0) + "%"}`);
    for (const e of j.entries) console.log(`${e.date}  ${e.verdict}  ${e.results.map((r) => `${r.direction} ${r.exit} ${pct(r.ret)} ${yen(r.pnl_yen)} 円`).join(" / ") || ""}`); }
}
