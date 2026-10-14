# Trump × Serenity 株シグナル

トランプ大統領(Truth Social **@realDonaldTrump**)、Serenity(X **@aleabitoreddit**)、Citrini Research(X **@citrini**)の株に関する投稿を毎日自動収集し、Claude がそれを読んで「どの株を買う / 売る / 様子見するべきか」を根拠付きで整理するアプリです。推奨はその後の株価で自動採点され、情報源ごとの的中率と 1 万円の仮想運用成績がダッシュボードに出ます。

- **ダッシュボード**: `index.html`(静的ページ。`npm run open` で手元のブラウザに表示。Web 公開はしない)
- **取得**: GitHub Actions(`.github/workflows/fetch-daily.yml`)が毎日 07:15 JST に投稿と株価を取得して `data/` にコミット(無料)
- **分析**: Claude Code の Routine が毎日 07:40 JST に `ROUTINE.md` の手順で分析し、`data/latest.json` をコミット(Claude のサブスクリプション内。API 費用なし)
- **データ**: `data/latest.json`(最新)、`data/history/YYYY-MM-DD.json`(履歴)、`data/posts.json`(収集した投稿、90 日保持)、`data/quotes.json`(当日株価)、`data/prices.json`(終値の履歴)、`data/performance.json`(前向き検証の成績)、`data/status.json`(実行状況)

## 情報源と「当たりやすさ」の根拠

| 情報源 | 役割 | 第三者採点の的中率(Quantral、6 か月) |
|---|---|---|
| Trump(Truth Social) | 関税・金利・規制などマクロ/セクターの追い風・逆風 | 採点なし(単独では確信度 3 以下に制限) |
| Serenity(@aleabitoreddit) | AI 半導体サプライチェーンの小型株 | 59.5%(274 件) |
| Citrini Research(@citrini) | テーマ投資・マクロのバスケット | 64.2%(81 件)。2025 年の推奨バスケット +26.5% vs S&P 500 +15% |

分析ルール(`scripts/lib/analyze.mjs` の `SYSTEM_PROMPT`)は期待値を優先するよう組んであります: 複数情報源の一致を最優先、投稿後に +15% 以上上げた銘柄は追いかけない、保有期間は 5〜60 営業日、全推奨に損切り・利確の目安(`plan_ja`)を付ける、実績の悪い情報源の確信度を下げる。追加の X アカウントは環境変数 `X_EXTRA_USERNAMES`(カンマ区切り)で足せます。

## 前向き検証(成績)

毎日の取得時に `data/prices.json` へ終値を蓄積し、過去の推奨を次のルールで採点して `data/performance.json` に書きます(`node run.mjs --perf` で手動再計算も可)。

- 的中 = BUY なら上昇、SELL/AVOID なら下落。WATCH/HOLD は採点しない。期間は 5 / 20 / 60 営業日
- 仮想運用 = 1 万円スタート。各 BUY 推奨に資金の 10% を投じ、20 営業日後に売る。同期間に SPY を持った場合と比較
- 採点結果は翌日以降の分析プロンプトにも渡され、成績の悪い情報源の確信度が自動的に下がる

## 毎朝の使い方

```bash
git pull
cd scripts && npm run open        # http://127.0.0.1:8787/ がブラウザで開く
```

## 構成の選び方

| 方式 | 費用 | やること |
|---|---|---|
| **Routine 方式(採用)** | 追加費用なし | Actions が取得、Claude Code の Routine が分析。詳細は `ROUTINE.md` |
| API 方式 | 1 回 0.2〜0.4 ドル | Secrets に `ANTHROPIC_API_KEY` を入れ、Actions を `analyze=true` で実行するか、手元で `npm run daily` |
| 手元だけで完結 | API 費用のみ | `npm run daily`(取得 → API 分析 → 表示)。GitHub 不要 |

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
   - 銘柄ごとの `BUY / SELL / HOLD / WATCH / AVOID`、確信度(1〜5)、時間軸、根拠、リスク、注目イベント、売買プラン、根拠となった投稿へのリンク
   - 情報源ごとの要点、前日からの変更点、データ欠落の注記
3. **表示** — ダッシュボードが `data/latest.json` を読み、フィルタ・履歴表示・元投稿リンクを提供。

## セットアップ

Routine 方式では GitHub 側の設定はほぼ不要です(Actions が有効なら動きます)。`X_BEARER_TOKEN` 等は任意です。

