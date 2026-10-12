#!/usr/bin/env node
/**
 * 日次バッチ本体。3 つの使い方がある。
 *
 *  A) API 方式(ANTHROPIC_API_KEY あり)
 *     node run.mjs                      取得 → Claude API で分析 → data/ 更新
 *
 *  B) Routine 方式(Claude Code の定期実行で分析。API キー不要)
 *     node run.mjs --fetch-only         投稿と株価を取得して保存(GitHub Actions が毎朝実行)
 *     node run.mjs --prepare            分析用の入力 data/pending/{input.md,context.json,schema.json} を作る
 *     (Claude Code が input.md を読んで data/pending/analysis.json を書く)
 *     node run.mjs --finalize           analysis.json をスキーマ検証して latest/history/status を更新
 *
 *  C) 動作確認
 *     node run.mjs --sample             fixtures のサンプル投稿を使う(ネット不要)
 *
 *     node run.mjs --perf               過去の推奨を株価で採点し data/performance.json を更新
 *
 *  共通オプション: --date=YYYY-MM-DD --window-days=7 --no-quotes --model=<表示用ラベル>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTrumpPosts } from "./lib/truth.mjs";
import { fetchXPosts } from "./lib/x.mjs";
import { fetchQuotes } from "./lib/prices.mjs";
import { SOURCES, SOURCE_IDS } from "./lib/sources.mjs";
import { computePerformance, summarizeForPrompt } from "./lib/performance.mjs";
import { analyze, buildUserMessage, AnalysisSchema, SYSTEM_PROMPT, MODEL } from "./lib/analyze.mjs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readJson, writeJson, log, ymd, extractCashtags } from "./lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(here, "..", "data");
const PENDING = path.join(DATA, "pending");
const FIXTURES = path.resolve(here, "fixtures");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DATE = args.date || ymd();
const WINDOW_DAYS = Number(args["window-days"] || process.env.WINDOW_DAYS || 7);
const SAMPLE = Boolean(args.sample);
const MODE = args["fetch-only"] ? "fetch" : args.prepare ? "prepare" : args.finalize ? "finalize" : args.perf ? "perf" : "full";
const BENCHMARK = process.env.BENCHMARK_TICKER || "SPY";

const storeFile = path.join(DATA, "posts.json");
const quotesFile = path.join(DATA, "quotes.json");
const pricesFile = path.join(DATA, "prices.json");
const perfFile = path.join(DATA, "performance.json");
const statusFile = path.join(DATA, "status.json");

/* ---------- 取得 ---------- */
async function fetchAndStore() {
  const store = readJson(storeFile, { posts: {}, updated_at: null });
  if (!SAMPLE) for (const k of Object.keys(store.posts)) if (k.includes(":sample-")) delete store.posts[k];

  const fetched = {};
  if (SAMPLE) {
    const sample = readJson(path.join(FIXTURES, "sample-posts.json"), []);
    for (const src of SOURCES) fetched[src.id] = { posts: sample.filter((p) => p.source === src.id), via: "sample", errors: [] };
  } else {
    const results = await Promise.all(SOURCES.map((src) => (src.kind === "truth" ? fetchTrumpPosts() : fetchXPosts(src.username, { id: src.id, author: src.author }))));
    SOURCES.forEach((src, i) => (fetched[src.id] = results[i]));
  }

  const nowIso = new Date().toISOString();
  const sourceStatus = {};
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
    sourceStatus[name] = { via: r.via, fetched: r.posts.length, new_count: newCount, errors: r.errors, fetched_at: nowIso };
  }
  const keep = Date.now() - 90 * 86400 * 1000;
  for (const [k, p] of Object.entries(store.posts)) if (new Date(p.created_at).getTime() < keep) delete store.posts[k];
  store.updated_at = nowIso;
  store.last_fetch = sourceStatus;
  writeJson(storeFile, store);
  log(`store: ${Object.keys(store.posts).length} posts (` + SOURCES.map((s) => `${s.id} new ${sourceStatus[s.id].new_count}`).join(", ") + ")");

  // 株価(任意): 期間内の $ティッカー + 過去 100 日の推奨銘柄 + ベンチマーク
  if (!args["no-quotes"] && !SAMPLE) {
    const prior = readJson(path.join(DATA, "latest.json"), null);
    const tickers = new Set([BENCHMARK]);
    for (const p of windowPosts(store, prior)) for (const t of extractCashtags(p.text)) tickers.add(t);
    for (const r of recentReports(100)) for (const rec of r.analysis?.recommendations || []) tickers.add(rec.ticker);
    try {
      const quotes = await fetchQuotes([...tickers]);
      writeJson(quotesFile, { fetched_at: nowIso, quotes });
      log(`quotes: ${Object.keys(quotes).length}/${tickers.size}`);
      // 終値の履歴を蓄積(前向き検証用)
      const prices = readJson(pricesFile, { tickers: {} });
      for (const [t, q] of Object.entries(quotes)) {
        const d = q.asof || nowIso.slice(0, 10);
        (prices.tickers[t] ||= {})[d] = q.price;
      }
      const cutoff = new Date(Date.now() - 400 * 86400 * 1000).toISOString().slice(0, 10);
      for (const t of Object.keys(prices.tickers)) for (const d of Object.keys(prices.tickers[t])) if (d < cutoff) delete prices.tickers[t][d];
      prices.updated_at = nowIso;
      writeJson(pricesFile, prices);
      updatePerformance();
    } catch (e) {
      log(`quotes failed: ${e.message}`);
    }
  }
  return { store, sourceStatus };
}

