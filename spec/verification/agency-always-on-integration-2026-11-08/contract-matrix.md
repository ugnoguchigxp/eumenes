# 契約と検証の対応

P0で確認した既存の公開操作を拡張・再利用する。SQLと業務上の強制はdialogue等の所有domainに置き、applicationは組み立てと接続を担う。

| 契約 | 実装・出口の証拠 |
| --- | --- |
| AO-B1 実在票による権限 | `agency-actions.ts` / `repository/agency.ts`。always-on票とprepare状態、能力revision、完全一致する引数と入力を検査。`always-on-authority.test.ts`で偽票を拒否し、実際の画像executionで受付を確認 |
| AO-B2 観測の全出典 | 上流`observe(input, context)`と`observationInputs`。Eumenesの原発言・回答run・画像・Memory版を渡す。上流`host-contracts.test.ts`、訂正・忘却・完全性のホスト試験 |
| AO-B3 原観測と復元 | `always-on-memory.ts` / `agency-state-memory.ts`。既存Recordsへ本文を保存し、envelopeを識別・検査。未知形式・原記録欠落・再起動で別scopeを保持 |
| AO-B4 Memoryの正本 | `known`を渡した場合、上流はstated/observedの作成・変更・旧保存の復活を拒否。空のknownも正本指定として扱う。上流8境界試験 |
| AO-B5 通常応答の入力 | `always-on-ports.ts`のStateと同じsnapshotの入力manifestを既存背景入力へ渡す。確定した通常応答の後に既存stock操作で整理する結合試験 |
| AO-B6 評価条件 | 配布物・59ソース・指示catalog digest・schemaを記録。実モデルの努力度・cache・待ち時間と費用の評価はP7未実施 |
| AO-N1 遅延receiptと忘却 | 上流はissuedを失効し、receiptで忘却・期限を再検査。Eumenesも配送writerで出典・会話世代・設定を再検査 |
| AO-N2 過去thoughtの依存閉包 | モデルが実際に読んだ全セクションの元出典を継承。引用したかに依存しない。20件窓外の出典と連鎖忘却を上流回帰で確認 |
| AO-N3 tickなしの期限 | 上流workReturnedで6時間の境界を検査。ホストの30分期限、取消、既存実行台帳も維持 |
| AO-N4 通常依頼の同一性 | 通常依頼は既存delegate/runの受付を使用し、Eumenesへstart_preparationは追加しない。上流のrequestPrepareも呼出元・能力入力を検査 |
| AO-N5 推論の独立 | inferenceのindependent auxiliary controlとLARMの独立生成枠。onConversation/yieldsとの併用を拒否。容量fixtureで相互preemptがないことを確認 |
| AO-N6 実配送 | 文字配送と復旧の一度だけのreceipt、Live受付を成功にしない試験。Liveの実字幕との因果ID接続は未完了 |
| AO-N7 保存の一貫性 | revision付きcapture、全scopeとfeedの同一writer、結果採用のrollback、scheduler更新後の保存。保存待ち中に変わったcaptureを拒否する試験 |
| AO-N8 成果物 | 既存Work/Resource台帳でprepare票とexecutionを結び、返却stockから実成果物を共有。画像担当を通す試験と通常応答での既存State照合 |
| AO-N9 設定・切替 | optionalな新キーで旧設定を維持。保存・再読込、既存画面のrevision追加、排他的切替・切り戻しを確認 |
| AO-N10 busy | 内容を含まない画面lease、単調revision、有効期限、二画面、hidden再生、画面離脱、foreground生成。Web・lease・ホストの固定試験 |

実装中の追加境界AO-N11〜N17はREADMEの対応表に記載した。未実施を含む段階の全体完了は宣言していない。
