/**
 * 追跡する情報源の定義。X アカウントは X_EXTRA_USERNAMES(カンマ区切り)で追加できる。
 */
export const SOURCES = [
  {
    id: "trump",
    kind: "truth",
    label: "Trump",
    author: "Donald J. Trump (@realDonaldTrump)",
    description:
      "Donald J. Trump 大統領(Truth Social @realDonaldTrump)。関税、FRB・金利、規制、補助金、特定企業・CEO・業界への称賛や非難、通商交渉など。マクロ/セクター単位で株価に影響する。企業名や業界が名指しされた場合は該当ティッカーを特定する。発言は撤回・反転されやすい。",
  },
  {
    id: "serenity",
    kind: "x",
    username: "aleabitoreddit",
    label: "Serenity",
    author: "Serenity (@aleabitoreddit)",
    description:
      "Serenity(X @aleabitoreddit)。AI ハードウェアのサプライチェーンで「ボトルネック」になる小型株(光通信/CPO、InP、SiPh、化合物半導体、レーザー等)を深掘りする匿名アナリスト。第三者採点の的中率は約 60%(274 件)。投稿が小型株を急騰させた実績がある一方、ポンプ批判もあり、月間 −49% のドローダウン歴がある。テーマの検証には 5〜60 営業日かかることが多く、1 日のコピートレード向きではない。",
  },
  {
    id: "citrini",
    kind: "x",
    username: "citrini",
    label: "Citrini",
    author: "Citrini Research (@citrini)",
    description:
      "Citrini Research(X @citrini)。テーマ投資・マクロのリサーチ。第三者採点の的中率は約 64%(81 件)で追跡対象中トップ。年次のテーマ別ウォッチリスト(2025 年は等金額バスケットで +26.5%、S&P 500 は +15%)。本体は有料レターで、X には要点のみ流れる。中長期のテーマ(自動化、肥満薬、消費など)が中心。",
  },
];

for (const u of (process.env.X_EXTRA_USERNAMES || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!SOURCES.some((s) => s.username === u)) {
    SOURCES.push({ id: u.toLowerCase(), kind: "x", username: u, label: `@${u}`, author: `@${u}`, description: `X @${u}(追加の情報源)` });
  }
}

export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const byId = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
