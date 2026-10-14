# アーティファクト一覧・Seed登録の復旧（2026-10-15）

## 目的と範囲

アーティファクト一覧の減少原因を特定し、保存済みの定義を保全してSeedから不足分を登録する。サブエージェントのprofile・skill・packageと、SystemContextへ渡る依存定義も確認する。会話・生成物・個人の記憶・接続設定の再投入は行わない。既存の未コミット変更はこの作業の対象外。

完了条件は、原因を再現できること、現行Seedの不足が0件であること、旧定義の内容が不変であること、関連試験と稼働API・画面で一覧の復旧を確認できること。

## 原因と発生箇所

### 一覧全体の取得失敗

`0bbcc83`（2026-10-15 06:03 JST）でWorldのschema検査がトランザクション必須になった。`world-query-adapter.ts`の可用性確認からこの検査を呼ぶ一方、`tool-runtime/service/action-requests.ts`の一覧・詳細・source取得はトランザクションの無い`store.read`だった。

World有効時は `GET /api/toolchain-artifacts` が `world_host_transaction_required` によって500になる。画面は取得失敗を空配列として扱うため、固定の「図を描く・編集する」「音楽プレイリスト」だけが残る。保持ログ上の最初の500は2026-10-15 06:08:53.922 JST、HTTP request IDは `97053aca-b1ba-466a-94db-99189606999c`。調査時にも500を再現した（`72e92b29-c292-420b-84c9-014d23b50a12`）。データ大量削除ではない。

### Seedの版衝突

- 看板: 保存済み`artifact:kanban.board@1`は5操作だが、Seedは同じ版に13操作を定義。`schema:kanban-add@1`と`schema:kanban-edit@1`も、prompt上限が9000から7850へ同じ版のまま変更されていた。bundle全体が拒否され、profile・skill・8 tools・package・toolchain（12定義）とbinding等が未登録。保持ログでの最初の見送りは10月14日22:19:42.086 JST。操作拡張は`5f8874f`、上限変更は`501aa59`の履歴に残る（commit時刻と実行時刻は別）。
- Claude Code: `501aa59`（10月15日00:01 JST）で入力schemaへ制御文字制約を追加したが、toolとpackageは@1のままだった。保存済みschemaHashと不一致になり、bundleを見送った。保持ログの最初の見送りは10月15日01:20:12.966 JST。

新規DBだけの試験では版衝突を検出できない。また従来の起動試験の`EUMENES_WORLD`は、現在の保存設定による有効化には使われず、World有効時の一覧API経路を通っていなかった。

## 修正と復元

既存の`readSnapshot`を一覧・詳細・sourceの3か所で再利用。Worldの検査を弱めず、可用性とデータ取得を同じ読み取り専用トランザクションで実施する。意味判断・担当選択・LLM指示への専用分岐は追加していない。

版衝突は保存済みデータの上書きではなく、新版で解消した。

| 系統 | 現行の接続 |
| --- | --- |
| 看板 | `toolchain:kanban.manage@2` → `package:kanban.manage@1` → `binding:kanban.manage@2` → `adapter:kanban@1` → kanban → `artifact:kanban.board@2` |
| Claude Code | `toolchain:claude-code.request@2` → `package:claude-code.request@2` → `binding:claude-code.request@2` → `adapter:terminals@1` → terminals → `artifact:terminals.workspace@2` |

看板の入力schema `kanban-add` / `kanban-edit` とClaude Codeのtoolも@2。両担当のprofileとskillは@1を使用。担当の意味判断や実行動作は変更していない。

実行中ジョブ0件・terminal session0件を確認して開発サーバーを正常終了し、既存の起動時Seed登録で復元した。製品DBへの直接SQL書込み・削除は行っていない。復元前カタログはローカルの `verification-reports/artifact-recovery/catalog-before.json`（0600）に退避。

| 確認項目 | 復元前 | 復元後 |
| --- | --- | --- |
| capability revisions | 139 | 154 |
| binding/artifact/schema documents | 131 | 138 |
| 現行Seedに対する不足 | 12定義＋3文書 | 0 |
| active profile / skill | 17 / 17 | 18 / 18 |
| package / toolchain | 20 / 15 | 21 / 16 |
| 保存済み旧定義の内容変更・削除 | — | 0 |
| アーティファクト一覧API | 500 | 200、21件 |
| 各アーティファクト詳細API | — | 21件すべて200 |
| 画面メニュー | 固定2項目のみになる | 11項目 |

旧`skill:web.research@3`だけはSeedと本文が異なるが、現行版ではなく、既存の旧版保全規則で保持する対象。書き換えていない。その他の現行Seedに対する文書差分は0件。SystemContextはprofile・skill等から実行時に構成される。18件のprofileとskillは登録済みで、担当呼出しの結合試験でも手順提示を確認した。

## 検証

