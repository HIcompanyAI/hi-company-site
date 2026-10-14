import fs from "node:fs";
import path from "node:path";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with timeout + UA. Throws on non-2xx. */
export async function fetchText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*", ...headers },
      signal: ctrl.signal,
      redirect: "follow",
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      err.body = body.slice(0, 300);
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: "application/json", ...(opts.headers || {}) },
  });
  return JSON.parse(text);
}

/** Try each async producer in order; return first non-empty result. */
export async function firstSuccessful(label, attempts, { onError } = {}) {
  const errors = [];
  for (const { name, fn } of attempts) {
    try {
      const out = await fn();
      if (Array.isArray(out) ? out.length > 0 : out) {
        log(`${label}: ok via ${name} (${Array.isArray(out) ? out.length : 1})`);
        return { result: out, via: name, errors };
      }
      errors.push({ name, error: "empty result" });
      log(`${label}: ${name} returned nothing`);
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push({ name, error: msg });
      log(`${label}: ${name} failed: ${msg}`);
      onError?.(name, e);
    }
  }
  return { result: null, via: null, errors };
}

export function decodeEntities(s = "") {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Minimal RSS 2.0 / Atom item parser (regex based; tolerant). */
export function parseFeedItems(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (!m) return "";
    return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  };
  for (const b of blocks) {
    let link = pick(b, "link");
    if (!link) {
      const m = b.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : "";
    }
    items.push({
      title: decodeEntities(pick(b, "title")),
      link,
      guid: pick(b, "guid") || pick(b, "id") || link,
      date: pick(b, "pubDate") || pick(b, "published") || pick(b, "updated") || pick(b, "dc:date"),
      description: decodeEntities(pick(b, "description") || pick(b, "content:encoded") || pick(b, "content") || pick(b, "summary")),
    });
  }
  return items;
}

export function toIso(d) {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Extract $TICKER cashtags and obvious uppercase tickers from text. */
export function extractCashtags(text = "") {
  const set = new Set();
  for (const m of text.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/g)) set.add(m[1]);
  return [...set];
}

export function ymd(date = new Date(), tz = "Asia/Tokyo") {
  // YYYY-MM-DD in the given timezone
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(date);
}
