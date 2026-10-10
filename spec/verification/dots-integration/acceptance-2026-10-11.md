# dots 製品側の隔離検証 — 2026-10-11

結果: **製品側の実装と fixture 検証が成功。実 dots の製品接続受入は未実施**。

対象入力の SHA-256: `aa6f504f4c0d37e50f061dfc9809dac58f41cfedd19da148d0b1ada6953603e9`。全体検証は変更のない同一入力で完了し、終了コード0。実行時間 445.932 秒。工程別結果は [verify-all.json](verify-all.json)。

| 検証 | 結果 |
| --- | --- |
| サイズ・SQL／domain 境界・文書・format・lint・型 | 成功。SQL の cross-domain 例外0件 |
| Bun: backend、coding runner、dots MCP、scripts | 1385成功、失敗0 |
| Web | 282成功 |
| client | 329成功 |
| design system | 1086成功 |
| Web build | 成功 |
| Playwright | 44成功、1 skip |

skip は既存の `voice-media.spec.ts` の macOS 条件。Chromium の fake-media が停止する既知の制約によるもので、dots の試験は実行して成功した。実マイク・ヘッドホンの受入をこの結果で代替しない。

## 委任の試験で確認したこと

- 会話の LLM が共通操作でタスクを保存し、受付の再推論で二重作成しない。
- 保存済みプロジェクト・所有者・許可操作と、役割／Skill の固定版を使用する。変更後の古い参照と、別の会話の参照を拒否する。
- claim の競合、reportId の同一再送、変更した再送、sourceSequence の欠番、epoch／generation の失効を検査する。
- Session → 質問待ち → 同じタスクへの回答 → 再開 → 条件別の根拠を付けた完了を採用する。根拠不足や他プロジェクトの Session は拒否する。
- 取消後の完了を拒否し、停止確認では保存済みの全 Session を要求する。再起動時は Session 参照と未回答質問を保持する。
- 接続の OAuth 所有者を変更して過去の仕事を渡す操作を拒否する。
- 専用の予定 command で完了・実行期限後にもリマインドを返す。重複 occurrence を拒否し、リマインドで Session を開始できない。
- 本文・報告件数の上限でも停止を採用する。Queue が満杯のときも停止要求を保存し、空きが戻ると参照を配送する。
- 実際の MCP HTTP 要求で discovery、Skill の digest と本文、所有者認証、署名付きの参照イベントを確認する。Webhook 2xx ではタスクを完了にしない。
- 実署名の JWT で issuer／audience／subject／時刻／scope を検証する。
- 報告 outbox は元の会話に一度だけ配信する。削除済み／失効した報告の本文を再採用しない。

ブラウザ試験は一時 DB と実 backend／画面を使い、接続・プロジェクトの保存、担当版の選択、依頼、MCP からの質問、画面での回答、完了・Session・根拠の表示、画面幅1280／390での収まりを確認した。Native Session と報告内容自体は fixture。

[デスクトップの確認画像](settings-1280.png) · [狭い画面の確認画像](settings-390.png)

## 残る製品受入

安定した公開 HTTPS と OAuth サービスの設定後、実 dots による新規 Session、ブロッカー、同じ Session の再開、成果・no_next_work、全子停止、再起動時の照合、実予定からのリマインドを確認する。今回、製品 DB の接続設定、実 Codex チャット、利用者の予定は変更していない。

`dots_reported` は dots の構造化した報告を採用した値で、native Session や検証結果の独立した証明ではない。Session 作成後・参照保存前の通信断と native 操作の権限制約は、dots／Codex 側でも照合・確認する。

運用手順: [docs/dots.md](../../../docs/dots.md)。設計判断: [実装計画](../../dots-toolchain-agent-skill-implementation-plan-2026-10-10.md)。
