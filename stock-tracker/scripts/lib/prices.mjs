/**
 * 株価の参考情報(任意)。取れなくても処理は止めない。
 *   1. stooq.com CSV (キー不要)   2. Yahoo Finance chart API
 */
import { fetchText, fetchJson, log, sleep } from "./util.mjs";

function stooqSymbol(ticker) {
  if (ticker.includes(".")) {
    const [sym, ex] = ticker.split(".");
    const map = { L: "uk", PA: "fr", DE: "de", T: "jp", TO: "ca", HK: "hk", AS: "nl", MI: "it" };
    return `${sym}.${map[ex] || ex.toLowerCase()}`.toLowerCase();
  }
  return `${ticker}.us`.toLowerCase();
}

async function fromStooq(ticker) {
  const csv = await fetchText(`https://stooq.com/q/l/?s=${stooqSymbol(ticker)}&f=sd2t2ohlcv&h&e=csv`);
  const lines = csv.trim().split("\n");
  if (lines.length < 2) throw new Error("no rows");
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  const open = Number(cols[3]);
  if (!Number.isFinite(close) || close === 0) throw new Error("N/D");
  return { price: close, change_pct: open ? ((close - open) / open) * 100 : null, asof: cols[1], provider: "stooq" };
}

async function fromYahoo(ticker) {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`);
  const r = j?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta?.regularMarketPrice) throw new Error("no price");
  const prev = meta.chartPreviousClose || meta.previousClose;
  return {
    price: meta.regularMarketPrice,
    change_pct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : null,
    currency: meta.currency,
    asof: new Date((meta.regularMarketTime || 0) * 1000).toISOString().slice(0, 10),
    provider: "yahoo",
  };
}

export async function fetchQuotes(tickers = []) {
  const out = {};
  for (const t of [...new Set(tickers)].slice(0, 40)) {
    try {
      out[t] = await fromStooq(t);
    } catch (e1) {
      try {
        out[t] = await fromYahoo(t);
      } catch (e2) {
        log(`quote ${t}: unavailable (${e1.message}; ${e2.message})`);
      }
    }
    await sleep(150);
  }
  return out;
}
