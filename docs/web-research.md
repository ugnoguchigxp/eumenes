# Web 取得

Web取得はnpm版 `llm-fetch@0.1.2` をbackendから利用します。検索と通常のページ取得は毎回実行し、`web read --stable` で指定したページだけ専用SQLiteに保存します。`--fresh` は保存済み本文を使わず取得し直します。保存データは最大24時間だけ再利用し、14日間使われなければ起動時・1時間ごとの掃除で削除します。HTTPが保存を禁止するページは保存しません。結果の受取期間は15分で、backendの再起動でも失われます。会話からの調査は、能力の検索→プロフィール・SKILL・必要なツールの読込み→子の調査→要約→回答の順に実行します。全ツールをモデル入力へ展開しません。天気は気象庁、明示tickerの株価は公開市場JSONの読取りを先に試します。詳しい状態は [実装計画書](../spec/web-research-cache-implementation-plan-2026-10-09.md#15-着手後の実装記録2026-10-09) に記録します。

関連: 取得先と手順の学習は [research-routes.md](research-routes.md)、会話からの調査は [toolchain.md](toolchain.md)。
