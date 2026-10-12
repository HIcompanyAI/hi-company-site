/**
 * 日足 OHLC の取得とキャッシュ。stooq(無料・キー不要)→ Yahoo Finance の順に試す。
 * 返り値: [{date:"YYYY-MM-DD", o,h,l,c,v}] 昇順
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText, readJson, writeJson, log, sleep } from "./util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.JPD_DATA_DIR || path.resolve(here, "..", "..", "data");
const CACHE = path.join(DATA_DIR, "prices");
const STALE_MS = 10 * 3600 * 1000;

function parseStooq(csv) {
  const out = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const [d, o, h, l, c, v] = line.split(",");
    const bar = { date: d, o: +o, h: +h, l: +l, c: +c, v: +(v || 0) };
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && bar.c > 0 && bar.o > 0) out.push(bar);
  }
  return out;
}
async function fromStooq(sym) {
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`);
  const bars = parseStooq(csv);
  if (bars.length < 30) throw new Error(`stooq ${sym}: ${bars.length} rows`);
  return bars;
}
async function fromYahoo(sym) {
  const j = JSON.parse(await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3y&interval=1d`));
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) throw new Error(`yahoo ${sym}: empty`);
  const out = [];
  r.timestamp.forEach((t, i) => {
    if (q.open[i] && q.close[i]) {
      const d = new Date(t * 1000).toISOString().slice(0, 10);
      out.push({ date: d, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 });
    }
  });
  if (out.length < 30) throw new Error(`yahoo ${sym}: ${out.length} rows`);
  return out;
}

/** spec: {key, stooq?, yahoo?} */
export async function loadSeries(spec, { offline = false } = {}) {
  const file = path.join(CACHE, `${spec.key}.json`);
  const cached = readJson(file, null);
  const fresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < STALE_MS;
  if (offline || fresh) {
    if (cached) return cached.bars;
    if (offline) throw new Error(`no cache for ${spec.key}`);
  }
  const attempts = [];
  if (spec.stooq) attempts.push(["stooq", () => fromStooq(spec.stooq)]);
  if (spec.yahoo) attempts.push(["yahoo", () => fromYahoo(spec.yahoo)]);
  const errors = [];
  for (const [name, fn] of attempts) {
    try {
      const bars = await fn();
      writeJson(file, { key: spec.key, source: name, fetched_at: new Date().toISOString(), bars });
      await sleep(120);
      return bars;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  if (cached) { log(`${spec.key}: fetch failed (${errors.join("; ")}) → stale cache`); return cached.bars; }
  throw new Error(`${spec.key}: ${errors.join("; ")}`);
}

/** 銘柄ユニバース全体を読み込む */
export async function loadAll(universe, opts = {}) {
  const factors = {};
  for (const [k, f] of Object.entries(universe.factors)) {
    try { factors[k] = await loadSeries({ key: `factor_${k}`, ...f }, opts); }
    catch (e) { log(`factor ${k} unavailable: ${e.message}`); }
  }
  let futures = null;
  if (universe.nikkei_futures) {
    try { futures = await loadSeries({ key: "nikkei_futures", ...universe.nikkei_futures }, opts); } catch (e) { log(`futures unavailable: ${e.message}`); }
  }
  const stocks = [];
  for (const s of universe.stocks) {
    try {
      const bars = await loadSeries({ key: `jp_${s.code}`, stooq: `${s.code}.jp`, yahoo: `${s.code}.T` }, opts);
      let adr = null;
      if (s.adr) { try { adr = await loadSeries({ key: `adr_${s.code}`, ...s.adr }, opts); } catch (e) { log(`${s.code} ADR unavailable: ${e.message}`); } }
      stocks.push({ ...s, bars, adrBars: adr });
    } catch (e) { log(`${s.code} unavailable: ${e.message}`); }
  }
  return { factors, futures, stocks };
}
