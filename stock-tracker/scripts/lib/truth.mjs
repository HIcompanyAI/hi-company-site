/**
 * Truth Social (@realDonaldTrump) の投稿取得。
 * 公式 API は有料・審査制のため、複数のソースを順に試す。
 *   1. TRUTH_FEED_URL  (任意) 自前の RSS/JSON フィード。例: truthrss を GitHub Pages に置いたもの、有料 API のプロキシ等
 *   2. trumpstruth.org のアーカイブ (HTML スクレイプ。div.status 構造)
 *   3. Truth Social の Mastodon 互換 API (TRUTHSOCIAL_TOKEN があれば Bearer 付与)
 */
import * as cheerio from "cheerio";
import { fetchText, fetchJson, firstSuccessful, decodeEntities, parseFeedItems, toIso, log } from "./util.mjs";

const TRUMP_ACCOUNT_ID = "107780257626128497"; // @realDonaldTrump
const ARCHIVE_BASE = "https://trumpstruth.org";

function normalize({ id, text, createdAt, url, media = [] }) {
  const clean = decodeEntities(text || "").trim();
  return {
    key: `trump:${id}`,
    id: String(id),
    source: "trump",
    author: "Donald J. Trump (@realDonaldTrump)",
    text: clean,
    created_at: createdAt,
    url,
    media_count: media.length,
  };
}

function idFromUrl(url = "") {
  const m = url.match(/(\d{15,})\/?$/);
  return m ? m[1] : null;
}

/* ---------- 1. custom feed ---------- */
async function fromCustomFeed(url) {
  const body = await fetchText(url);
  const trimmed = body.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const arr = Array.isArray(json) ? json : json.items || json.data || json.posts || [];
    return arr
      .map((p) =>
        normalize({
          id: p.id || p.id_str || idFromUrl(p.url || p.link) || p.guid,
          text: p.text || p.content || p.content_text || p.title || "",
          createdAt: toIso(p.created_at || p.date_published || p.date || p.pubDate),
          url: p.url || p.link || p.uri,
          media: p.media_attachments || p.attachments || [],
        }),
      )
      .filter((p) => p.id && p.created_at);
  }
  return parseFeedItems(body)
    .map((it) =>
      normalize({
        id: idFromUrl(it.link) || idFromUrl(it.guid) || it.guid,
        text: it.description || it.title,
        createdAt: toIso(it.date),
        url: it.link || it.guid,
      }),
    )
    .filter((p) => p.id && p.created_at);
}

/* ---------- 2. trumpstruth.org archive ---------- */
function parseArchiveDate(headerText = "") {
  // 例: "Donald J. Trump · October 11, 2026, 9:42 PM · Original Post"
  const m = headerText.match(/·\s*([A-Z][a-z]+ \d{1,2}, \d{4},? \d{1,2}:\d{2} [AP]M)/);
  if (!m) return null;
  // アーカイブは US Eastern 表記。ET とみなして ISO 化する(DST は月で近似)。
  const d = new Date(m[1].replace(",", "") + " UTC");
  if (Number.isNaN(d.getTime())) return null;
  const month = d.getUTCMonth() + 1;
  const offsetH = month >= 4 && month <= 10 ? 4 : 5; // EDT=-4, EST=-5 の近似
  return new Date(d.getTime() + offsetH * 3600 * 1000).toISOString();
}

export function parseArchiveHtml(html) {
  const posts = [];
  const $ = cheerio.load(html);
  $("div.status").each((_, el) => {
      const $el = $(el);
      const link =
        $el.attr("data-status-url") ||
        $el.find("a.status__external-link").attr("href") ||
        $el.find("a[href*='/statuses/']").attr("href") ||
        "";
      const text = $el.find(".status__content").text().trim();
      const header = $el.find(".status__header, .status__meta").text().replace(/\s+/g, " ");
      const timeAttr = $el.find("time[datetime]").attr("datetime");
      const createdAt = toIso(timeAttr) || parseArchiveDate(header);
      const id = idFromUrl(link) || $el.attr("data-status-id") || $el.attr("id")?.replace(/\D/g, "");
      const media = $el.find(".status__attachments .status-attachment, .status__attachments img, .status__attachments video").toArray();
      if (id && (text || media.length)) {
        posts.push(normalize({ id, text: text || "(メディアのみの投稿)", createdAt, url: link.startsWith("http") ? link : ARCHIVE_BASE + link, media }));
      }
  });
  const next = $("a").filter((_, a) => /next page/i.test($(a).text())).first().attr("href");
  return { posts: posts.filter((p) => p.created_at), next: next ? new URL(next, ARCHIVE_BASE).toString() : null };
}

async function fromArchive(maxPages = 3) {
  const posts = [];
  let url = ARCHIVE_BASE + "/";
  for (let i = 0; i < maxPages && url; i++) {
    const page = parseArchiveHtml(await fetchText(url));
    posts.push(...page.posts);
    url = page.next;
  }
  return posts;
}

/* ---------- 3. Truth Social Mastodon-compatible API ---------- */
async function fromTruthApi() {
  const headers = {};
  if (process.env.TRUTHSOCIAL_TOKEN) headers.authorization = `Bearer ${process.env.TRUTHSOCIAL_TOKEN}`;
  const statuses = await fetchJson(
    `https://truthsocial.com/api/v1/accounts/${TRUMP_ACCOUNT_ID}/statuses?exclude_replies=true&limit=40`,
    { headers },
  );
  if (!Array.isArray(statuses)) throw new Error("unexpected response shape");
  return statuses.map((s) => {
    const reblog = s.reblog;
    const base = reblog || s;
    const text = base.content || "";
    const prefix = reblog ? `[ReTruth of @${reblog.account?.acct}] ` : "";
    return normalize({
      id: s.id,
      text: prefix + text + (base.card?.url ? `\n${base.card.url}` : ""),
      createdAt: toIso(s.created_at),
      url: s.url || s.uri,
      media: base.media_attachments || [],
    });
  });
}

export async function fetchTrumpPosts() {
  const attempts = [];
  if (process.env.TRUTH_FEED_URL) attempts.push({ name: "custom-feed", fn: () => fromCustomFeed(process.env.TRUTH_FEED_URL) });
  attempts.push({ name: "trumpstruth.org", fn: () => fromArchive() });
  attempts.push({ name: "truthsocial-api", fn: () => fromTruthApi() });
  const { result, via, errors } = await firstSuccessful("trump", attempts);
  if (!result) log("trump: all sources failed");
  return { posts: result || [], via, errors };
}
