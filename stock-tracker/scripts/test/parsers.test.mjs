import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedItems, decodeEntities, extractCashtags } from "../lib/util.mjs";
import { parseArchiveHtml } from "../lib/truth.mjs";
import { parseSyndicationHtml } from "../lib/x.mjs";
import { buildUserMessage, AnalysisSchema } from "../lib/analyze.mjs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

test("RSS items parse (CDATA, guid, pubDate)", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[RT by @x: hello]]></title><link>https://nitter.net/aleabitoreddit/status/1234567890123#m</link>
      <guid>https://nitter.net/aleabitoreddit/status/1234567890123#m</guid><pubDate>Sat, 11 Oct 2026 02:15:00 GMT</pubDate>
      <description><![CDATA[<p>$AXTI is the InP bottleneck &amp; more</p>]]></description></item>
  </channel></rss>`;
  const items = parseFeedItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].description, "$AXTI is the InP bottleneck & more");
  assert.match(items[0].link, /1234567890123/);
  assert.equal(new Date(items[0].date).toISOString(), "2026-10-11T02:15:00.000Z");
});

test("Atom entries parse", () => {
  const xml = `<feed><entry><title>t</title><id>urn:1</id><link href="https://x.com/a/status/999999999999"/><published>2026-10-01T00:00:00Z</published><content>c</content></entry></feed>`;
  const items = parseFeedItems(xml);
  assert.equal(items[0].link, "https://x.com/a/status/999999999999");
  assert.equal(items[0].description, "c");
});

test("entity decoding and cashtags", () => {
  assert.equal(decodeEntities("a&nbsp;b<br>c &#8217;d"), "a b\nc ’d");
  assert.deepEqual(extractCashtags("buy $NVDA and $RPI.L not $toolongname"), ["NVDA", "RPI.L"]);
});

test("trumpstruth.org archive HTML", () => {
  const html = `<html><body>
  <div class="status" data-status-url="https://truthsocial.com/@realDonaldTrump/posts/115000000000000001">
    <div class="status__header">Donald J. Trump · October 11, 2026, 9:42 PM · <a class="status__external-link" href="https://truthsocial.com/@realDonaldTrump/posts/115000000000000001">Original Post</a></div>
    <div class="status__body"><div class="status__content"><p>Tariffs on chips are coming. Great for <b>American</b> workers!</p></div></div>
  </div>
  <div class="status" data-status-url="https://truthsocial.com/@realDonaldTrump/posts/115000000000000002">
    <div class="status__header">Donald J. Trump · <time datetime="2026-10-11T20:00:00Z">x</time></div>
    <div class="status__body"><div class="status__content"></div><div class="status__attachments"><div class="status-attachment status-attachment--image"></div></div></div>
  </div>
  <a class="button" href="/?page=2">Next Page</a></body></html>`;
  const { posts, next } = parseArchiveHtml(html);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, "115000000000000001");
  assert.equal(posts[0].text, "Tariffs on chips are coming. Great for American workers!");
  assert.equal(posts[0].created_at, "2026-10-12T01:42:00.000Z"); // 9:42 PM EDT → UTC
  assert.equal(posts[1].media_count, 1);
  assert.equal(posts[1].created_at, "2026-10-11T20:00:00.000Z");
  assert.equal(next, "https://trumpstruth.org/?page=2");
});

test("syndication __NEXT_DATA__", () => {
  const data = { props: { pageProps: { timeline: { entries: [
    { content: { tweet: { id_str: "1", full_text: "Thread on $AAOI https://t.co/abc", created_at: "Sat Oct 11 02:15:00 +0000 2026", entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/x" }] } } } },
    { content: { tweet: { id_str: "2", full_text: "RT @someone: no", created_at: "Sat Oct 11 02:16:00 +0000 2026" } } },
  ] } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const posts = parseSyndicationHtml("aleabitoreddit", html);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Thread on $AAOI https://example.com/x");
  assert.equal(posts[0].url, "https://x.com/aleabitoreddit/status/1");
});

test("analysis schema converts to output format and prompt builds", () => {
  const fmt = zodOutputFormat(AnalysisSchema);
  assert.equal(fmt.type, "json_schema");
  assert.ok(fmt.schema.properties.recommendations);
  const msg = buildUserMessage({
    date: "2026-10-12",
    posts: [{ key: "x:1", source: "serenity", author: "S", created_at: "2026-10-11T00:00:00Z", text: "hi", url: "u", is_new: true }],
    prior: null,
    quotes: { NVDA: { price: 180, change_pct: 1.234, asof: "2026-10-10" } },
    sourceStatus: { trump: { via: null, errors: [{ name: "a", error: "b" }] }, serenity: { via: "x-api-v2", count: 1, new_count: 1 } },
  });
  assert.match(msg, /取得失敗: a: b/);
  assert.match(msg, /\[NEW\] hi/);
  assert.match(msg, /NVDA: 180 \(\+1\.23%/);
});
