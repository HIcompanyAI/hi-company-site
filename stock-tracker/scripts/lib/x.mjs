/**
 * X (Twitter) の投稿取得 — Serenity (@aleabitoreddit) 用。
 *   1. X API v2 (X_BEARER_TOKEN がある場合。最も確実)
 *   2. X_FEED_URL (任意) 自前の RSS/JSON フィード
 *   3. syndication.twitter.com の埋め込みタイムライン (__NEXT_DATA__ を解析)
 *   4. Nitter インスタンスの RSS (X_NITTER_INSTANCES でカンマ区切り指定可)
 *   5. RSSHub (X_RSSHUB_BASE で自前インスタンス指定可)
 */
import { fetchText, fetchJson, firstSuccessful, decodeEntities, parseFeedItems, toIso, log } from "./util.mjs";

const DEFAULT_NITTER = ["https://nitter.net", "https://nitter.privacydev.net", "https://nitter.poast.org", "https://xcancel.com"];

function normalize(username, { id, text, createdAt, url, isRetweet = false, isReply = false }) {
  return {
    key: `x:${id}`,
    id: String(id),
    source: username.toLowerCase(),
    author: `@${username}`,
    text: decodeEntities(text || "").trim(),
    created_at: createdAt,
    url: url || `https://x.com/${username}/status/${id}`,
    is_retweet: isRetweet,
    is_reply: isReply,
  };
}

const idFromUrl = (u = "") => (u.match(/status(?:es)?\/(\d{10,})/) || [])[1] || null;

/* ---------- 1. official API v2 ---------- */
async function fromApiV2(username, token) {
  const headers = { authorization: `Bearer ${token}` };
  const user = await fetchJson(`https://api.x.com/2/users/by/username/${username}`, { headers });
  const uid = user?.data?.id;
  if (!uid) throw new Error("user lookup failed");
  const q = new URLSearchParams({
    max_results: "100",
    exclude: "retweets",
    "tweet.fields": "created_at,text,entities,referenced_tweets,note_tweet",
  });
  const tl = await fetchJson(`https://api.x.com/2/users/${uid}/tweets?${q}`, { headers });
  return (tl.data || []).map((t) => {
    let text = t.note_tweet?.text || t.text || "";
    for (const u of t.entities?.urls || []) if (u.expanded_url) text = text.replace(u.url, u.expanded_url);
    return normalize(username, {
      id: t.id,
      text,
      createdAt: toIso(t.created_at),
      isReply: (t.referenced_tweets || []).some((r) => r.type === "replied_to"),
    });
  });
}

/* ---------- 2. custom feed ---------- */
async function fromCustomFeed(username, url) {
  const body = await fetchText(url);
  const trimmed = body.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const arr = Array.isArray(json) ? json : json.items || json.data || json.tweets || [];
    return arr
      .map((p) => normalize(username, { id: p.id || p.id_str || idFromUrl(p.url || p.link), text: p.text || p.full_text || p.content_text || p.content || p.title, createdAt: toIso(p.created_at || p.date_published || p.date), url: p.url || p.link }))
      .filter((p) => p.id && p.created_at);
  }
  return parseFeedItems(body)
    .map((it) => normalize(username, { id: idFromUrl(it.link) || idFromUrl(it.guid) || it.guid, text: it.description || it.title, createdAt: toIso(it.date), url: it.link, isRetweet: /^RT by /.test(it.title) }))
    .filter((p) => p.id && p.created_at);
}

/* ---------- 3. syndication embed ---------- */
export function parseSyndicationHtml(username, html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ not found");
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  const out = [];
  for (const e of entries) {
    const t = e?.content?.tweet;
    if (!t?.id_str) continue;
    const isRetweet = Boolean(t.retweeted_status) || /^RT @/.test(t.full_text || "");
    if (isRetweet) continue;
    let text = t.full_text || t.text || "";
    for (const u of t.entities?.urls || []) if (u.expanded_url) text = text.replace(u.url, u.expanded_url);
    out.push(normalize(username, { id: t.id_str, text, createdAt: toIso(t.created_at), isReply: Boolean(t.in_reply_to_status_id_str) }));
  }
  return out;
}

async function fromSyndication(username) {
  const html = await fetchText(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}?showReplies=false`);
  return parseSyndicationHtml(username, html);
}

/* ---------- 4. nitter RSS ---------- */
async function fromNitter(username, base) {
  const xml = await fetchText(`${base}/${username}/rss`);
  return parseFeedItems(xml)
    .filter((it) => !/^RT by /.test(it.title))
    .map((it) => {
      const id = idFromUrl(it.link);
      return normalize(username, { id, text: it.description || it.title, createdAt: toIso(it.date), url: id ? `https://x.com/${username}/status/${id}` : it.link, isReply: /^R to /.test(it.title) });
    })
    .filter((p) => p.id && p.created_at);
}

/* ---------- 5. RSSHub ---------- */
async function fromRsshub(username, base) {
  const xml = await fetchText(`${base}/twitter/user/${username}`);
  return parseFeedItems(xml)
    .map((it) => {
      const id = idFromUrl(it.link);
      return normalize(username, { id, text: it.description || it.title, createdAt: toIso(it.date), url: id ? `https://x.com/${username}/status/${id}` : it.link, isRetweet: /^(RT|Re )/.test(it.title) });
    })
    .filter((p) => p.id && p.created_at && !p.is_retweet);
}

export async function fetchXPosts(username = "aleabitoreddit", meta = {}) {
  const META = { id: meta.id || username.toLowerCase(), author: meta.author || `@${username}` };
  const attempts = [];
  if (process.env.X_BEARER_TOKEN) attempts.push({ name: "x-api-v2", fn: () => fromApiV2(username, process.env.X_BEARER_TOKEN) });
  if (process.env.X_FEED_URL) attempts.push({ name: "custom-feed", fn: () => fromCustomFeed(username, process.env.X_FEED_URL) });
  attempts.push({ name: "syndication", fn: () => fromSyndication(username) });
  const nitters = (process.env.X_NITTER_INSTANCES || DEFAULT_NITTER.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const base of nitters) attempts.push({ name: `nitter:${new URL(base).host}`, fn: () => fromNitter(username, base.replace(/\/$/, "")) });
  const rsshub = (process.env.X_RSSHUB_BASE || "https://rsshub.app").replace(/\/$/, "");
  attempts.push({ name: "rsshub", fn: () => fromRsshub(username, rsshub) });
  const { result, via, errors } = await firstSuccessful(META.id, attempts);
  if (!result) log(`${META.id}: all sources failed`);
  const posts = (result || []).map((p) => ({ ...p, source: META.id, author: META.author }));
  return { posts, via, errors };
}
