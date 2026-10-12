#!/usr/bin/env node
/**
 * 日次バッチ本体。
 *   node run.mjs                 通常実行(取得 → 分析 → data/ 更新)
 *   node run.mjs --fetch-only    投稿の取得・保存のみ(API キー不要)
 *   node run.mjs --sample        fixtures のサンプル投稿を使う(ネット不要。API キーが無ければサンプル分析を使う)
 *   オプション: --date=YYYY-MM-DD --window-days=7 --no-quotes
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTrumpPosts } from "./lib/truth.mjs";
import { fetchXPosts } from "./lib/x.mjs";
import { fetchQuotes } from "./lib/prices.mjs";
import { analyze, MODEL } from "./lib/analyze.mjs";
import { readJson, writeJson, log, ymd, extractCashtags } from "./lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(here, "..", "data");
const FIXTURES = path.resolve(here, "fixtures");
const X_USERNAME = process.env.X_USERNAME || "aleabitoreddit";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DATE = args.date || ymd();
const WINDOW_DAYS = Number(args["window-days"] || process.env.WINDOW_DAYS || 7);
const SAMPLE = Boolean(args.sample);
const FETCH_ONLY = Boolean(args["fetch-only"]);

async function main() {
  const startedAt = new Date().toISOString();
  const store = readJson(path.join(DATA, "posts.json"), { posts: {}, updated_at: null });
  const sourceStatus = {};
  // 本番実行ではサンプル投稿を捨てる
  if (!SAMPLE) for (const k of Object.keys(store.posts)) if (k.includes(":sample-")) delete store.posts[k];

  // 1. 取得
  let fetched;
  if (SAMPLE) {
    const sample = readJson(path.join(FIXTURES, "sample-posts.json"), []);
    fetched = {
      trump: { posts: sample.filter((p) => p.source === "trump"), via: "sample", errors: [] },
      serenity: { posts: sample.filter((p) => p.source === "serenity"), via: "sample", errors: [] },
    };
  } else {
    const [trump, serenity] = await Promise.all([fetchTrumpPosts(), fetchXPosts(X_USERNAME)]);
    fetched = { trump, serenity };
  }

  // 2. 保存(重複排除・新着判定)
  const nowIso = new Date().toISOString();
  const windowStart = Date.now() - WINDOW_DAYS * 86400 * 1000;
  for (const [name, r] of Object.entries(fetched)) {
    let newCount = 0;
    for (const p of r.posts) {
      if (!p.key || !p.created_at) continue;
      if (!store.posts[p.key]) {
        store.posts[p.key] = { ...p, first_seen_at: nowIso };
        newCount++;
      } else {
        store.posts[p.key] = { ...store.posts[p.key], ...p, first_seen_at: store.posts[p.key].first_seen_at };
      }
    }
    sourceStatus[name] = { via: r.via, fetched: r.posts.length, new_count: newCount, errors: r.errors, count: 0 };
  }
  // 90 日より古い投稿は捨てる
  const keep = Date.now() - 90 * 86400 * 1000;
  for (const [k, p] of Object.entries(store.posts)) if (new Date(p.created_at).getTime() < keep) delete store.posts[k];
  store.updated_at = nowIso;
  writeJson(path.join(DATA, "posts.json"), store);

  // 3. 分析対象(期間内 or 直近 48h に初めて見つかった投稿)
  let prior = readJson(path.join(DATA, "latest.json"), null);
  if (prior?.sample && !SAMPLE) prior = null; // サンプル分析は前日データとして使わない
  const lastRun = prior?.generated_at ? new Date(prior.generated_at).getTime() : 0;
  const windowPosts = Object.values(store.posts)
    .filter((p) => new Date(p.created_at).getTime() >= windowStart || new Date(p.first_seen_at).getTime() >= Date.now() - 2 * 86400 * 1000)
    .map((p) => ({ ...p, is_new: new Date(p.first_seen_at).getTime() > lastRun }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const name of Object.keys(sourceStatus)) sourceStatus[name].count = windowPosts.filter((p) => p.source === name).length;
  log(`window: ${windowPosts.length} posts (trump ${sourceStatus.trump.count}, serenity ${sourceStatus.serenity.count})`);

  const status = { last_run_at: startedAt, date: DATE, sources: sourceStatus, window_days: WINDOW_DAYS, sample: SAMPLE, ok: null, error: null };

  if (FETCH_ONLY) {
    status.ok = true;
    writeJson(path.join(DATA, "status.json"), status);
    log("fetch-only: done");
    return;
  }

  // 4. 株価(任意)
  let quotes = {};
  if (!args["no-quotes"] && !SAMPLE) {
    const tickers = new Set();
    for (const p of windowPosts) for (const t of extractCashtags(p.text)) tickers.add(t);
    for (const r of prior?.analysis?.recommendations || []) tickers.add(r.ticker);
    try {
      quotes = await fetchQuotes([...tickers]);
    } catch (e) {
      log(`quotes failed: ${e.message}`);
    }
  }

  // 5. 分析
  let analysis, usage, model, isSample = false;
  if (windowPosts.length === 0) {
    status.ok = false;
    status.error = "no posts available in window";
    writeJson(path.join(DATA, "status.json"), status);
    throw new Error(status.error);
  }
  if (!process.env.ANTHROPIC_API_KEY && SAMPLE) {
    analysis = readJson(path.join(FIXTURES, "sample-analysis.json"), null);
    if (!analysis) throw new Error("fixtures/sample-analysis.json missing");
    model = "sample";
    isSample = true;
    log("analyze: no ANTHROPIC_API_KEY → using fixtures/sample-analysis.json");
  } else {
    try {
      ({ analysis, usage, model } = await analyze({ date: DATE, posts: windowPosts, prior, quotes, sourceStatus }));
    } catch (e) {
      status.ok = false;
      status.error = `analysis failed: ${e.message}`;
      writeJson(path.join(DATA, "status.json"), status);
      throw e;
    }
  }

  // 6. レポート書き出し
  const report = {
    date: DATE,
    generated_at: new Date().toISOString(),
    model,
    sample: isSample || SAMPLE,
    window_days: WINDOW_DAYS,
    sources: sourceStatus,
    quotes,
    analysis,
    posts: windowPosts.map((p) => ({ key: p.key, source: p.source, author: p.author, created_at: p.created_at, url: p.url, is_new: p.is_new, text: (p.text || "").slice(0, 700) })),
    usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 } : null,
  };
  writeJson(path.join(DATA, "history", `${DATE}.json`), report);
  writeJson(path.join(DATA, "latest.json"), report);

  const indexFile = path.join(DATA, "history", "index.json");
  let index = readJson(indexFile, []).filter((e) => e.date !== DATE);
  if (!report.sample) {
    // 本番データが出来たらサンプル履歴は消す
    for (const e of index.filter((e) => e.sample)) fs.rmSync(path.join(DATA, "history", `${e.date}.json`), { force: true });
    index = index.filter((e) => !e.sample);
  }
  index.unshift({
    date: DATE,
    headline_ja: analysis.headline_ja,
    overall_stance: analysis.overall_stance,
    buy: analysis.recommendations.filter((r) => r.action === "BUY").length,
    sell: analysis.recommendations.filter((r) => r.action === "SELL" || r.action === "AVOID").length,
    total: analysis.recommendations.length,
    sample: report.sample,
  });
  index.sort((a, b) => (a.date < b.date ? 1 : -1));
  writeJson(indexFile, index.slice(0, 400));

  status.ok = true;
  status.model = model;
  writeJson(path.join(DATA, "status.json"), status);
  log(`done: ${DATE} ${analysis.headline_ja} (${analysis.recommendations.length} recommendations)`);
}

main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});
