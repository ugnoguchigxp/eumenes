# Works P2 会話からの制作

2026-11-28 JST。macOSの一時ディレクトリに、試験用SQLite、独立した二つのGitリポジトリ、Works固定版 `2.0`、Web配信、Claude Codeランナーを用意した。会話と担当の判断には固定応答を与え、登録済みツールの検索、依頼の受付、権限と排他、Claude Codeの実行、結果参照は既存の経路を使った。Claude Codeは試験用のソースを実際に編集し、Google Chromeで本体Webの結果リンクから作品を表示した。

| 手順 | 確認内容 |
| --- | --- |
| 初回 | 開いていないAlphaを会話で名前指定した。Claude Codeで編集し、登録済みの型検査とビルドを実行した。結果リンクを押し、プレビューに初回の見出しが出た。 |
| 再修正 | 同じ会話で結果の作品参照を使い、新しい作業として同じ作品を編集した。2種類の検査を再実行し、結果リンクを押して変更後の見出しを見た。 |
| 検査と排他 | 意図的な型エラーで型検査とビルドが失敗した。別作品・`.env` の読取り、作品内のインストール、Git操作は試験で拒否された。編集中の登録解除も拒否された。 |
| リポジトリ | AlphaのHEAD、インデックス、stash、先に編集したREADMEと、Betaのソースを保持した。作品に個別の `node_modules` と `bun.lock` は生じなかった。 |

製品サーバーと製品DBは試験対象から外した。試験用のWebとプレビューはループバックで配信し、終了時に両方の待受が閉じたことを確認した。Claude Codeランナーは既存の既定ポリシーで構成した。 [試験結果](result.json)

## 依存追加、停止と待機

| 手順 | 確認内容 |
| --- | --- |
| 依存追加の承認 | 実Claude Codeが追加した `nanoid` のimportを登録済み検査が検出し、会話に版・用途・承認コードが出た。利用者の発話に承認コードがない場合、担当が承認を渡しても受付は進まなかった。実際の承認後は共有環境に固定版 `2.1` を発行した。 |
| 同じ仕事の再開 | 作業IDを維持し、実行IDと世代を更新した。Alphaだけが `2.1` に切り替わり、再度の型検査・ビルド・Chrome表示が通った。共有環境のGitタグ間の差分は依存宣言・ロック・解決表。作品に個別の依存やロックを作らなかった。 |
| 否認と競合 | 否認、取消、承認前の入力変更で追加処理を開始しなかった。編集の競合ではCodex側が保存した内容を保持し、Claude Codeの未適用案を記録した。公開直後の版、インストールスクリプトを要する版、レジストリ外の配布を拒否した。 |
| 排他と復旧 | 停止応答を失う固定試験で、再起動後も対象作品の枠を保持し、別作品は実行できた。誤った世代の停止証跡を拒否し、正しい証跡で待機していた仕事を開始した。 |
| ランナー | 実際に登録した5作品を、依頼なしで複数回点検して追加起動0件。実ランナーは約60秒で試験用ソケットを閉じ、状態照会では再起動しなかった。実行中の待機終了要求と別の起動識別子を拒否した。 |
| 対象の固定 | 同名が複数ある場合、名前だけで作品を選ばなかった。別作品を画面で開いた状態でも、会話の参照で指定したAlphaの仕事を続けた。 |

追加受入では同名2件を実際の会話経路で提示した。回答に続いて選択した1件の作業が一度だけ始まった。実Claude Codeに意図的な型エラーを残させると両方の登録済み検査が失敗し、完了と作品参照の登録を拒否した。

依存追加の試験では、完了後に会話へ登録された作品参照を解決し、実際のWorks画面を開いた。会話の結果チップからの画面遷移は通常の制作試験で確認した。

固定版 `2.0` に残したBetaとGammaをEumenes内・単体の両モードで再ビルドし、JavaScript・CSS・素材を含む4組の出力SHA-256が追加前と一致した。

一時チェックアウトの `verify --domain prototype` と、P1のChrome・単体実行の回帰試験に合格した。Claude Code・会話の回帰試験は33件、表示中の参照を扱うWebの回帰試験は6件に合格した。

追加実装後は、一時チェックアウトで `verify --domain prototype --domain claude-code` を実行し、29件に合格した。

`prototype`、`claude-code`、`dialogue`、`capabilities`、`tool-runtime` の一括検証は1093件合格、2件スキップ、1件失敗。失敗した既存のCollaboration移行テストは変更前のHEADでも同じ `migration_after_unknown:dialogue/0049-drop-retired-todos` で失敗した。 [移行テスト](../../../api/application/toolchain/capability-seed.test.ts#L253)

```sh
bun --no-env-file spec/verification/instant-project-sandbox-p2-2026-11-28/acceptance.ts
bun --no-env-file spec/verification/instant-project-sandbox-p2-2026-11-28/acceptance.ts --dependency
bun --no-env-file spec/verification/instant-project-sandbox-p2-2026-11-28/acceptance.ts --p2-remaining
bun --no-env-file spec/verification/instant-project-sandbox-p2-2026-11-28/native-idle.ts
```
