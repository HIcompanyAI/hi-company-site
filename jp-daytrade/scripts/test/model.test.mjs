import { test } from "node:test";
import assert from "node:assert/strict";
import { ridge, corr } from "../lib/util.mjs";
import { makeSynthetic } from "../lib/synthetic.mjs";
import { alignStock, featureNames, fit, latestFeatures, signal } from "../lib/model.mjs";
import { runBacktest, tradeOutcome } from "../lib/backtest.mjs";
import fs from "node:fs";
const universe = JSON.parse(fs.readFileSync(new URL("../lib/universe.json", import.meta.url)));

test("ridge recovers a linear relation", () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) { const a = Math.sin(i) , b = Math.cos(i * 1.3); X.push([a, b]); y.push(0.5 + 2 * a - 1 * b); }
  const m = ridge(X, y, 1e-6);
  assert.ok(Math.abs(m.coef[0] - 2) < 0.01 && Math.abs(m.coef[1] + 1) < 0.01 && Math.abs(m.intercept - 0.5) < 0.01);
});

test("trade outcome rules (conservative tie → stop)", () => {
  const P = { target: 0.015, stop: 0.01, cost: 0 };
  assert.deepEqual(tradeOutcome({ o: 100, h: 102, l: 99.5, c: 101 }, "long", P), { ret: 0.015, exit: "target" });
  assert.deepEqual(tradeOutcome({ o: 100, h: 102, l: 98.9, c: 101 }, "long", P), { ret: -0.01, exit: "stop" });
  assert.equal(tradeOutcome({ o: 100, h: 100.5, l: 99.5, c: 100.8 }, "long", P).exit, "close");
  assert.deepEqual(tradeOutcome({ o: 100, h: 100.5, l: 98.4, c: 99 }, "short", P), { ret: 0.015, exit: "target" });
  assert.deepEqual(tradeOutcome({ o: 100, h: 101.1, l: 98, c: 99 }, "short", P), { ret: -0.01, exit: "stop" });
});

test("alignment uses previous-night US move and ADR implied gap", () => {
  const data = makeSynthetic(universe, { days: 300, seed: 3 });
  const s = data.stocks.find((x) => x.code === "7203");
  const rows = alignStock(s, data.factors, data.factors.USDJPY);
  assert.ok(rows.length > 250);
  assert.ok(rows.every((r) => r.feats.SPX != null && r.feats.USDJPY != null && r.adrGap != null));
  // 合成データではギャップは米国要因でほぼ説明できる
  const m = fit(rows, featureNames(s));
  assert.ok(m.gapR > 0.5, `gapR=${m.gapR}`);
  const lf = latestFeatures(s, data.factors, data.factors.USDJPY, s.bars[s.bars.length - 2].date);
  assert.ok(lf && lf.adrImplied > 0);
  const sg = signal(s, m, lf.feats);
  assert.ok(["long", "short"].includes(sg.direction));
});

test("walk-forward backtest runs and reports target-hit probability", () => {
  const data = makeSynthetic(universe, { days: 320, seed: 11 });
  const r = runBacktest(data, { warmup: 100, refitEvery: 20 }, "model");
  assert.ok(r.days > 150 && r.trades > 100);
  assert.ok(r.target_hit_rate >= 0 && r.target_hit_rate <= 1);
  assert.ok(r.p_day_ge_target != null && r.curve.length > 10 && r.bench_curve.length > 10);
  const f = runBacktest(data, { warmup: 100, refitEvery: 20 }, "fade");
  assert.ok(f.trades > 100);
});
