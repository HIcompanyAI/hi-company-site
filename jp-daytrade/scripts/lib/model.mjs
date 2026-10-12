/**
 * 米国要因と日本株の整列・回帰・シグナル生成。
 *  行 = 日本の 1 営業日。特徴量 = 直前の日本営業日以降に確定した米国要因のリターン(複数日なら累積)。
 */
import { ridge, mean, std, corr } from "./util.mjs";

function lastIdxBefore(bars, date) { // date より前の最後のバー index
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].date < date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** 日本株 1 銘柄分の学習用テーブルを作る */
export function alignStock(stock, factors, fxBars) {
  const rows = [];
  const bars = stock.bars;
  for (let j = 1; j < bars.length; j++) {
    const prev = bars[j - 1], cur = bars[j];
    const feats = {};
    let ok = true;
    for (const f of stock.factors) {
      const fb = factors[f]; if (!fb) { ok = false; break; }
      const a = lastIdxBefore(fb, cur.date), b = lastIdxBefore(fb, prev.date);
      if (a < 1 || b < 0 || a === b) { ok = false; break; }
      feats[f] = fb[a].c / fb[b].c - 1;
    }
    if (!ok) continue;
    let adrGap = null;
    if (stock.adrBars && fxBars) {
      const ai = lastIdxBefore(stock.adrBars, cur.date), fi = lastIdxBefore(fxBars, cur.date);
      if (ai >= 0 && fi >= 0 && stock.adrBars[ai].date >= prev.date) {
        const implied = (stock.adrBars[ai].c * fxBars[fi].c) / stock.adr.ratio;
        adrGap = implied / prev.c - 1;
        feats.ADR = adrGap;
      }
    }
    rows.push({ date: cur.date, o: cur.o, h: cur.h, l: cur.l, c: cur.c, prevClose: prev.c, gap: cur.o / prev.c - 1, intraday: cur.c / cur.o - 1, cc: cur.c / prev.c - 1, feats, adrGap });
  }
  return rows;
}

export function featureNames(stock) { return [...stock.factors, ...(stock.adr ? ["ADR"] : [])]; }

/** 学習: 行の配列 → {gapModel, intradayModel, stats} */
export function fit(rows, names, { window = 250, lambda = 0.05 } = {}) {
  const use = rows.filter((r) => names.every((n) => r.feats[n] != null)).slice(-window);
  if (use.length < 60) return null;
  const X = use.map((r) => names.map((n) => r.feats[n]));
  const gapM = ridge(X, use.map((r) => r.gap), lambda);
  const intM = ridge(X, use.map((r) => r.intraday), lambda);
  const predInt = use.map((r, i) => predict(intM, X[i]));
  const resid = use.map((r, i) => r.intraday - predInt[i]);
  const predGap = use.map((r, i) => predict(gapM, X[i]));
  return {
    names, gapM, intM, n: use.length,
    gapR: corr(predGap, use.map((r) => r.gap)),
    intR: corr(predInt, use.map((r) => r.intraday)),
    residStd: std(resid) || 0.01,
    intradayStd: std(use.map((r) => r.intraday)) || 0.01,
    gapStd: std(use.map((r) => r.gap)) || 0.01,
  };
}
export const predict = (m, x) => m.intercept + m.coef.reduce((s, c, i) => s + c * x[i], 0);

/** 直近の米国要因(最後の日本営業日より後に確定した分)を特徴量にする */
export function latestFeatures(stock, factors, fxBars, lastJpDate) {
  const feats = {}; const detail = {};
  for (const f of stock.factors) {
    const fb = factors[f]; if (!fb) return null;
    const last = fb[fb.length - 1];
    const b = lastIdxBefore(fb, lastJpDate);
    if (b < 0 || last.date < lastJpDate) return null; // 米国分がまだ無い(休場など)
    feats[f] = last.c / fb[b].c - 1; detail[f] = { from: fb[b].date, to: last.date, ret: feats[f] };
  }
  let adrImplied = null;
  if (stock.adrBars && fxBars) {
    const a = stock.adrBars[stock.adrBars.length - 1], fx = fxBars[fxBars.length - 1];
    if (a.date >= lastJpDate) {
      adrImplied = (a.c * fx.c) / stock.adr.ratio;
      feats.ADR = adrImplied / stock.bars[stock.bars.length - 1].c - 1;
      detail.ADR = { adr_close: a.c, fx: fx.c, implied_jpy: adrImplied, date: a.date };
    }
  }
  return { feats, detail, adrImplied };
}

/** 1 銘柄のシグナル */
export function signal(stock, model, feats) {
  if (!model) return null;
  const x = model.names.map((n) => feats[n]);
  if (x.some((v) => v == null)) return null;
  const predGap = predict(model.gapM, x), predInt = predict(model.intM, x);
  const score = predInt / model.residStd; // t 値風
  return { predGap, predInt, score, direction: predInt >= 0 ? "long" : "short", confidence: Math.max(0, model.intR) };
}