- 部分: tool-runtimeの読み取り専用snapshot試験を追加。一覧・詳細・sourceでtransactionが有効で、書込みは禁止されることを確認。
- 登録: 旧看板と古いschemaHashを持つClaude Codeを隔離DBに再現し、新版への移行・旧定義不変・再Seedの冪等性を確認。
- 起動: settings domainでWorld有効設定を保存してから実際のサービスを構築。一覧取得の再現試験は修正前に失敗し、修正後に成功。
- capabilities部分＋Seed/移行＋kanban/Claude Code/World会話結合: 76件成功。最終の起動・移行4件も再確認成功。
- `verify --domain tool-runtime`: 成功（37件）。
- `verify --domain dialogue`: 成功（backend 227件、Web 6件）。
- `verify --domain kanban`: 成功（backend 39件、Web 18件）。
- `verify --domain terminals`: 成功（backend 57件、Web 8件）。
- 変更した結合試験のlint・format: 成功。
- 稼働API: 一覧21件・詳細21件成功。復旧後一覧request ID `6d02312a-2716-4a89-8112-01a924a158e4`。新boot `df2a40ab-65d2-4ac4-be18-359b2258b444` の確認時点でwarn/error 0件。
- 実ブラウザ: メニュー11項目、タスクボード、設定Hubの表示を確認。読取りのみで、新規タスク実行や保存設定の変更は行っていない。メニュー画像は `verification-reports/artifact-recovery/restored-menu.png`。

未完了の全体ゲート（担当外の既存問題）:

- `verify --domain capabilities`: `contracts/claude-code.ts`と`contracts/kanban.ts`の既存整形エラーで停止。該当ファイルは編集せず、capabilities試験は別途成功を確認。
- `bun run typecheck`: `tests/browser/object-recognition.spec.ts:265`の既存ArrayBuffer/Iterable型エラーが1件残る。今回追加した試験の型エラーは修正済み。
- これらが残るため`verify:all`成功とはしていない。ブラウザfixture全シナリオはUI実装を変更していないため省略し、今回の症状に対応する稼働画面の読取り確認を実施。実LLMによる新規作業依頼・外部操作・音声機器受入は復旧の必要条件ではなく、未実施。

## 俯瞰評価と差分確認

調査3ラウンド相当で、API失敗とSeed不足が別問題である証拠が得られたため、全再投入案から「snapshot修正＋衝突2系統の新版登録」へ絞った。旧定義の保全、Seed不足0、稼働APIと画面の復旧で完了条件を確認。無関係の未コミット変更は維持し、担当外の検証エラーは修正しなかった。新しいLLM判断の代替処理やシナリオ別の製品分岐は追加していない。

最終差分確認で、別作業による `world-query-adapter.ts` と同試験の変更（transaction外からの可用性確認を許容）が増えていた。これは編集せず保持し、当変更との結合を再確認した。稼働サーバーへの反映・画面検証は本作業のsnapshot修正で実施済み。

運用コンテキスト: `context_compile` 1回、`compile_eval` 1回。

## 追補: 整合性確認後のSeed再取得

ユーザーの追加依頼に従い、復元後の現行定義・依存・文書を照合し、Seedのソース一式を再取得した。製品DBのダンプではなく、既存の登録機構で復元するための67ソースファイルを保存した。担当のprofile、skill本文、package、toolchainと、Artifact・binding・schemaを含む。会話、生成物、認証情報、接続設定、インストール環境だけに存在する過去版は含めない。

- [Seed一式](seed-2026-10-15.tar.gz)（89,516 bytes）
- [アーカイブのSHA-256](seed-2026-10-15.tar.gz.sha256)
- [ソースファイル照合一覧](seed-files-manifest.json)
- [生成されるカタログ照合一覧](seed-catalog-manifest.json)（145定義・84文書）
- [再投入検証結果](seed-verification.json)

SHA-256: `14551e14b4d6a6c292f239ec5d502f68c306e056dcafc87c42e98d5c28d4fb25`

取得対象は作業ツリーのSeedであり、既存の未コミットのsettings bundleもそのまま含む。基点commitと全ファイルのハッシュを照合一覧に記録した。アーカイブ内の67ソースが照合一覧と一致することも確認済み。

### 再投入の確認

1. 空の隔離DBに既存のSeed登録機構で投入できることを確認。
2. もう一度投入して、カタログの全行が不変であることを確認。
3. 復元後のカタログだけを隔離DBに複製して再投入し、全行が不変であることを確認。製品DBへの書込みは行っていない。
4. 両環境で17個すべてのbundleをdry-runし、問題0件・追加登録0件を確認。
5. 新規Seedと稼働カタログで、現行の定義ID・本文ハッシュと全84文書のハッシュが一致することを確認。
6. capabilities・起動・旧カタログ移行の67試験が成功（失敗0件）。稼働APIも200・21件（request ID `a3409118-006b-49b1-a122-fe983fd5c6d7`）。

旧`skill:web.research@3`は公開済みSeedと保存済みの旧本文が異なる。既存の旧版保全規則により、再投入時にその本文を変更せず、現行版の整合性も保つ。両ハッシュは検証結果に記録した。一時的にSeedの旧本文を保存側へ合わせたが、公開済みハッシュの固定試験が失敗したため、その変更は撤回した。試験期待値は変更せず、正規のSeedへ戻した状態で67試験を再実行して成功した。この証拠により「すべての過去版本文を同一化する」案から「現行版の一致と過去版の保全を検証する」方針に修正した。

復元時はまず別ディレクトリに展開し、ハッシュ照合・対象環境との差分確認後に、互換性のあるEumenesの通常のSeed登録経路で反映する。手順はアーカイブ内の`README.txt`に記載。既存の版へ異なる本文を上書きしない。

全体ゲートの制約は前節のとおり。今回もcapabilitiesのverifyは既存の2ファイルの整形エラーで停止したため、領域の試験を直接実行して確認した。UI変更がない再取得作業のため画面操作は繰り返さず、前回の実画面確認と今回の稼働API確認を通しの証拠とする。新しい製品ロジック・LLM判断の代替処理は追加していない。

追加依頼の運用コンテキスト: `context_compile` 1回、`compile_eval` 1回（本会話合計各2回）。
