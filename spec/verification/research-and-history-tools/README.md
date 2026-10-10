# 検索・履歴参照の実装と受入記録

対象計画: `spec/research-and-history-tools-implementation-plan-2026-10-10.md`。基準commitは `bc8cc6c24e9b9fe327bc545fa1bfe4ab1b6bf8fc` と開始時の未コミット差分。既存の進行中変更を残して実装した。製品DB・通常会話を試験には使用していない。

## 実装

- ガード後のWeb本文を最大64,000 Unicode文字・256 KiBで一時保管。公開結果は既存の32 KiB制限を維持し、results bufferには本文への参照を置く。取得省略と提示範囲の省略を分ける。
- `web.find` はNFKC・大小文字を検索用に正規化し、原文のUnicode位置へ対応付ける。`web.read_saved` は通信せず最大2,400文字・エンコード後8 KiBの不変viewを返す。初回head/tailも別viewになる。
- 新しいworkerは元依頼の抜粋と対応するneeds、操作条件・指紋・失敗・残予算を受け取る。外部5回（lookup2/fetch3）・ローカル4回、モデル12回（履歴7回）、修復2回をホストで制限し、終了用のモデル1回と時間を残す。成功済み操作の反復を拒否する。
- 根拠は最終stepに実際に提示した `sourceId/viewId/excerptId` だけを使う。子の読取り権限を終了しても、親ticketの採用検証はroot期限まで維持する。
- `conversation` は最大500件の保存済み発言batchから、本文走査1 MiB以内で厳密なキーワード・日時・話者を検索する。対象と前後は最大10発言・8 KiB。長文・上限で0件の場合も不透明な続きを返す。現在の依頼・撤回・下書き・別会話は除外する。
- 履歴はMemory OFFでも使い、Web toolを発行しない。`conversation_source` は架空URLを持たず、発言日時・話者・版・digestを親へ渡す。訂正・撤回・取消・期限切れは報告受理と最終採用のtransactionで再検証する。旧本文を完成回答・音声へ公開しない。
- APIは認証付きPOST `/api/conversations/:id/history/search` と `/history/read`。CLIは `history-search` / `history-read`。JSONに参照・cursorを、人向け表示に日時・範囲・省略・期限を含める。APIとagentの参照を交換できない。
- 旧package/profile/SKILLと報告形式を維持。新しいWeb packageは `web.research@7`、`web.lookup@7`、`web.read@6`、履歴は `history.research@1`。新移行 `tool-runtime/0005-read-metadata` と `agent-runtime/0004-exploration` は凍結済みのlegacy全体の後へ追加し、原文コピー用tableは作らない。

## 再実行

```sh
bun run verify -- --domain web-research
bun run verify -- --domain conversation
bun run verify -- --domain capabilities
bun run verify -- --domain tool-runtime
bun run verify -- --domain agent-runtime
bun run verify -- --domain research-routes
bun run verify -- --domain dialogue
bun run verify -- --domain voice-dialogue
bun run verify -- --domain memory
bun run verify -- --domain world
bun run verify:all
```

合成入力の版はこの作業ツリーの `api/application/research-history.fixture.ts`。外部通信や実credentialを使わず、応答の余分な呼出し・未消費を検出する。

| シナリオ | 主な試験 | 確認する内容 |
| --- | --- | --- |
| R1/R2/R3 | application/research-history、web-research/saved-bodies | 12,000文字より後の中間へfetch1回で到達し、find→read_saved→親回答へ渡す |
| R4/R5 | application/research-history | 不一致の資料から別候補・変更した検索語へ進み、外部4回・モデル5回で終了 |
| R6 | application/research-history、tool-runtime | 空白・大小文字を変えた同じ成功済み検索を実行せず、有限の修復と報告 |
| R7 | agent-runtime/read-evidence、web-research/saved-bodies | 同じe0でもviewが違えば旧引用を拒否。未提示・偽造view、別owner・版を拒否 |
| R8 | saved-bodies、acquisition、toolchain、research-history | 容量・期限・restart・guard・取消・ロールバックを拒否し、勝手にfetchしない |
| H1/H8 | application/research-history、conversation/history | Memory OFFで発言と前後を確認。話者・日時付き、URLなし、利用metadataへ原文を複製しない |
| H2/H3 | conversation/history | 240往復と1,200件、同時刻・疎なrowid、長文の境界一致・続き、上限時の0件cursor |
| H4 | application/research-history、conversation/history | 生成中の訂正・撤回・取消で古い完成回答を採用しない |
| H5/H6 | conversation/history、history-cli | 他会話・他owner、撤回・未保存・現在の依頼、認証不備を拒否 |
| H7 | application/research-history、conversation/history | 会話変更後、一度だけ取り直して新scopeを採用。tool4回・モデル5回、予算を更新しない |
| 互換性 | migrations、research-routes、control-logging | 凍結SQLと旧DB、学習経路のwarm/cold、旧形式、秘密を含まない正確な失敗診断 |

## 展開と停止

`EUMENES_HISTORY_TOOLS_ENABLED` と `EUMENES_WEB_RESEARCH_TOOLS_ENABLED` は既定でON。各々 `0` / `false` / `off` で能力の登録・選択を停止できる。停止してbackendを再起動すると、未完了仕事は既存の復旧処理で中断され、一時参照も失効する。進行中タスクを旧コードへ移して継続しない。migration・会話原文・旧revisionは削除しない。Memoryの設定とは独立している。

```sh
bun cli/index.ts history-search 集合時刻 --conversation main --from 2026-10-01 --until 2026-10-08 --json
bun cli/index.ts history-read <messageRef> --conversation main --before 2 --after 2 --json
```

CLIの日時だけの入力はAsia/Tokyoの00:00へ解決し、開始を含み終了を含まない。続きは同じ検索条件と発行されたcursorを渡す。

## liveと実機器

live用に既存経路へ `research-history` ケースを追加した。長いSQLite公式資料、最初の資料の対象不一致、不足を反映した検索語変更を実LARMと実Webで確認し、到達・操作列・外部/ローカル取得数・モデル回数・終了理由を記録する。期待した操作列を実際に行わなければ `scenarioExercised:false` として失敗にする。

```sh
EUMENES_LIVE_TOOLCHAIN=1 LARM_BASE_URL=<接続URL> bun scripts/toolchain-live.ts research-history
```

試験用DB・API token・ログ・会話は専用一時ディレクトリに作り、終了時にDBを削除する。LARM credentialは既存のbackend環境だけで使う。製品の設定やDBを複製しない。

SQLiteに保存済みの `http://192.168.0.130:9810` を確認し、このURLで実LARM接続に成功した。環境変数だけを見た初回の未設定判定は誤りだった。実モデル3ケースを実行し、入力契約の案内と無効参照の処理を修正して再受入中。結果は下記の検証記録に記す。fixture成功をlive成功として扱わない。

実マイク・ヘッドホン3往復と割込みは今回未実施。音声の合成・入出力機構は追加しておらず、音声MVPの完成は宣言しない。

利用側10domainと `bun run verify:all` は終了コード0。全体は2,851件合格・2件skip（実Local Provider、macOSのnative仮想マイク）。開始・終了のsource hash一致も通過した。詳しい結果と終了コードは [verification.md](verification.md) に記録した。live3ケースと実機器受入はこの合格件数に含まない。
