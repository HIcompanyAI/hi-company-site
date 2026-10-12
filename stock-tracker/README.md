# Trump × Serenity 株シグナル

トランプ大統領(Truth Social **@realDonaldTrump**)と Serenity(X **@aleabitoreddit**)の株に関する投稿を毎日自動収集し、Claude がそれを読んで「どの株を買う / 売る / 様子見するべきか」を根拠付きで整理するアプリです。

- **ダッシュボード**: `index.html`(静的ページ。`npm run open` で手元のブラウザに表示。Web 公開は不要)
- **日次バッチ**: `scripts/run.mjs`。手元で `npm run daily` を叩くか、GitHub Actions(`.github/workflows/stock-tracker-daily.yml`)で毎日 07:15 JST に自動実行して `data/` にコミット
- **データ**: `data/latest.json`(最新)、`data/history/YYYY-MM-DD.json`(履歴)、`data/posts.json`(収集した投稿、90 日保持)、`data/status.json`(取得状況)

## 個人利用・非公開で使う(推奨構成)

このアプリは **自分だけが使う前提** です。公開リポジトリ(会社サイトなど)に置くと、GitHub Pages 経由でデータごと誰でも閲覧できてしまうため、次のどちらかで使ってください。

| 方式 | やること | 向いている人 |
|---|---|---|
| **A. 手元の PC だけで完結** | `scripts/` で `npm install` → `.env` 相当として `ANTHROPIC_API_KEY` を環境変数に設定 → 毎朝 `npm run daily`(取得→分析→ブラウザ表示)。データは手元の `data/` に溜まる | 毎朝 PC を開く人。GitHub 不要 |
| **B. private リポジトリ + GitHub Actions** | この `stock-tracker/` の中身を **private リポジトリのルート** に置き、`.github/workflows/stock-tracker-daily.yml` の `APP_DIR` を `.` にする。Secrets に `ANTHROPIC_API_KEY`(と任意で `X_BEARER_TOKEN`)を登録。毎朝自動で `data/` が更新されるので、`git pull` → `npm run open` で見る(Pages を有効にするなら private 用の Pages は有料プランが必要) | 自動で溜めておきたい人 |