/* ---------- 前向き検証 ---------- */
function recentReports(days) {
  const dir = path.join(DATA, "history");
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= cutoff)
    .sort()
    .map((f) => readJson(path.join(dir, f), null))
    .filter((r) => r && !r.sample);
}

function updatePerformance() {
  const prices = readJson(pricesFile, { tickers: {} });
  const reports = recentReports(400);
  const perf = computePerformance({ reports, prices, benchmark: BENCHMARK });
  writeJson(perfFile, perf);
  log(`performance: graded ${perf.graded_recommendations}, paper ${perf.paper.value} yen`);
  return perf;
}

/* ---------- 分析対象の切り出し ---------- */
function windowPosts(store, prior) {
  const windowStart = Date.now() - WINDOW_DAYS * 86400 * 1000;
  const lastRun = prior?.generated_at ? new Date(prior.generated_at).getTime() : 0;
  return Object.values(store.posts)
    .filter((p) => new Date(p.created_at).getTime() >= windowStart || new Date(p.first_seen_at).getTime() >= Date.now() - 2 * 86400 * 1000)
    .map((p) => ({ ...p, is_new: new Date(p.first_seen_at).getTime() > lastRun }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function loadContext() {
  const store = readJson(storeFile, { posts: {}, last_fetch: {} });
  let prior = readJson(path.join(DATA, "latest.json"), null);
  if (prior?.sample && !SAMPLE) prior = null;
  const posts = windowPosts(store, prior);
  const sourceStatus = {};
  for (const name of SOURCE_IDS) {
    const f = store.last_fetch?.[name] || { via: null, errors: [{ name: "store", error: "未取得" }] };
    sourceStatus[name] = { ...f, count: posts.filter((p) => p.source === name).length };
  }
  const q = readJson(quotesFile, { quotes: {} });
  const quotes = args["no-quotes"] ? {} : q.quotes || {};
  const performance_summary = SAMPLE ? null : summarizeForPrompt(readJson(perfFile, null));
  return { date: DATE, posts, prior, quotes, sourceStatus, performance_summary, quotes_fetched_at: q.fetched_at || null };
}

/* ---------- レポート書き出し ---------- */
function validateAnalysis(raw) {
  const a = AnalysisSchema.parse(raw);
  const problems = [];
  const keys = new Set();
  for (const r of a.recommendations) {
    if (r.conviction < 1 || r.conviction > 5) problems.push(`${r.ticker}: conviction は 1〜5 (${r.conviction})`);
    if (!r.source_post_keys.length) problems.push(`${r.ticker}: source_post_keys が空`);
    if (keys.has(r.ticker)) problems.push(`${r.ticker}: 重複`);
    keys.add(r.ticker);
  }
  const digested = new Set(a.source_digests.map((d) => d.source));
  for (const id of SOURCE_IDS) if (!digested.has(id)) problems.push(`source_digests に ${id} がない`);
  if (problems.length) throw new Error("analysis.json の内容エラー:\n- " + problems.join("\n- "));
  return a;
}

function writeReport(ctx, analysis, { model, usage = null, sample = false }) {
  const report = {
    date: ctx.date,
    generated_at: new Date().toISOString(),
    model,
    sample,
    window_days: WINDOW_DAYS,
    sources: ctx.sourceStatus,
    quotes: ctx.quotes,
    analysis,
    posts: ctx.posts.map((p) => ({ key: p.key, source: p.source, author: p.author, created_at: p.created_at, url: p.url, is_new: p.is_new, text: (p.text || "").slice(0, 700) })),
    usage,
  };
  writeJson(path.join(DATA, "history", `${ctx.date}.json`), report);
  writeJson(path.join(DATA, "latest.json"), report);

  const indexFile = path.join(DATA, "history", "index.json");
  let index = readJson(indexFile, []).filter((e) => e.date !== ctx.date);
  if (!sample) {
    for (const e of index.filter((e) => e.sample)) fs.rmSync(path.join(DATA, "history", `${e.date}.json`), { force: true });
    index = index.filter((e) => !e.sample);
  }
  index.unshift({
    date: ctx.date,
    headline_ja: analysis.headline_ja,
    overall_stance: analysis.overall_stance,
    buy: analysis.recommendations.filter((r) => r.action === "BUY").length,
    sell: analysis.recommendations.filter((r) => r.action === "SELL" || r.action === "AVOID").length,
    total: analysis.recommendations.length,
    sample,
  });
  index.sort((a, b) => (a.date < b.date ? 1 : -1));
  writeJson(indexFile, index.slice(0, 400));
  writeStatus({ ok: true, model, error: null, sources: ctx.sourceStatus });
  log(`done: ${ctx.date} ${analysis.headline_ja} (${analysis.recommendations.length} recommendations)`);
}

function writeStatus(patch) {
  const prev = readJson(statusFile, {});
  writeJson(statusFile, { ...prev, last_run_at: new Date().toISOString(), date: DATE, window_days: WINDOW_DAYS, mode: MODE, sample: SAMPLE, ...patch });
}

/* ---------- main ---------- */
async function main() {
  if (MODE === "fetch") {
    const { sourceStatus } = await fetchAndStore();
    writeStatus({ fetch_ok: true, sources: sourceStatus });
    return;
  }

  if (MODE === "perf") {
    updatePerformance();
    return;
  }

  if (MODE === "prepare") {
    const ctx = loadContext();
    if (!ctx.posts.length) throw new Error("分析対象の投稿がありません(先に --fetch-only を実行してください)");
    fs.mkdirSync(PENDING, { recursive: true });
    const schema = zodOutputFormat(AnalysisSchema).schema;
    const input = [
      "# 分析ルール(システムプロンプト)", "", SYSTEM_PROMPT, "",
      "# 出力形式", "",
      "`data/pending/schema.json` の JSON Schema に厳密に従った JSON を `data/pending/analysis.json` に書くこと。",
      "その後 `node scripts/run.mjs --finalize` を実行すると検証され、通れば latest.json / history が更新される。", "",
      "# 入力データ", "",
      buildUserMessage(ctx),
    ].join("\n");
    fs.writeFileSync(path.join(PENDING, "input.md"), input);
    writeJson(path.join(PENDING, "schema.json"), schema);
    writeJson(path.join(PENDING, "context.json"), { ...ctx, prior: ctx.prior ? { date: ctx.prior.date, analysis: ctx.prior.analysis } : null });
    fs.rmSync(path.join(PENDING, "analysis.json"), { force: true });
    log(`prepare: ${ctx.posts.length} posts → ${path.relative(process.cwd(), path.join(PENDING, "input.md"))}`);
    return;
  }

  if (MODE === "finalize") {
    const file = typeof args.finalize === "string" ? path.resolve(args.finalize) : path.join(PENDING, "analysis.json");
    const ctxFile = path.join(PENDING, "context.json");
    const ctx = readJson(ctxFile, null);
    if (!ctx) throw new Error("data/pending/context.json がありません(先に --prepare を実行してください)");
    const raw = readJson(file, null);
    if (!raw) throw new Error(`${file} が読めません`);
    let analysis;
    try {
      analysis = validateAnalysis(raw);
    } catch (e) {
      writeStatus({ ok: false, error: `finalize validation failed: ${e.message}` });
      throw e;
    }
    writeReport(ctx, analysis, { model: args.model || "claude-code-routine" });
    fs.rmSync(PENDING, { recursive: true, force: true });
    if (!SAMPLE) updatePerformance();
    return;
  }

  // MODE === "full": 取得 → 分析(API or サンプル)
  await fetchAndStore();
  const ctx = loadContext();
  if (!ctx.posts.length) {
    writeStatus({ ok: false, error: "no posts available in window" });
    throw new Error("no posts available in window");
  }
  if (!process.env.ANTHROPIC_API_KEY && SAMPLE) {
    const analysis = readJson(path.join(FIXTURES, "sample-analysis.json"), null);
    if (!analysis) throw new Error("fixtures/sample-analysis.json missing");
    log("analyze: no ANTHROPIC_API_KEY → using fixtures/sample-analysis.json");
    writeReport(ctx, validateAnalysis(analysis), { model: "sample", sample: true });
    return;
  }
  try {
    const { analysis, usage, model } = await analyze(ctx);
    writeReport(ctx, analysis, { model, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 } });
  } catch (e) {
    writeStatus({ ok: false, error: `analysis failed: ${e.message}` });
    throw e;
  }
}

main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});
