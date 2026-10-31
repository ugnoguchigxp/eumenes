# World配布物更新と根拠保持（2026年10月31日）

ユーザーは本日、eumenes本体の更新と必要な改修を許可した。WorldModel側のM1〜M3の機械的な保持・選択改善を受け取り、既存のWorld照会経路で条件を落とす問題を修正する。新しい判断方式、ツール、選択順位、フォールバックは追加しない。

## 目的・範囲

- WorldModelの配布tgzを内容digest付きの新しいファイルへ固定。DB migration、公開export集合、既存host契約の互換性を照合する。旧tgzは残す。
- `world.query`が出典参照のdigest/representationを捨てないようにする。版manifestは版単位、引用範囲とquote digestは既存Evidence型のまま別に保持する。
- 既存`sourceOf`と条件の表示関数を再利用する。値・述語・条件の文字数による切断を除き、同じSource/版/digestの経路へ渡す。意味の採否は従来どおりLLM、コードは権限・版・予算の検証を担う。
- 既存の対象名解決、whole-itemの表示予算、部分取得の表示、採用時の版/忘却/出典検査を維持する。長い根拠を確実に見せるために予算を引き上げない。
- Sliceの主張指定契約はhostの実SQLiteと更新配布物で互換試験するが、モデル向けに新しいツールや既定選択を公開しない。M4の固定モデル・未見意味品質とM5の運用受入は未達のまま。

## 依存・検証・完了条件

1. 変更前の対象ファイルとhash、既存World試験結果を`verification-reports/world-integration-2026-10-31/`へ保存する。
2. 長い値・複合条件・期間、完全な出典ref、版指定Sliceの部分試験を追加し、旧実装の欠落を確認する。
3. 配布物更新・最小修正後に部分試験→`bun test ./api/domains/world/test ./api/application/world`→会話のWorld調査経路を検証する。生成はscripted fixtureと区別する。失敗したら対象差分に起因するかを調べ、担当外は修正しない。
4. `bun run verify -- --domain world --domain agent-runtime --domain tool-runtime --domain steward`を実行する。静的全体検査の担当外所見は別記。WorldModel側は既存verify/buildの通過証拠と新配布manifestを照合する。
5. 結果・配布hash・変更前後の欠落・残件と差分点検を本書へ追記する。製品DB・設定・秘密、サーバー起動/停止/再起動、外部repoへの配信、commit/pushは行わない。

## 状態

- 着手時: 本体には多数の他作業差分がある。変更前snapshotを保持し、既存差分を戻さない。
- 配布の事前照合: 新旧ともmigration 7本とhash・公開export一覧は一致。
- 上記の改修・検証・差分点検は完了。実モデル受入と稼働中サーバーへの反映は別の未実施事項。


## 実施結果

- 新配布物: `vendor/world/eumenes-world-model-0.0.1-be38c74a8016.tgz`。SHA-256 `be38c74a80166f32c53b4bbe3bada3c9280a42980bc0be132ed4c4cf804e8769`、runtime source digest `f5963ee9152fae95dd18ef566a967718f4798ef0230d7c47221a0f0537ba801e`。元commit `06e948047b34361e6ac469f33747601869522af4`に未commitのsrc変更があるため、commitだけで識別しない。配布内manifestとhostの`vendor/world/manifest.json`で識別情報を保持する。
- package.json・lock・checksum・manifest・インストール済み配布のsource digestを照合する。旧tgzを残し、Memory/Agencyを含む他依存の宣言と既存差分は維持した。DB migrationは7本とも同一、公開exportの追加/削除なし。
- `basisOf`で元のEvidenceと完全な版manifestを渡す。投影の版manifestがrangeを除くのは既存契約であり、そこへrangeを混ぜずEvidenceに引用範囲を保持する。
- `sourceOf`の値/述語/条件の切断と空白正規化を除去。有効期間は条件計算の有無によらず保持する。対象名解決と既存の表示・取得上限、条件評価、採用時検査は維持する。

### 検証

| 段階 | 結果 |
|---|---|
| 変更前World結合 | 212 pass / 0 fail / 29 files |
| 変更前の再現 | 長文/条件末尾、出典refの欠落、未対応の主張指定を3件とも再現 |
| 追加部分 | 4 pass / 0 fail（新規3＋既存条件評価1） |
| World結合 | 217 pass / 0 fail / 2646 assertions / 30 files。新規5件を含む |
| 配布・migration・steward利用側 | 133 pass / 0 fail / 1238 assertions / 21 files |
| 固定コピーの領域verify | world / agent-runtime / tool-runtime / steward。457 pass / 0 fail、UI 17 pass / 0 fail。format/lint/型/境界/SystemContext/SQL境界とDesignSystem buildも通過 |

新規5件は、全文とdigest、実SQLiteの引用範囲、主張ID/版のSlice選択と訂正による旧receipt拒否、登録済み調査経路→引用片→報告採用、予算超過のpartialを検証する。後半2件は実store/queue/登録toolchainを使うscripted inferenceであり、実モデルの意味品質ではない。

同じ合成入力・表示関数を比較した[保持計測](../verification-reports/world-integration-2026-10-31/retention-comparison.json)では、変更前は値/述語/条件末尾が欠落、変更後はすべて保持。有効期間は両方保持。Source本文は1035→1524 UTF-8 bytes。これは本文だけの量で、最終要求全体のbytesや速度向上、正答率を意味しない。既存8192/12288 bytesのquery表示枠、24件/24KiBのreading上限は引き上げていない。

### 証拠の固定と制約

元作業ツリーの領域検証は344件＋UI17件が通ったが、実行中のソース変更を検出しinvalidatedとなったため最終合格にしなかった。製品data・設定・環境ファイルを除く固定コピーを作り直し、stewardも含めて再検証した。最初のコピーで除外してしまった版管理済みの音声仕様JSONは復元し、製品データはコピーしていない。

最終[verify report](../verification-reports/world-integration-2026-10-31/fixed-verification/report.json)はpass。入力/終了revisionは両方`a88f297e7516ce55271d374bd989b8827ff14e2e3205e9b39cbfe01c58d0c9e1`で、integrityErrorsは空。今回の実装・依存・試験ファイル11本は[hash照合](../verification-reports/world-integration-2026-10-31/verified-target-files.json)で固定コピーと現作業ツリーの一致を確認した。文書更新はこの固定結果とは分ける。

担当外所見はkanban/timersの境界4件、Agency/server/UI等のサイズ6件。修正していない。検証の期待値や基準は弱めていない。追加試験で旧「切断あり」の期待は全文一致へ強化した。氏名・語句・例題による意味分岐、新writer/queue/HTTP、製品DB・設定・秘密の変更、サーバー操作はない。

残るものはG5の固定モデル同定と正式な実モデル比較、M3の未見の意味選択、M5の実仕事受入。主張指定契約の追加を根拠に、これらを受入済みへ変更しない。稼働中サーバーの再起動・製品データの移行・公開・commit/pushは実施していない。
