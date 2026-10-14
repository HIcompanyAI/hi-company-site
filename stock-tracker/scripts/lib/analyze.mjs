/**
 * Claude による投稿分析 → 売買シグナル(構造化 JSON)。
 * API 方式(analyze)と Routine 方式(buildUserMessage + SYSTEM_PROMPT を input.md に出力)の両方で使う。
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SOURCES, SOURCE_IDS } from "./sources.mjs";
import { log } from "./util.mjs";

export const MODEL = process.env.STOCK_TRACKER_MODEL || "claude-opus-5-5";
const SOURCE_ENUM = [...SOURCE_IDS, "multiple"];

const Recommendation = z.object({
  ticker: z.string().describe("ティッカー。米国株は 'NVDA'、海外は 'RPI.L' のように取引所サフィックス付き"),
  company: z.string(),
  exchange: z.string().describe("NASDAQ / NYSE / LSE / Euronext Paris など"),
  action: z.enum(["BUY", "SELL", "HOLD", "WATCH", "AVOID"]),
  conviction: z.number().int().describe("確信度 1(低)〜5(高)"),
  horizon: z.enum(["short", "medium", "long"]).describe("short=数日〜2週間, medium=1〜3ヶ月, long=半年以上"),
  source: z.enum(SOURCE_ENUM).describe("根拠にした情報源。複数が同方向なら 'multiple'"),
  thesis_ja: z.string().describe("なぜその判断か。投稿内容を具体的に引用・要約(日本語、2〜4文)"),
  risk_ja: z.string().describe("主なリスク。小型株の流動性・ポンプ懸念・政策撤回リスクなど(日本語)"),
  catalyst_ja: z.string().describe("次に注目すべきイベント/日付(日本語)"),
  plan_ja: z.string().describe("売買プラン: 想定エントリー水準、損切り目安(%)、利確目安/保有期間(日本語、1〜2文)"),
  source_post_keys: z.array(z.string()).describe("根拠にした投稿の key(例 'x:1234', 'trump:5678')"),
});

const Digest = z.object({
  source: z.enum(SOURCE_IDS),
  post_count: z.number().int(),
  relevant_count: z.number().int().describe("株式・市場に関係する投稿数"),
  themes_ja: z.array(z.string()).describe("主要テーマ 3〜6 個(日本語、短く)"),
  key_posts: z.array(z.object({ key: z.string(), why_ja: z.string() })).describe("特に重要な投稿とその理由"),
});

export const AnalysisSchema = z.object({
  headline_ja: z.string().describe("今日の見出し(日本語、30字以内)"),
  summary_ja: z.string().describe("今日の総括(日本語、3〜6文)"),
  market_context_ja: z.string().describe("トランプ発言のマクロ影響(関税・金利・規制・特定企業への言及)を整理(日本語)"),
  overall_stance: z.enum(["risk_on", "neutral", "risk_off"]),
  recommendations: z.array(Recommendation).describe("売買・監視リスト。根拠のない銘柄は入れない。0〜12件"),
  source_digests: z.array(Digest).describe("情報源ごとの要点。追跡中の全情報源について 1 件ずつ"),
  changes_from_yesterday_ja: z.array(z.string()).describe("前日のアドバイスからの変更点(新規追加・格上げ/格下げ・除外)。初回は空配列"),
  confidence_note_ja: z.string().describe("データの欠落や取得失敗など、判断の信頼性に関する注記(日本語)"),
});

export const SYSTEM_PROMPT = `あなたは日本語で報告する株式リサーチアナリストです。
複数の情報源の投稿を毎日読み、「どの株を買う/売る/様子見するべきか」を根拠付きで整理します。
目的は的中率ではなく期待値(勝率 × 平均利益 − 敗率 × 平均損失)を最大化することです。

■ 情報源の性質
${SOURCES.map((s) => `- [${s.id}] ${s.description}`).join("\n")}

■ 判断ルール(優先順)
1. 推奨は必ず投稿内容に根拠を置き、source_post_keys で投稿を引用する。投稿に無い銘柄を推測で足さない。
2. 複数の情報源が同じ方向を指す銘柄・テーマを最優先する(source は 'multiple'、conviction を 1 段上げる)。単独の情報源による小型株は conviction 3 以下にする。
3. 追いかけ買いをしない。参考株価で投稿後すでに +15% 以上上げている銘柄、または投稿当日に急騰した小型株は BUY にせず WATCH にし、押し目の水準を plan_ja に書く。
4. 保有期間は原則 medium(5〜60 営業日)。テーマの検証には時間がかかるため、1 日のコピートレード前提の short は、明確な日付イベント(決算、関税発動日、政策発表)がある場合に限る。
5. Trump 発言は「どの業界・企業に追い風/逆風か」を明示し、代表的なティッカーに落とす。発言が撤回・反転されやすいので、単独では conviction 3 以下とし、risk_ja に反転リスクを書く。
6. Serenity・Citrini などアナリスト系の銘柄は、小型株の流動性と投稿直後の急騰(高値掴み)リスクを必ず risk_ja に書く。
7. plan_ja に損切り目安(通常 −10〜−15%、小型株は −15〜−20%)と利確/見直しの目安を必ず書く。1 銘柄に資金の 10% 超を割く前提にしない。
8. 前日のアドバイスとの連続性を保ち、変更点は changes_from_yesterday_ja に書く。新しい情報が無い銘柄は格付けを維持し、損切り水準に達した銘柄は SELL に落とす。
9. 「情報源別の実績」が与えられた場合は、的中率・平均リターンが低い情報源の conviction を下げ、高い情報源を優先する。
10. 株式と無関係な投稿(政治的主張、個人攻撃など)は digest で件数だけ把握し、推奨には使わない。
11. 投稿が取得できなかった情報源がある場合は confidence_note_ja に明記し、その情報源に基づく推奨は出さない。
12. これは情報提供であり投資助言ではない。断定的な利益の約束はしない。`;

function fmtPost(p) {
  const flag = p.is_new ? "[NEW] " : "";
  const text = (p.text || "").replace(/\s+/g, " ").slice(0, 1200);
  return `- key=${p.key} | ${p.created_at} | ${p.author}\n  ${flag}${text}\n  ${p.url || ""}`;
}

export function buildUserMessage({ date, posts, prior, quotes, sourceStatus, performance_summary = null }) {
  const lines = [];
  lines.push(`# 分析日: ${date} (日本時間)`);
  lines.push("");
  lines.push("## 情報源の取得状況");
  for (const s of SOURCES) {
    const v = sourceStatus[s.id] || {};
    lines.push(`- ${s.id}: ${v.via ? `取得成功 (${v.via}) 期間内 ${v.count} 件 / 新着 ${v.new_count} 件` : `取得失敗: ${(v.errors || []).map((e) => `${e.name}: ${e.error}`).join("; ") || "不明"}`}`);
  }
  for (const s of SOURCES) {
    const ps = posts.filter((p) => p.source === s.id);
    lines.push("");
    lines.push(`## ${s.label} の投稿 (${ps.length} 件、新しい順。[NEW]=前回実行以降に見つかった投稿)`);
    lines.push(ps.length ? ps.map(fmtPost).join("\n") : "(なし)");
  }
  lines.push("");
  lines.push("## 参考株価 (終値ベース、取得できた分のみ)");
  const q = Object.entries(quotes || {});
  lines.push(q.length ? q.map(([t, v]) => `- ${t}: ${v.price}${v.currency ? " " + v.currency : ""} (${v.change_pct == null ? "n/a" : (v.change_pct >= 0 ? "+" : "") + v.change_pct.toFixed(2) + "%"}, ${v.asof})`).join("\n") : "(なし)");
  lines.push("");
  lines.push("## 情報源別の実績(このアプリの過去推奨を株価で採点したもの)");
  lines.push(performance_summary || "(採点数がまだ少ないため省略)");
  lines.push("");
  lines.push("## 前日のアドバイス(連続性のため)");
  if (prior?.analysis) {
    const a = prior.analysis;
    lines.push(`前日 ${prior.date}: ${a.headline_ja} / スタンス ${a.overall_stance}`);
    for (const r of a.recommendations || []) lines.push(`- ${r.ticker} ${r.action} (確信度${r.conviction}, ${r.horizon}, ${r.source}): ${r.thesis_ja.slice(0, 160)}`);
  } else {
    lines.push("(初回実行のためなし)");
  }
  lines.push("");
  lines.push("上記をもとに、今日の売買アドバイスを指定スキーマの JSON で出力してください。");
  return lines.join("\n");
}

export async function analyze(input) {
  const client = new Anthropic();
  const user = buildUserMessage(input);
  log(`analyze: ${input.posts.length} posts → ${MODEL}`);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: zodOutputFormat(AnalysisSchema) },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`model refused: ${response.stop_details?.explanation || response.stop_details?.category || "unknown"}`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("output truncated (max_tokens)");
  if (!response.parsed_output) throw new Error("structured output did not parse");
  const usage = response.usage;
  log(`analyze: done (in=${usage.input_tokens}, cached=${usage.cache_read_input_tokens ?? 0}, out=${usage.output_tokens})`);
  return { analysis: response.parsed_output, usage, model: response.model };
}