### GitHub Actions の Secrets / Variables(任意)

1. **Secrets**(Settings → Secrets and variables → Actions → *Secrets*)
   | 名前 | 必須 | 内容 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | API 方式のみ | Claude API キー。Routine 方式では不要 |
   | `X_BEARER_TOKEN` | 推奨 | X API v2 の Bearer Token。無い場合は無料の代替ルート(埋め込みタイムライン / Nitter / RSSHub)を順に試しますが、安定性は劣ります |
   | `TRUTHSOCIAL_TOKEN` | 任意 | Truth Social API のトークン(持っている場合のみ) |
2. **Variables**(同画面の *Variables*、すべて任意)
   | 名前 | 内容 |
   |---|---|
   | `TRUTH_FEED_URL` | Trump 投稿の自前フィード URL(RSS または JSON)。例: [truthrss](https://github.com/voss/truthrss) を自分の GitHub Pages で動かした feed.xml、有料 API のプロキシ等。設定すると最優先で使う |
   | `X_FEED_URL` | Serenity 投稿の自前フィード URL(RSS または JSON) |
   | `X_NITTER_INSTANCES` | 使う Nitter インスタンスをカンマ区切りで指定 |
   | `STOCK_TRACKER_MODEL` | 使用モデル(既定 `claude-opus-5-5`) |
3. Actions タブ → *fetch daily* → *Run workflow* で初回の取得。以後は毎日 07:15 JST に自動実行(private でも無料枠で十分。1 回 1〜2 分)。
4. 注意: 60 日間リポジトリに人の操作が無いとスケジュール実行が自動停止することがあります。止まっていたら Actions タブで再有効化してください。

### 投稿の取得ルート(上から順に試し、最初に成功したものを使う)

| 情報源 | ルート |
|---|---|
| Trump | `TRUTH_FEED_URL` → trumpstruth.org アーカイブ(HTML) → Truth Social API(Mastodon 互換、`TRUTHSOCIAL_TOKEN` があれば付与) |
| Serenity / Citrini(X) | X API v2(`X_BEARER_TOKEN`)→ `X_FEED_URL` → syndication.twitter.com 埋め込み → Nitter RSS → RSSHub |

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

node run.mjs --fetch-only                 # 取得だけ(Actions と同じ)
node run.mjs --prepare                    # Routine 用の入力(data/pending/)を作る
node run.mjs --finalize                   # data/pending/analysis.json を検証して反映
node run.mjs --perf                       # 過去の推奨を株価で採点し直す
npm run daily                             # API 方式: 取得 → 分析 → ブラウザでダッシュボードを開く
npm run open                              # 既存データでダッシュボードだけ開く(http://127.0.0.1:8787/)
```

Windows の場合は `set ANTHROPIC_API_KEY=sk-ant-...`(PowerShell は `$env:ANTHROPIC_API_KEY="sk-ant-..."`)。

オプション: `--date=YYYY-MM-DD`(分析日の上書き)、`--window-days=7`(分析対象期間)、`--no-quotes`(株価取得を省略)。

## 費用の目安(API 方式の場合)

1 日 1 回、入力 1〜3 万トークン・出力 3〜6 千トークン程度(投稿量による)。`claude-opus-5-5` の場合 1 回あたり概ね 0.2〜0.4 ドル。システムプロンプトはプロンプトキャッシュ対象。

## 構成

```
stock-tracker/
├── index.html / app.js / style.css   ダッシュボード(静的)
├── ROUTINE.md                        Claude Code Routine の手順書
├── .github/workflows/fetch-daily.yml 取得ワークフロー
├── data/                             バッチの出力(bot / Routine がコミット)
└── scripts/
    ├── run.mjs                       日次バッチ本体
    ├── serve.mjs                     ローカル表示用サーバー(npm run open)
    ├── lib/truth.mjs                 Truth Social 取得
    ├── lib/x.mjs                     X 取得
    ├── lib/prices.mjs                株価(任意)
    ├── lib/sources.mjs               追跡する情報源の定義
    ├── lib/performance.mjs           前向き検証(的中率・仮想運用)
    ├── lib/analyze.mjs               Claude 分析(zod スキーマで構造化出力)
    ├── lib/util.mjs                  共通処理(RSS パーサ等)
    ├── fixtures/                     サンプル投稿・サンプル分析
    └── test/                         ユニットテスト
```
