# 会話メイン200k・サブ既定128kの接続管理

2026-11-01。利用者が本チャットで指定した契約を実装する。既存の接続キャッシュ設計の「backend共有メイン・入力先頭別補助」を、利用者指定の「会話・エージェント別」に更新する。LLMの判断方式・Profile選択・音声Provider選択は変えない。

## 根拠と範囲

LARMの `/srv/ai/apps/local-LLM-harness/specs/mesh-resource-wait-investigation-2026-10-31.html` をgnosisで読み取り確認。11月1日の最終受入は、contextTokens=200000、省略=131072、生成時の1+2枠、通常Bearer・JSON・SSE、接続再作成後のprompt_cache_key復元を記録している。Eumenesの既存create/get/claim/renew/release・Provider生成・取消フェンスを再利用する。LARM、設定値、認証方式、ツール登録、音声出力経路、サーバーの稼働状態は変更しない。

## 対応と寿命

- inferenceへ渡す構造化セッション情報（sessionRole、taskId、会話ID・エージェントID・履歴分岐ID）だけで役割と所有者を決める。本文・connection IDを解釈しない。
- 実会話のrouted turnが会話IDを明示する。メインエージェントの論理IDは会話ID、サブは既存task/session ID。独立補助は管理上のrequest IDを使う。会話に属さない要求はconversationId=nullとする。
- backendの接続管理表は論理ID→役割・要求容量・client・port（返されたconnection ID、bootEpoch、期限、Provider credentialを持つ既存lease）を保持する。同じ有効接続を再利用する。接続数と生成枠を混同せず、空いている他エージェントの接続を追い出して枠を作らない。
- clientとprompt_cache_keyはインストールの既存安定clientと論理IDから別の用途で導く不透明な値。役割と容量も分け、cache keyは接続再作成後も同じ。履歴分岐IDを受け付け、未分岐ではその会話のprimary履歴を使う。毎回messagesを送る。
- 既存のonConversation補助は主エージェント自身のprefix読取りとして、同じ会話メイン接続と直列枠を使う。独立サブは200kへ昇格しない。

## 接続契約と実行

メインのみcontextTokens=200000、サブは省略。Provider subset・audience・保存Profile・catalog revisionは既存経路を維持する。createの通信再試行は同じUUID、claimには冪等キーを付けない。ready・対象Provider claimableと実際のcontextWindowを照合し、claimにも同じ容量を要求する。catalogの既定容量とmainのclaim容量の差だけは許容し、他の契約検証を維持する。

生成は既存OpenAI bodyへprompt_cache_keyだけを加える。Provider Bearerを使用し、独自connection/role/slot項目や内部ヘッダーを加えない。backend全体でmain=1、sub/独立補助=2の取消可能な待機列を共有する。自然終了まで枠を保持し、既存128k接続の実行を中断しない。新clientは役割・容量で分離するため旧128kメインを再取得しない。

既存renew・再claimで期限を更新する。connection/credentialの短い方を期限とする。bootEpochの変化、失効、idle releaseは既存再作成へ戻す。生成POSTの不明な結果は再送しない。既存の受付前ライフサイクル拒否に限る再試行は維持する。

## 作業・完了条件

1. 変更前の接続・直列化・安定client試験（20件成功）を基準にする。
2. 部分試験で容量不一致拒否、作成UUID再利用、claim認証、同一/別会話・agent・branch、renew/epoch/idle、キャッシュkey、JSON/SSE、1+2枠・取消を確認。
3. 実会話入口の結合試験でmain情報がLARMへ届くことを確認。larm/inference/dialogueと影響するagent/tool/voice domainのverifyを順に実行し、既存差分の失敗は分離して記録する。
4. 保存設定の読み取り専用操作を使ったliveで容量・通常生成を確認する。サーバー起動・再起動、稼働中生成の停止は行わない。配備・稼働への反映はfixture/liveと分けて報告する。
5. 差分を点検し、本文依存の判断、credential/本文ログ、無関係な変更が増えていないことを確認する。

## 実装・検証結果

指定した接続管理を実装し、対象domainのverify（backend 1616件・Web 95件）を通過した。実LARMの初回生成確認と追加再確認時の503、稼働backendへの反映未確認を区別した[受入記録](verification/larm-agent-capacity-2026-11-01/acceptance.md)を参照。サーバー操作は行っていない。
