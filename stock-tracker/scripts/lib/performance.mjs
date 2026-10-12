/**
 * 前向き検証: 過去の推奨を、その後の株価で採点する。
 *  - 的中: BUY は上昇、SELL/AVOID は下落(WATCH/HOLD は採点しない)
 *  - 期間: 5 / 20 / 60 営業日
 *  - 仮想運用: 1 万円スタート。各 BUY 推奨に資金の 10% を投じ、20 営業日後に売る(同一銘柄の重複買いはしない)
 */
export const HORIZONS = [5, 20, 60];
export const PAPER_START = 10000;
export const PAPER_HOLD_DAYS = 20;
export const PAPER_FRACTION = 0.1;

function series(prices, ticker) {
  const m = prices?.tickers?.[ticker];
  if (!m) return [];
  return Object.entries(m).map(([d, p]) => [d, Number(p)]).filter(([, p]) => Number.isFinite(p) && p > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 推奨日以降で最初の終値(3 日以内)とその位置 */
function entryFor(ser, date) {
  const i = ser.findIndex(([d]) => d >= date);
  if (i < 0) return null;
  const gap = (new Date(ser[i][0]) - new Date(date)) / 86400000;
  if (gap > 4) return null;
  return { index: i, date: ser[i][0], price: ser[i][1] };
}

export function computePerformance({ reports, prices, benchmark = "SPY" }) {
  const trades = [];
  for (const r of reports) {
    if (r.sample) continue;
    for (const rec of r.analysis?.recommendations || []) {
      const dir = rec.action === "BUY" ? 1 : rec.action === "SELL" || rec.action === "AVOID" ? -1 : 0;
      const ser = series(prices, rec.ticker);
      const entry = entryFor(ser, r.date);
      const t = { date: r.date, ticker: rec.ticker, action: rec.action, source: rec.source, conviction: rec.conviction, direction: dir, entry: entry?.price ?? null, entry_date: entry?.date ?? null, returns: {} };
      if (entry) {
        for (const h of HORIZONS) {
          const row = ser[entry.index + h];
          if (row) {
            const ret = (row[1] - entry.price) / entry.price;
            t.returns[h] = { date: row[0], ret, hit: dir === 0 ? null : dir * ret > 0 };
          }
        }
        const last = ser[ser.length - 1];
        t.latest = { date: last[0], ret: (last[1] - entry.price) / entry.price, days: ser.length - 1 - entry.index };
      }
      trades.push(t);
    }
  }

  const agg = () => Object.fromEntries(HORIZONS.map((h) => [h, { n: 0, hits: 0, sum_ret: 0 }]));
  const overall = agg();
  const bySource = {};
  const byAction = {};
  for (const t of trades) {
    if (t.direction === 0) continue;
    for (const h of HORIZONS) {
      const r = t.returns[h];
      if (!r) continue;
      for (const bucket of [overall, (bySource[t.source] ||= agg()), (byAction[t.action] ||= agg())]) {
        bucket[h].n++;
        bucket[h].hits += r.hit ? 1 : 0;
        bucket[h].sum_ret += t.direction * r.ret;
      }
    }
  }
  const finish = (b) => Object.fromEntries(Object.entries(b).map(([h, v]) => [h, { n: v.n, hits: v.hits, hit_rate: v.n ? v.hits / v.n : null, avg_ret: v.n ? v.sum_ret / v.n : null }]));

  // 仮想運用(BUY のみ)
  let equity = PAPER_START;
  let cash = PAPER_START;
  const open = [];
  const closed = [];
  const buys = trades.filter((t) => t.action === "BUY" && t.entry).sort((a, b) => (a.entry_date < b.entry_date ? -1 : 1));
  const allDates = [...new Set(buys.flatMap((t) => series(prices, t.ticker).map(([d]) => d)))].sort();
  const held = new Set();
  for (const d of allDates) {
    // 売却
    for (const pos of [...open]) {
      const ser = series(prices, pos.ticker);
      const idx = ser.findIndex(([x]) => x === d);
      if (idx >= 0 && idx >= pos.index + PAPER_HOLD_DAYS) {
        const exit = ser[idx][1];
        cash += pos.shares * exit;
        closed.push({ ...pos, exit_date: d, exit, ret: (exit - pos.price) / pos.price });
        open.splice(open.indexOf(pos), 1);
        held.delete(pos.ticker);
      }
    }
    // 購入
    for (const t of buys.filter((t) => t.entry_date === d)) {
      if (held.has(t.ticker)) continue;
      const ser = series(prices, t.ticker);
      const index = ser.findIndex(([x]) => x === d);
      const amount = Math.min(cash, equityAt(d) * PAPER_FRACTION);
      if (amount <= 0) continue;
      cash -= amount;
      open.push({ ticker: t.ticker, date: t.date, entry_date: d, index, price: t.entry, shares: amount / t.entry, source: t.source });
      held.add(t.ticker);
    }
  }
  function equityAt(d) {
    let v = cash;
    for (const pos of open) {
      const ser = series(prices, pos.ticker);
      const row = [...ser].reverse().find(([x]) => x <= d);
      v += pos.shares * (row ? row[1] : pos.price);
    }
    return v;
  }
  const lastDate = allDates[allDates.length - 1] || null;
  equity = lastDate ? equityAt(lastDate) : PAPER_START;

  // ベンチマーク(最初の売買日から同期間の保有)
  let bench = null;
  const bser = series(prices, benchmark);
  if (buys.length && bser.length) {
    const start = entryFor(bser, buys[0].entry_date);
    const end = bser[bser.length - 1];
    if (start) bench = { ticker: benchmark, start_date: start.date, end_date: end[0], value: PAPER_START * (end[1] / start.price) };
  }

  return {
    computed_at: new Date().toISOString(),
    horizons: HORIZONS,
    rules: { paper_start: PAPER_START, hold_days: PAPER_HOLD_DAYS, fraction: PAPER_FRACTION },
    graded_recommendations: trades.filter((t) => t.direction !== 0 && t.entry).length,
    overall: finish(overall),
    by_source: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, finish(v)])),
    by_action: Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, finish(v)])),
    paper: { start: PAPER_START, value: Math.round(equity), as_of: lastDate, open_positions: open.length, closed_trades: closed.length, win_rate: closed.length ? closed.filter((c) => c.ret > 0).length / closed.length : null, benchmark: bench ? { ...bench, value: Math.round(bench.value) } : null },
    trades: trades.slice(-500),
  };
}

/** 分析プロンプト用の短い要約(採点数が少ないうちは null) */
export function summarizeForPrompt(perf, minN = 10) {
  if (!perf) return null;
  const lines = [];
  const o = perf.overall?.[20];
  if (!o || o.n < minN) return null;
  lines.push(`全体(20 営業日): ${o.n} 件, 的中率 ${(o.hit_rate * 100).toFixed(0)}%, 平均リターン ${(o.avg_ret * 100).toFixed(1)}%`);
  for (const [src, v] of Object.entries(perf.by_source || {})) {
    const s = v[20];
    if (s?.n >= 5) lines.push(`- ${src}: ${s.n} 件, 的中率 ${(s.hit_rate * 100).toFixed(0)}%, 平均 ${(s.avg_ret * 100).toFixed(1)}%`);
  }
  if (perf.paper?.closed_trades) lines.push(`仮想運用(1 万円, BUY を 20 営業日保有): 現在 ${perf.paper.value} 円${perf.paper.benchmark ? ` / 同期間 ${perf.paper.benchmark.ticker} 保有なら ${perf.paper.benchmark.value} 円` : ""}`);
  return lines.join("\n");
}
