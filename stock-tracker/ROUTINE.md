# Routine(Claude Code 定期実行)の手順書

毎朝 07:40 JST に Claude Code の Routine が新しいセッションを起動し、以下を行う。
API キーは使わない(分析はセッション内の Claude が行う)。

## 前提
- 07:15 JST に GitHub Actions(`.github/workflows/fetch-daily.yml`)が 3 情報源(Trump / Serenity / Citrini)の投稿と株価を取得し、`data/posts.json` / `data/quotes.json` / `data/prices.json` / `data/performance.json` をコミット済み
- このリポジトリ `HIcompanyAI/stock-tracker` に push 権限がある

## 手順
1. リポジトリを `add_repo`(push 権限)してクローンし、`main` を最新にする
2. `cd scripts && npm ci`
3. `data/posts.json` の `last_fetch.*.fetched_at` が 20 時間以上前なら、取得が走っていない。`node run.mjs --fetch-only` を試し、ネットワーク制限で失敗したら手元のデータのまま続行し、報告に書く
4. 新着判定: `last_fetch.*.new_count` が全情報源で 0 で、かつ `data/latest.json` が前日分なら **分析をスキップ**し「新着なし」とだけ報告して終了
5. `node run.mjs --prepare` → `data/pending/input.md` が出来る
6. `input.md` を**全部**読む。先頭の「分析ルール」に従い、`data/pending/schema.json` に厳密に合う JSON を **日本語で** `data/pending/analysis.json` に書く
   - 推奨銘柄は投稿に根拠があるものだけ。`source_post_keys` に必ず投稿の key を入れる
   - `conviction` は 1〜5 の整数。ティッカーの重複禁止。`source_digests` は全情報源分(trump / serenity / citrini)を必ず入れる
   - 期待値を優先する: 複数情報源の一致を上位に、投稿後 +15% 以上上げた銘柄は BUY にしない、`plan_ja` に損切り・利確の目安を書く
   - 「情報源別の実績」が input.md にあれば、成績の悪い情報源の conviction を下げる
   - 前日のアドバイスがあれば連続性を保ち、変更点を `changes_from_yesterday_ja` に書く
7. `node run.mjs --finalize` を実行。検証エラーが出たら `analysis.json` を直して再実行(最大 3 回)
8. `git add data && git commit -m "analysis: YYYY-MM-DD" && git push origin main`
9. 報告(日本語・短く): 見出し、BUY/SELL/WATCH の件数、取得失敗した情報源、`data/performance.json` の的中率(20 営業日)と仮想運用額、スキップした場合はその旨

## やらないこと
- Anthropic API を呼ばない(費用が発生する)
- `scripts/` や `index.html` などコードを変更しない(変更が必要だと思ったら報告だけする)
- 投稿に無い銘柄を推測で足さない
