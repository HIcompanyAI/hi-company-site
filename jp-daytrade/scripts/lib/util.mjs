import fs from "node:fs";
import path from "node:path";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
export function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return body;
  } finally { clearTimeout(t); }
}

export function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
export function writeJson(f, d) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n"); }

export function ymd(date = new Date(), tz = "Asia/Tokyo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/* ---------- 統計 ---------- */
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
export function corr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** リッジ回帰 (切片あり)。X: n×k, y: n。返り値 {coef:[k], intercept} */
export function ridge(X, y, lambda = 1e-3) {
  const n = X.length; if (!n) return { coef: [], intercept: 0 };
  const k = X[0].length;
  const mx = Array.from({ length: k }, (_, j) => mean(X.map((r) => r[j])));
  const my = mean(y);
  // 正規方程式 (X'X + λI) b = X'y  (中心化)
  const A = Array.from({ length: k }, () => Array(k).fill(0));
  const B = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const xc = X[i].map((v, j) => v - mx[j]);
    for (let a = 0; a < k; a++) { B[a] += xc[a] * (y[i] - my); for (let b = 0; b < k; b++) A[a][b] += xc[a] * xc[b]; }
  }
  for (let a = 0; a < k; a++) A[a][a] += lambda * n;
  const coef = solve(A, B);
  const intercept = my - coef.reduce((s, c, j) => s + c * mx[j], 0);
  return { coef, intercept };
}
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}
export const pct = (x, d = 2) => (x == null || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