どちらでも、ダッシュボードはローカルサーバー(`npm run open` → http://127.0.0.1:8787/)で表示します。

> ⚠ 本ツールは参考情報の自動生成であり、投資助言ではありません。小型株は SNS 投稿を契機に急騰・急落しやすく、Serenity の実績は未監査です。投資判断は自己責任でお願いします。

## 仕組み

```
Truth Social (@realDonaldTrump) ─┐
                                 ├─> scripts/run.mjs ──> Claude (claude-opus-5-5, 構造化出力) ──> data/*.json ──> index.html
X (@aleabitoreddit) ─────────────┘        │
                                          └─ 株価(stooq / Yahoo、任意)
```

1. **収集** — 2 つのアカウントの投稿を取得し、`data/posts.json` に重複なく蓄積(新着判定も行う)。
2. **分析** — 直近 7 日分の投稿 + 前日のアドバイス + 参考株価を Claude に渡し、JSON スキーマ固定で以下を生成:
   - 見出し・総括・マクロ整理・全体スタンス(リスクオン/中立/リスクオフ)
   - 銘柄ごとの `BUY / SELL / HOLD / WATCH / AVOID`、確信度(1〜5)、時間軸、根拠、リスク、注目イベント、根拠となった投稿へのリンク
   - Trump / Serenity それぞれの要点、前日からの変更点、データ欠落の注記
3. **表示** — ダッシュボードが `data/latest.json` を読み、フィルタ・履歴表示・元投稿リンクを提供。

## セットアップ(GitHub Actions で自動実行する場合)

1. **Secrets**(Settings → Secrets and variables → Actions → *Secrets*)
   | 名前 | 必須 | 内容 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | ✅ | Claude API キー |
   | `X_BEARER_TOKEN` | 推奨 | X API v2 の Bearer Token。無い場合は無料の代替ルート(埋め込みタイムライン / Nitter / RSSHub)を順に試しますが、安定性は劣ります |
   | `TRUTHSOCIAL_TOKEN` | 任意 | Truth Social API のトークン(持っている場合のみ) |
2. **Variables**(同画面の *Variables*、すべて任意)
   | 名前 | 内容 |
   |---|---|
   | `TRUTH_FEED_URL` | Trump 投稿の自前フィード URL(RSS または JSON)。例: [truthrss](https://github.com/voss/truthrss) を自分の GitHub Pages で動かした feed.xml、有料 API のプロキシ等。設定すると最優先で使う |
   | `X_FEED_URL` | Serenity 投稿の自前フィード URL(RSS または JSON) |
   | `X_NITTER_INSTANCES` | 使う Nitter インスタンスをカンマ区切りで指定 |
   | `STOCK_TRACKER_MODEL` | 使用モデル(既定 `claude-opus-5-5`) |
3. **Actions を有効化**し、Actions タブ → *stock-tracker daily* → *Run workflow* で初回実行。成功すると `data/` が更新され、ダッシュボードのサンプル表示が実データに置き換わります。
4. 以後は毎日 07:15 JST に自動実行されます(手動実行もいつでも可)。private リポジトリでも無料枠(月 2,000 分)で十分です(1 回 1〜2 分)。
5. 注意: 公開リポジトリでは 60 日間コミット等の操作が無いとスケジュール実行が自動停止します。private でも同様なので、止まっていたら Actions タブで再有効化してください。

### 投稿の取得ルート(上から順に試し、最初に成功したものを使う)

| 情報源 | ルート |
|---|---|
| Trump | `TRUTH_FEED_URL` → trumpstruth.org アーカイブ(HTML) → Truth Social API(Mastodon 互換、`TRUTHSOCIAL_TOKEN` があれば付与) |
| Serenity | X API v2(`X_BEARER_TOKEN`)→ `X_FEED_URL` → syndication.twitter.com 埋め込み → Nitter RSS → RSSHub |

どのルートも失敗した場合は、その情報源なしで分析し、ダッシュボードに「取得失敗」を表示します(`data/status.json` に詳細)。

## ローカルで動かす

```bash
cd stock-tracker/scripts
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # 分析まで行う場合
node run.mjs                              # 取得 → 分析 → ../data を更新
node run.mjs --fetch-only                 # 取得だけ(API キー不要)
node run.mjs --sample                     # ネット不要のサンプル実行(キーが無ければサンプル分析を使う)
npm test                                  # パーサ等のユニットテスト

npm run daily                             # 取得 → 分析 → ブラウザでダッシュボードを開く
npm run open                              # 既存データでダッシュボードだけ開く(http://127.0.0.1:8787/)
```

Windows の場合は `set ANTHROPIC_API_KEY=sk-ant-...`(PowerShell は `$env:ANTHROPIC_API_KEY="sk-ant-..."`)。

オプション: `--date=YYYY-MM-DD`(分析日の上書き)、`--window-days=7`(分析対象期間)、`--no-quotes`(株価取得を省略)。

## 費用の目安

1 日 1 回、入力 1〜3 万トークン・出力 3〜6 千トークン程度(投稿量による)。`claude-opus-5-5` の場合 1 回あたり概ね 0.2〜0.4 ドル。システムプロンプトはプロンプトキャッシュ対象。

## 構成

```
stock-tracker/
├── index.html / app.js / style.css   ダッシュボード(静的)
├── data/                             バッチの出力(bot がコミット)
└── scripts/
    ├── run.mjs                       日次バッチ本体
    ├── serve.mjs                     ローカル表示用サーバー(npm run open)
    ├── lib/truth.mjs                 Truth Social 取得
    ├── lib/x.mjs                     X 取得
    ├── lib/prices.mjs                株価(任意)
    ├── lib/analyze.mjs               Claude 分析(zod スキーマで構造化出力)
    ├── lib/util.mjs                  共通処理(RSS パーサ等)
    ├── fixtures/                     サンプル投稿・サンプル分析
    └── test/                         ユニットテスト
```
