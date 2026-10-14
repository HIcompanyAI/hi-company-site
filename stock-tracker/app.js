/* Trump × Serenity 株シグナル — ダッシュボード */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ACTION_JA = { BUY: "買い", SELL: "売り", HOLD: "保有", WATCH: "監視", AVOID: "回避" };
  const HORIZON_JA = { short: "短期(〜2週)", medium: "中期(1〜3ヶ月)", long: "長期(半年〜)" };
  const STANCE_JA = { risk_on: "リスクオン", neutral: "中立", risk_off: "リスクオフ" };
  const SRC_JA = { trump: "Trump", serenity: "Serenity", citrini: "Citrini", multiple: "複数一致", both: "複数一致" };
  const SRC_DESC = { trump: "Truth Social の要点", serenity: "X の要点", citrini: "X の要点" };
  const srcLabel = (s) => SRC_JA[s] || `@${s}`;
  const srcClass = (s) => (SRC_JA[s] ? s : "other");

  let report = null;
  let recFilter = "ALL";
  let postFilter = "all";
  let postLimit = 20;

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  async function loadJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  function renderMeta(r, status) {
    const parts = [];
    parts.push(`最終更新: ${fmtDate(r.generated_at)} JST`);
    if (r.model && r.model !== "sample") parts.push(`モデル: ${esc(r.model)}`);
    const src = r.sources || {};
    const line = Object.keys(src).map((k) => {
      const s = src[k];
      return s.via ? `<span class="ok">● ${esc(srcLabel(k))} ${s.count}件 (新着${s.new_count})</span>` : `<span class="ng">● ${esc(srcLabel(k))} 取得失敗</span>`;
    }).join("　");
    $("#meta").innerHTML = parts.join("　|　") + "<br>" + line;

    const banner = $("#banner");
    if (r.sample) {
      banner.hidden = false;
      banner.className = "banner";
      banner.textContent = "⚠ サンプルデータを表示しています。GitHub Actions のバッチが一度実行されると実データに置き換わります。";
    } else if (status && status.ok === false) {
      banner.hidden = false;
      banner.className = "banner err";
      banner.textContent = `⚠ 直近のバッチ(${status.date})が失敗しました: ${status.error || "原因不明"}。表示中は最後に成功した分析です。`;
    } else {
      const failed = Object.entries(src).filter(([, s]) => !s.via).map(([k]) => srcLabel(k));
      if (failed.length) {
        banner.hidden = false;
        banner.className = "banner";
        banner.textContent = `⚠ ${failed.join("・")} の投稿を取得できませんでした。その情報源に基づく判断は含まれていません。`;
      } else banner.hidden = true;
    }
  }

  function renderHero(r) {
    const a = r.analysis;
    $("#date").textContent = `${r.date} の分析（直近 ${r.window_days} 日分の投稿）`;
    $("#headline").textContent = a.headline_ja;
    const st = $("#stance");
    st.textContent = STANCE_JA[a.overall_stance] || a.overall_stance;
    st.className = `stance ${a.overall_stance}`;
    $("#summary").textContent = a.summary_ja;
    $("#macro").textContent = a.market_context_ja;
    const ch = $("#changes");
    ch.innerHTML = (a.changes_from_yesterday_ja || []).map((c) => `<li>${esc(c)}</li>`).join("");
    ch.hidden = !(a.changes_from_yesterday_ja || []).length;
    $("#confidence").textContent = a.confidence_note_ja ? `注記: ${a.confidence_note_ja}` : "";
  }

  function postByKey(key) {
    return (report.posts || []).find((p) => p.key === key);
  }

  function priceHtml(t) {
    const q = report.quotes && report.quotes[t];
    if (!q) return "";
    const pct = q.change_pct == null ? "" : `<span class="${q.change_pct >= 0 ? "up" : "down"}">${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%</span>`;
    return `<span class="price">${q.price}${q.currency ? " " + esc(q.currency) : ""} ${pct}</span>`;
  }

  function renderRecs() {
    const recs = (report.analysis.recommendations || []).filter((r) => {
      if (recFilter === "ALL") return true;
      if (recFilter === "SELL") return r.action === "SELL" || r.action === "AVOID";
      return r.action === recFilter;
    });
    const order = { BUY: 0, SELL: 1, AVOID: 2, WATCH: 3, HOLD: 4 };
    recs.sort((a, b) => (order[a.action] - order[b.action]) || (b.conviction - a.conviction));
    $("#recs").innerHTML = recs.map((r) => {
      const links = (r.source_post_keys || []).map((k) => {
        const p = postByKey(k);
        return p && p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.source === "trump" ? "Truth Social" : "X")} ${fmtDate(p.created_at)}</a>` : "";
      }).filter(Boolean).join("");
      return `<article class="card rec">
        <div class="rec-head">
          <div><div class="ticker">${esc(r.ticker)}</div><div class="company">${esc(r.company)} · ${esc(r.exchange)}</div></div>
          <span class="badge ${esc(r.action)}">${ACTION_JA[r.action] || r.action}</span>
        </div>
        <div class="rec-meta">
          <span class="stars" title="確信度 ${r.conviction}/5">${"★".repeat(r.conviction)}${"☆".repeat(Math.max(0, 5 - r.conviction))}</span>
          <span>${HORIZON_JA[r.horizon] || r.horizon}</span>
          <span class="src ${srcClass(r.source)}">${esc(srcLabel(r.source))}</span>
          ${priceHtml(r.ticker)}
        </div>
        <div><h4>根拠</h4><p>${esc(r.thesis_ja)}</p></div>
        <div class="risk"><h4>リスク</h4><p>${esc(r.risk_ja)}</p></div>
        <div><h4>注目イベント</h4><p>${esc(r.catalyst_ja)}</p></div>
        ${r.plan_ja ? `<div class="plan"><h4>売買プラン</h4><p>${esc(r.plan_ja)}</p></div>` : ""}
        ${links ? `<div class="links">根拠の投稿: ${links}</div>` : ""}
      </article>`;
    }).join("");
    $("#recs-empty").hidden = recs.length > 0;
  }

  function renderDigests(a) {
    let digests = a.source_digests;
    if (!digests) { // 旧形式
      digests = [];
      if (a.trump_digest) digests.push({ source: "trump", ...a.trump_digest });
      if (a.serenity_digest) digests.push({ source: "serenity", ...a.serenity_digest });
    }
    $("#digests").innerHTML = digests.map((d) => `<div class="card digest"><h3><span class="src ${srcClass(d.source)}">${esc(srcLabel(d.source))}</span> ${esc(SRC_DESC[d.source] || "要点")}</h3><div class="digest-body">${digestBody(d)}</div></div>`).join("");
  }

  function digestBody(d) {
    return `
      <div class="stat">投稿 ${d.post_count} 件 / 株式に関係 ${d.relevant_count} 件</div>
      <div class="themes">${(d.themes_ja || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div>
      <ul class="keyposts">${(d.key_posts || []).map((k) => {
        const p = postByKey(k.key);
        return `<li><div>${esc(k.why_ja)}</div>${p ? `<blockquote>${esc(p.text.slice(0, 280))}${p.text.length > 280 ? "…" : ""}</blockquote>${p.url ? `<a class="open" href="${esc(p.url)}" target="_blank" rel="noopener">投稿を開く ↗</a>` : ""}` : ""}</li>`;
      }).join("")}</ul>`;
  }

  const pct = (x, d = 0) => (x == null ? "—" : `${x >= 0 && d ? "+" : ""}${(x * 100).toFixed(d)}%`);
  const yen = (v) => (v == null ? "—" : `${Math.round(v).toLocaleString("ja-JP")} 円`);

  function renderPerformance(perf) {
    const el = $("#perf");
    if (!perf || !perf.graded_recommendations) return;
    const o20 = perf.overall?.[20] || {};
    const o5 = perf.overall?.[5] || {};
    $("#perf-asof").textContent = perf.paper?.as_of ? `株価 ${perf.paper.as_of} 時点` : "";
    const rows = Object.entries(perf.by_source || {}).map(([k, v]) => `<tr><td><span class="src ${srcClass(k)}">${esc(srcLabel(k))}</span></td>` + perf.horizons.map((h) => `<td>${v[h]?.n ? `${pct(v[h].hit_rate)} <span class="s">(${v[h].n})</span>` : "—"}</td>`).join("") + `<td>${pct(v[20]?.avg_ret, 1)}</td></tr>`).join("");
    const bench = perf.paper?.benchmark;
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="l">的中率(20 営業日)</div><div class="v">${pct(o20.hit_rate)}</div><div class="s">${o20.n || 0} 件を採点</div></div>
        <div class="kpi"><div class="l">的中率(5 営業日)</div><div class="v">${pct(o5.hit_rate)}</div><div class="s">${o5.n || 0} 件を採点</div></div>
        <div class="kpi"><div class="l">1 万円の仮想運用</div><div class="v">${yen(perf.paper?.value)}</div><div class="s">BUY を 10% ずつ・20 営業日保有 / 決済 ${perf.paper?.closed_trades ?? 0} 回</div></div>
        <div class="kpi"><div class="l">同期間に ${esc(bench?.ticker || "指数")} を持った場合</div><div class="v">${yen(bench?.value)}</div><div class="s">${bench ? `${esc(bench.start_date)} 〜` : "データ待ち"}</div></div>
      </div>
      <table><thead><tr><th>情報源</th>${perf.horizons.map((h) => `<th>${h} 日</th>`).join("")}<th>平均(20 日)</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">的中 = BUY なら上昇、SELL/AVOID なら下落。WATCH/HOLD は採点しません。採点数が 30 件未満の間は参考値です。</p>`;
  }

  function renderPosts() {
    const all = report.posts || [];
    const list = all.filter((p) => postFilter === "all" || (postFilter === "new" ? p.is_new : p.source === postFilter));
    $("#post-count").textContent = `(${list.length} 件)`;
    const shown = list.slice(0, postLimit);
    $("#posts").innerHTML = shown.map((p) => `<div class="post">
      <div class="post-head"><span class="src ${esc(p.source)}">${SRC_JA[p.source]}</span><span>${esc(p.author)}</span><span>${fmtDate(p.created_at)} JST</span>${p.is_new ? '<span class="new">NEW</span>' : ""}</div>
      <p class="text">${esc(p.text)}</p>
      ${p.url ? `<a class="open" href="${esc(p.url)}" target="_blank" rel="noopener">元の投稿を開く ↗</a>` : ""}
    </div>`).join("") + (list.length > postLimit ? `<button class="more" id="more">さらに表示（残り ${list.length - postLimit} 件）</button>` : "");
    const more = $("#more");
    if (more) more.onclick = () => { postLimit += 30; renderPosts(); };
  }

  function renderAll(r, status) {
    report = r;
    renderMeta(r, status);
    renderHero(r);
    renderRecs();
    renderDigests(r.analysis);
    postLimit = 20;
    renderPosts();
    document.title = `${r.date} ${r.analysis.headline_ja} | Trump × Serenity 株シグナル`;
  }

  async function renderHistory(index, currentDate) {
    const el = $("#history");
    if (!index.length) { el.innerHTML = '<p class="empty">まだ履歴がありません。</p>'; return; }
    el.innerHTML = index.slice(0, 60).map((e) => `<a href="#${esc(e.date)}" data-date="${esc(e.date)}" class="${e.date === currentDate ? "on" : ""}">
      <span><span class="d">${esc(e.date)}</span>　${esc(e.headline_ja)}${e.sample ? "（サンプル）" : ""}</span>
      <span class="n">買${e.buy} / 売${e.sell} / 計${e.total}</span></a>`).join("");
    el.querySelectorAll("a").forEach((a) => a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const date = a.dataset.date;
      try {
        const r = await loadJson(`data/history/${date}.json`);
        renderAll(r, null);
        el.querySelectorAll("a").forEach((x) => x.classList.toggle("on", x.dataset.date === date));
        history.replaceState(null, "", `#${date}`);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (e) { alert(`読み込めませんでした: ${e.message}`); }
    }));
  }

  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    recFilter = b.dataset.f;
    $("#filters").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderRecs();
  });
  $("#post-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    postFilter = b.dataset.f; postLimit = 20;
    $("#post-filters").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderPosts();
  });

  (async function init() {
    try {
      const [latest, index, status, perf] = await Promise.all([
        loadJson("data/latest.json"),
        loadJson("data/history/index.json").catch(() => []),
        loadJson("data/status.json").catch(() => null),
        loadJson("data/performance.json").catch(() => null),
      ]);
      renderPerformance(perf);
      const hash = location.hash.replace("#", "");
      let r = latest;
      if (/^\d{4}-\d{2}-\d{2}$/.test(hash) && hash !== latest.date) {
        try { r = await loadJson(`data/history/${hash}.json`); } catch { /* fall back to latest */ }
      }
      renderAll(r, status);
      renderHistory(index, r.date);
    } catch (e) {
      $("#meta").textContent = "データがまだありません";
      const b = $("#banner"); b.hidden = false; b.className = "banner err";
      b.textContent = `データを読み込めませんでした（${e.message}）。GitHub Actions の「stock-tracker daily」を一度実行してください。`;
    }
  })();
})();
