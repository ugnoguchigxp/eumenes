# 日常の複数操作担当 P0 契約・基準

2026-10-21。実装依頼により計画への合意を受領。基準commitは `f17cbde1`。

基準試験: retained-toolchains、request-analysis、browser-toolchain、playground-concurrencyの38件、311検査、失敗0、4.34秒。固定Providerによる検証であり、実モデル・実機の結果ではない。

## 凍結する契約

- 親はagent-runtimeが所有。会話runは原発言への参照であり、親の寿命ではない。子は親ID/依頼版/手順番号で一意。状態と結果は同じwriterで次のQueueジョブへ接続する。
- `task` bindingは画面なし。profile/Skillはpackageから解決。実行APIは開始・状態・回答・訂正・取消・参照読取り/検証。既存型のrevisionは変更しない。
- 親推論12、子呼出し6、探索3、候補4、Eumenesの親子推論48。最終親推論1回と45秒を予約。絶対期限300秒、親推論45秒。承認・訂正・再配送でリセットしない。
- 保持能力4件/4,096推定token、参照32件、質問は同時1件/通算3件。親状態64KiB、開始入力24KiB、結果16KiB、読取り応答8KiB。親は一回一関数、子は直列。
- 同一会話の未終了親4件、ホスト全体32件。容量拒否は開始前。結果の本文は所有domainを正本とする。親入力/手順/質問本文は14日、最小receiptは30日。忘却時は即時失効。期限後の古い開始/回答イベントを再実行しない。
- Memory参照は選択したitemと元発言の版/digestに結ぶ。Window更新だけで失効させない。原文とbriefを分離し、briefから許可を作らない。
- 固定試験の単純経路は追加分類・親起動・能力探索0。入力増分は既存のMemory割当と制御定義1,024推定token以内。host追加時間100ms以内。実モデルは同条件各3回の中央値/範囲を記録し、単純経路の中央値は基準×1.25+250ms以内を初期採用条件とする。変更には測定根拠と計画の更新が必要。

## 合意済みの進行契約改訂（2026-10-21）

[改訂案](../../everyday-task-agent-progress-contract-proposal-2026-10-21.md)に利用者合意を受領。最初の親推論でLLMの操作計画を保存し、host発行stepRefで子とreceiptを結ぶ。再送は同じ子を返し、入力変更は競合。未実行部分だけを改訂し、全項目実行後は終了関数だけを提示する。依頼版・計画版を分け、訂正・改訂で予算と期限を戻さない。意味・条件・担当・完了判断はLLMが担う。

## 型ごとの接続と検査

| 型 | 開始・結果・質問 | 取消・参照・予算 |
| --- | --- | --- |
| research: web/history/world | 凍結packageで子coordinatorとworkerを起動。検証済みprojectionと出典を親へ配送 | 子の木だけを取消。元発言/World/取得資料を既存検査へ通す。子推論の上限を予約 |
| bound command | 共通のcommand翻訳、登録schema/snapshot、DomainAdapter。受付と非同期の終了を区別 | 実行所有者origin、同じ開始キー、domainの公開取消、子予算を使用 |
| instant | 登録schemaと既存instant adapter。fallbackは明示的な子として追跡 | 同じ参照検査と全体期限。ネットワークはwriter外 |
| browser | 原文refとbriefを分離。task全体の完了先を親へ。needs_input後は同じ論理子に新taskを関連付け | 既存grant/Script/排他を維持。親期限と推論残量を引継ぐ |
| image/music/excalidraw | 呼出し単位IDと元runを分離し、所有domainの受付/成果物を接続 | 所有domainの取消・結果照会・budgetを通す。同型二回と再送を別々に検証 |
| 旧command/object-recognition/dots | 共通翻訳と既存の公開port。カメラ等の同意と添付refを維持 | 元runを偽装しない。外部担当の内部推論は総48回に含めず、既存外部予算/期限で制約 |
| session | 会話への引継ぎrefとpartialを返す。本人との直接対話へ接続 | 未保存作業の確認を維持。親の再帰・隠れた回答を禁止 |

catalogは個別IDの許可リストにせず、binding/runtimeの対応、可用性、公開契約で判定する。未接続型は候補から除外し、型・実登録の結合試験が揃うまで全体完了にしない。

## 進捗

P0は確定済み。P1〜P5は実装・固定試験済み。P6は正式検証と公開入口の結合試験に成功したが、実モデル受入は不合格、実ブラウザー再生は未達。採用条件に従い新担当だけを無効化し、通常seed後もその状態と既存23担当を確認した。利用者の包括許可により通常の開発サーバーを復帰済み。成否・未実施の依存試験・再開条件は[実装・検証記録](implementation-verification-2026-10-21.md)に記載する。

改訂後: 小さいLLM計画・stepRef・終端の関数制限を実装。公式Bun764件・Web75件成功、実モデル二操作は0/3で未達。[最新記録](progress-contract-verification-2026-10-21.md)を参照。
