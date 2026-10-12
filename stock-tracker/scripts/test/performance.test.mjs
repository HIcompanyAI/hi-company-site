import { test } from "node:test";
import assert from "node:assert/strict";
import { computePerformance, summarizeForPrompt } from "../lib/performance.mjs";

// 30 営業日分の日付
const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10));
const mk = (start, step) => Object.fromEntries(days.map((d, i) => [d, start + step * i]));
const prices = { tickers: { UP: mk(100, 1), DOWN: mk(100, -1), SPY: mk(500, 0.5) } };
const reports = [
  { date: days[0], analysis: { recommendations: [
    { ticker: "UP", action: "BUY", source: "serenity", conviction: 3 },
    { ticker: "DOWN", action: "BUY", source: "trump", conviction: 2 },
    { ticker: "DOWN", action: "WATCH", source: "citrini", conviction: 2 },
  ] } },
  { date: days[2], analysis: { recommendations: [{ ticker: "DOWN", action: "SELL", source: "citrini", conviction: 4 }] } },
  { date: days[1], sample: true, analysis: { recommendations: [{ ticker: "UP", action: "BUY", source: "trump", conviction: 5 }] } },
];

test("hit rates per horizon and source", () => {
  const p = computePerformance({ reports, prices });
  assert.equal(p.graded_recommendations, 3); // WATCH と sample は除外
  assert.equal(p.overall[5].n, 3);
  assert.equal(p.overall[5].hits, 2); // UP BUY ○, DOWN BUY ×, DOWN SELL ○
  assert.equal(p.overall[20].n, 3);
  assert.equal(p.overall[60].n, 0); // データ不足
  assert.equal(p.by_source.trump[5].hit_rate, 0);
  assert.equal(p.by_source.citrini[5].hit_rate, 1);
  assert.ok(p.by_source.serenity[20].avg_ret > 0.19);
});

test("paper portfolio buys BUY recs and holds 20 days", () => {
  const p = computePerformance({ reports, prices });
  assert.equal(p.paper.start, 10000);
  assert.equal(p.paper.closed_trades, 2);
  assert.equal(p.paper.win_rate, 0.5);
  // UP: +20%, DOWN: -20% を各 1,000 円 → 合計はほぼ 10,000 円
  assert.ok(Math.abs(p.paper.value - 10000) < 5, String(p.paper.value));
  assert.equal(p.paper.benchmark.ticker, "SPY");
  assert.ok(p.paper.benchmark.value > 10000);
});

test("prompt summary appears only with enough samples", () => {
  const p = computePerformance({ reports, prices });
  assert.equal(summarizeForPrompt(p), null);
  assert.match(summarizeForPrompt(p, 1), /全体\(20 営業日\): 3 件, 的中率 67%/);
});
