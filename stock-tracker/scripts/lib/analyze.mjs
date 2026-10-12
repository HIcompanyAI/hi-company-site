/**
 * Claude による投稿分析 → 売買シグナル(構造化 JSON)。
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { log } from "./util.mjs";

export const MODEL = process.env.STOCK_TRACKER_MODEL || "claude-opus-5-5";

const Recommendation = z.object({
  ticker: z.string().describe("ティッカー。米国株は 'NVDA'、海外は 'RPI.L' のように取引所サフィックス付き"),
  company: z.string(),
  exchange: z.string().describe("NASDAQ / NYSE / LSE / Euronext Paris など"),
  action: z.enum(["BUY", "SELL", "HOLD", "WATCH", "AVOID"]),
  conviction: z.number().int().describe("確信度 1(低)〜5(高)"),
  horizon: z.enum(["short", "medium", "long"]).describe("short=数日〜2週間, medium=1〜3ヶ月, long=半年以上"),
  source: z.enum(["trump", "serenity", "both"]),
  thesis_ja: z.string().describe("なぜその判断か。投稿内容を具体的に引用・要約(日本語、2〜4文)"),
  risk_ja: z.string().describe("主なリスク。小型株の流動性・ポンプ懸念・政策撤回リスクなど(日本語)"),
  catalyst_ja: z.string().describe("次に注目すべきイベント/日付(日本語)"),
  source_post_keys: z.array(z.string()).describe("根拠にした投稿の key(例 'x:1234', 'trump:5678')"),
});

const Digest = z.object({
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
  trump_digest: Digest,
  serenity_digest: Digest,
  changes_from_yesterday_ja: z.array(z.string()).describe("前日のアドバイスからの変更点(新規追加・格上げ/格下げ・除外)。初回は空配列"),
  confidence_note_ja: z.string().describe("データの欠落や取得失敗など、判断の信頼性に関する注記(日本語)"),
});

export const SYSTEM_PROMPT = `あなたは日本語で報告する株式リサーチアナリストです。
2 つの情報源の投稿を毎日読み、「どの株を買う/売る/様子見するべきか」を根拠付きで整理します。

■ 情報源の性質
- Donald J. Trump 大統領(Truth Social @realDonaldTrump): 関税、FRB・金利、規制、補助金、特定企業・CEO・業界への称賛や非難、通商交渉など。マクロ/セクター単位で株価に影響する。企業名や業界が名指しされた場合は該当ティッカーを特定する。
- Serenity(X @aleabitoreddit): AI ハードウェアのサプライチェーンで「ボトルネック」になる小型株(光通信/CPO、InP、SiPh、化合物半導体、レーザー等)を深掘りする匿名アナリスト。投稿が小型株を急騰させた実績がある一方、ポンプ批判もあり、実績は未監査。

■ 判断ルール
1. 推奨は必ず投稿内容に根拠を置き、source_post_keys で投稿を引用する。投稿に無い銘柄を推測で足さない。
2. Trump 発言は「どの業界・企業に追い風/逆風か」を明示し、代表的なティッカーに落とす(例: 関税→輸入依存企業に逆風、国内鉄鋼に追い風)。発言が撤回・反転されやすい点をリスクとして書く。
3. Serenity の銘柄は、投稿直後の急騰(追いかけ買いの高値掴み)と小型株の流動性リスクを必ず risk_ja に書く。すでに大きく上昇した銘柄は BUY ではなく WATCH/HOLD を検討する。
4. 前日のアドバイスとの連続性を保ち、変更点は changes_from_yesterday_ja に書く。新しい情報が無い銘柄は格付けを維持する。
5. 株価情報が与えられた場合は、水準や当日の変動を thesis/risk に反映する。
6. 株式と無関係な投稿(政治的主張、個人攻撃など)は digest で件数だけ把握し、推奨には使わない。
7. 投稿が取得できなかった情報源がある場合は confidence_note_ja に明記し、その情報源に基づく推奨は出さない。
8. これは情報提供であり投資助言ではない。断定的な利益の約束はしない。`;

function fmtPost(p) {
  const flag = p.is_new ? "[NEW] " : "";
  const text = (p.text || "").replace(/\s+/g, " ").slice(0, 1200);
  return `- key=${p.key} | ${p.created_at} | ${p.author}\n  ${flag}${text}\n  ${p.url || ""}`;
}

export function buildUserMessage({ date, posts, prior, quotes, sourceStatus }) {
  const trump = posts.filter((p) => p.source === "trump");
  const serenity = posts.filter((p) => p.source === "serenity");
  const lines = [];
  lines.push(`# 分析日: ${date} (日本時間)`);
  lines.push("");
  lines.push("## 情報源の取得状況");
  for (const [k, v] of Object.entries(sourceStatus)) {
    lines.push(`- ${k}: ${v.via ? `取得成功 (${v.via}) 期間内 ${v.count} 件 / 新着 ${v.new_count} 件` : `取得失敗: ${(v.errors || []).map((e) => `${e.name}: ${e.error}`).join("; ") || "不明"}`}`);
  }
  lines.push("");
  lines.push(`## Trump の投稿 (${trump.length} 件、新しい順。[NEW]=前回実行以降に見つかった投稿)`);
  lines.push(trump.length ? trump.map(fmtPost).join("\n") : "(なし)");
  lines.push("");
  lines.push(`## Serenity の投稿 (${serenity.length} 件、新しい順)`);
  lines.push(serenity.length ? serenity.map(fmtPost).join("\n") : "(なし)");
  lines.push("");
  lines.push("## 参考株価 (終値ベース、取得できた分のみ)");
  const q = Object.entries(quotes || {});
  lines.push(q.length ? q.map(([t, v]) => `- ${t}: ${v.price}${v.currency ? " " + v.currency : ""} (${v.change_pct == null ? "n/a" : (v.change_pct >= 0 ? "+" : "") + v.change_pct.toFixed(2) + "%"}, ${v.asof})`).join("\n") : "(なし)");
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
