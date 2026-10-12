/**
 * オフライン検証用の合成データ。
 * 米国要因 → 日本株のギャップ(寄り付き)に強く反映され、寄り後(日中)はギャップの一部を戻す、
 * という実際の市場に近い構造にしてある(= 単純な順張りでは日中に稼ぎにくい)。
 */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { const u = Math.max(r(), 1e-9), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function bizDates(n, start = new Date(Date.UTC(2025, 0, 6))) {
  const out = []; const d = new Date(start);
  while (out.length < n) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
export function makeSynthetic(universe, { days = 400, seed = 7 } = {}) {
  const r = rng(seed);
  const dates = bizDates(days + 1);
  const fac = {};
  const vol = { SPX: 0.009, NDX: 0.013, SOX: 0.02, USDJPY: 0.005, VIX: 0.06, NKY: 0.011 };
  const usRet = {};
  for (const k of Object.keys(universe.factors)) {
    let p = k === "USDJPY" ? 150 : k === "VIX" ? 18 : 5000; const bars = []; usRet[k] = [];
    for (let i = 0; i < dates.length; i++) {
      const ret = gauss(r) * (vol[k] || 0.01) + (k === "VIX" ? 0 : 0.0003);
      const o = p; p = p * (1 + ret); usRet[k].push(ret);
      bars.push({ date: dates[i], o, h: Math.max(o, p) * (1 + Math.abs(gauss(r)) * 0.003), l: Math.min(o, p) * (1 - Math.abs(gauss(r)) * 0.003), c: p, v: 1e6 });
    }
    fac[k] = bars;
  }
  const stocks = [];
  for (const s of universe.stocks) {
    const beta = Object.fromEntries(s.factors.map((f) => [f, (f === "SOX" ? 0.6 : f === "NDX" ? 0.5 : f === "SPX" ? 0.7 : 0.3) * (0.7 + r() * 0.6)]));
    const sign = s.inverse ? -1 : 1;
    let c = 1000 + r() * 20000; const bars = []; const adrBars = [];
    for (let i = 1; i < dates.length; i++) {
      // 日本の i 日目の寄りには、米国 i-1 日目(前夜)の動きが反映される
      const us = s.factors.reduce((sum, f) => sum + beta[f] * usRet[f][i - 1], 0) * sign;
      const gap = us * 0.9 + gauss(r) * 0.006;
      const intraday = -0.25 * gap + gauss(r) * 0.011; // ギャップの一部を戻す + ノイズ
      const o = c * (1 + gap); const close = o * (1 + intraday);
      const h = Math.max(o, close) * (1 + Math.abs(gauss(r)) * 0.006), l = Math.min(o, close) * (1 - Math.abs(gauss(r)) * 0.006);
      bars.push({ date: dates[i], o, h, l, c: close, v: 1e6 });
      if (s.adr) {
        // ADR は前夜(日本の i-1 日の日付)の米国時間に取引され、東京の i 日の寄りをほぼ織り込む
        const fx = fac.USDJPY[i - 1].c;
        const implied = o * (1 + gauss(r) * 0.004);
        const adrPx = (implied * s.adr.ratio) / fx;
        adrBars.push({ date: dates[i - 1], o: adrPx, h: adrPx * 1.005, l: adrPx * 0.995, c: adrPx, v: 1e5 });
      }
      c = close;
    }
    stocks.push({ ...s, bars, adrBars: s.adr ? adrBars : null });
  }
  return { factors: fac, futures: null, stocks };
}
