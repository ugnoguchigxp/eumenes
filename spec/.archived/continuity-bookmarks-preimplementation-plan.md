# 会話のしおり：queue・スケジューラーと独立した先行実装計画

作成日：2026-10-07
状態：先行実装完了（2026-10-07）。`bun run verify -- --domain continuity` と `--domain conversation` で検証済み。本番配線・dialogue注入・queue／scheduler接続は未実施で、後続計画の対象。`verify:all`は未実行。
注：本書は`spec/.archived/`へ移動済みのため、相対リンクは`../../`基準に読み替える。
対象：Eumenes。SAAAのContinuityから、明示保存・出典・訂正履歴・現在状態の投影を移植する。

## 1. 結論と完成範囲

queueとスケジューラーの完成を待たずに、`continuity`ドメインを独立実装できる。先に作るのは、ユーザーが選んだ発言を「目的」「決定・制約」「未決事項」として残す保存基盤、HTTPハンドラー、クライアント、画面部品、現在状態を組み立てる純粋な関数である。

この段階の完成は「しおりの部品を、実DB・HTTP・画面部品のテストで検証できること」とする。本番アプリへの配線、LLM入力への注入、実行中の回答の失効、TTS停止は含めない。したがって、先行実装だけで「前の決定を踏まえて会話できるようになった」と報告しない。

queue／スケジューラーとの接続計画は、その公開契約と実装を読み直した後に別途作成する。本書では接続を始める条件だけを記す。

## 2. 確認済みの土台と未確認事項

本書作成時に確認したコードは次のとおり。相対リンクは本書の配置先を基準とする。

| 土台 | 確認した実装 | 先行実装での扱い |
| --- | --- | --- |
| 会話原文 | [conversation service](../api/domains/conversation/service/index.ts) | 原文の正本。公開APIを通して発言を参照する |
| 永続化 | [SqliteStore](../api/infrastructure/sqlite/index.ts) | 既存の単一writerとトランザクションを使う |
| 文字対話 | [dialogue service](../api/domains/dialogue/service/index.ts) | 現在は履歴を組み立ててLARMを呼ぶ。本段階では変更しない |
| 音声対話 | [voice-dialogue service](../api/domains/voice-dialogue/service/index.ts) | dialogueに合流する。本段階では変更しない |
| クライアント | [client transport](../client/transport.ts) | 既存transportを注入してドメイン別クライアントを作る |
| 検証 | [verify](../scripts/verify.ts)、[domain registry](../scripts/domains.ts) | ドメイン登録後に対象を指定して検証する |

ユーザーからqueueとスケジューラーの実装開始が共有されている。本書作成時の作業ディレクトリでは対応するドメインのファイル・公開契約を確認できていない。未着手とは判断せず、開発中の領域として扱い、名称・状態遷移・取消API・ジョブ形式を推測して定義しない。他のCodexチャットへの連絡は行わない。

SAAAの参照元は、隣接リポジトリの[Personal State設計](../../SAAA/spec/docs/personal-state-architecture-roadmap.md)と[Memory責務](../../SAAA/src-tauri/src/memory/README.md)。Rust実装やLARM Context APIを丸ごと移植する計画ではない。参照元の設計や試験済み範囲を、Eumenesの実装済み機能と混同しない。

## 3. スコープ

### 先行実装するもの

- `continuity`ドメインの型・Zodスキーマ・永続化・サービス・HTTPハンドラー。
- ユーザー発言を選んで作成するしおり。種類は`goal`、`decision`、`open_question`の3つ。
- 一覧、内容の訂正、無効化、出典の取得、変更履歴の取得。
- 会話IDごとの分離、更新競合の拒否、書き込みの再送対策。
- 有効なしおりを予算内で構造化データへ変換する純粋な投影処理。
- 専用クライアント、React Queryのhooks、一覧・編集・出典表示の画面部品。
- 一時DBとテスト用HTTPアプリ、画面部品の結合テスト。

### 後続へ送るもの

- `api/application`、`client/index.ts`、`web/src/App.tsx`への本番配線。
- `MessageList`への保存ボタンの組み込み。先行段階では選択発言をpropsで受け取る部品まで作る。
- dialogueへの投影注入、履歴削減、入力全体の予算管理。
- queueへのジョブ投入、スケジューラーによる起動、抽出worker、定期整理。
- 訂正・無効化時の実行取消、古い生成結果の保存拒否、音声合成・配信・再生の停止。
- 自動抽出、自動要約、複数プロジェクトの推定、World Model、embedding、外部サービス連携。
- 会話本文の削除、派生回答を含む忘却、外部保存先の消去。

先行実装では新規ライブラリ、別DB、独自ジョブキュー、独自タイマー、別の進捗台帳を追加しない。既存の認証方式・音声処理・LARM契約・queue／スケジューラーを変更しない。

## 4. 利用契約

### 4.1 明示保存と出典

1. UIへ渡されたユーザー発言を選び、種類と保存文面を指定する。
2. サーバーで会話ID、発言ID、`role=user`を検証する。初版ではassistantの発言を保存元にしない。
3. 保存文面はユーザーが確認した内容として扱う。モデルによる意味抽出は行わない。
4. 元の発言IDと、その時点の原文のSHA-256をサーバーで記録する。原文全文は複製しない。
5. 編集された文面には「ユーザー編集」の由来を残す。出典へのリンクは保存の起点を示し、元の発言が編集後の文面をそのまま述べたと保証しない。

出典は既存のconversation公開APIから取得する。存在しない・別会話・内容のdigestが変化した出典を検出する。発言単位のversionは現行モデルにないため捏造しない。出典本文の不一致を検出した項目は通常の有効な投影へ含めず、後述の`blocked`にする。

### 4.2 訂正・無効化

- 訂正は同じしおりIDへ新しい版を追加し、前の版を有効な値として返さない。
- 無効化は`inactive`の版を追加する。有効一覧と投影から外す。初版では再有効化しない。
- 無効化後の項目に対する別の変更要求は409。同一要求の再送は以前の成功結果を返す。
- 無効化は本文削除ではない。UI表記は「無効化」とし、「忘れる」「完全削除」を使わない。
- 訂正・無効化は将来の投影を変える操作であり、この段階で実行中の回答を停止する機能はない。

### 4.3 上限

初期値として、保存文面はtrim後1〜2,000文字、会話ごとの有効項目は最大50件とする。ID・requestId・revisionはスキーマで検証する。上限はcontractsの定数に集約し、API・UI・テストで共有する。

これは本機能の製品上限であり、モデルのtoken容量を保証する値ではない。

## 5. データと整合性

### 5.1 正本

`continuity_events`を新設し、作成・訂正・無効化を追記する。初版では現在値を保存する別テーブルを作らず、しおりIDごとの最新イベントから一覧を導出する。会話原文の正本は既存の`messages`のまま。

各イベントに次の情報を持たせる。具体的なSQLとレスポンス型は着手時に親エージェントが確定する。

| 情報 | 契約 |
| --- | --- |
| `sequence` | DB採番の単調増加値。時刻で順序を決めない |
| `id`, `bookmarkId`, `conversationId` | イベント、しおり、会話の識別子 |
| `operation` | `create` / `revise` / `deactivate` |
| `kind`, `text`, `status` | その版の完全な状態。statusは`active` / `inactive` |
| `revision` | しおり単位で1から増加する版 |
| `sourceMessageId`, `sourceDigest` | 作成時の出典参照。初版では訂正時も同じ出典を保つ |
| `origin` | `user_confirmed` / `user_edited`。LLMによる推測と扱わない |
| `requestId`, `requestDigest` | 書き込み再送の識別と同一内容の照合 |
| `createdAt` | 表示用のサーバー時刻 |

`(bookmarkId, revision)`と`(conversationId, requestId)`に一意制約を設ける。会話・しおり・sequenceによる読み取りに索引を付ける。

会話の`stateRevision`は、その会話に属するイベントの最大sequence、イベントがなければ0とする。他会話の更新では変化しない。これはcontinuityの版であり、queueのrevision、schedulerの世代、dialogueのrun revisionとは別の値である。

### 5.2 書き込み

すべて既存の`SqliteStore.write`で行い、出典検査・再送判定・版検査・件数制限・イベント追加を同一トランザクションで確定する。トランザクション内でモデル呼び出しやネットワーク待機をしない。

出典検査には、既存の`ConversationService.messagesInTransaction`を公開エントリー経由で使う。他ドメインのrepositoryへ直接importしない。永続化処理は初版では同期処理のみとし、jobへの分割をしない。

同じrequestIdかつ同じ正規化済み入力は、最初に確定したイベントに対応する結果を返す。再送判定は現在版との比較より先に行う。後から別の訂正があっても、以前の要求の再送を新しい変更にしない。同じrequestIdで異なる内容は409。

訂正・無効化には`expectedRevision`を要求し、不一致は409。書き込み失敗時は成功を返さず、revisionも進めない。マイグレーションの本番登録順は後続の統合担当が確定し、既存配列への割り込みや適用済みSQLの変更はしない。

### 5.3 読み取りと投影

一覧と`stateRevision`、出典の有効性は一貫したread snapshotから取得する。現在の`store.read`の呼び出しだけで複数SQLのsnapshotが保証されると仮定しない。単一SQL、または読み取り接続内の同期トランザクションで揃える。

公開関数は次の責務に分ける。

- `getSnapshot(conversationId)`：永続状態と出典を読み、現在値・stateRevision・出典の検証結果を返す。
- `projectContinuity(snapshot, maxBytes)`：IOなしで投影を作る。LLMメッセージやsystem promptは生成しない。

投影は`conversationId`、`stateRevision`、`status`、有効項目、出典参照、理由を持つ構造化データとする。項目順はbookmarkIdなどの固定規則にし、入力が同じなら同じ結果になるようにする。本文には実行権限を持たせず、`instructionAuthority: "none"`を付ける。

全有効項目をJSON化したUTF-8のbyte数が`maxBytes`以下なら`ready`。超過は`overflow`、有効項目の出典が欠落・変化していれば`blocked`とする。後二者はモデルへ渡せる部分的な成功結果を返さない。必須の決定を黙って切り落とさない。

このbyte検査は投影単体の制限であり、将来のLLM入力全体やtoken上限の検証を代行しない。`instructionAuthority`も単体で安全性を保証する仕組みではなく、後続の入力配置と実行時検証が必要である。

## 6. HTTP・クライアント・画面

### 6.1 API契約

| Method | Path | 動作 |
| --- | --- | --- |
| GET | `/api/conversations/:id/bookmarks` | 現在一覧とstateRevision。既定は有効項目、`includeInactive=true`で無効項目も含む |
| POST | `/api/conversations/:id/bookmarks` | sourceMessageId・kind・text・requestIdで作成 |
| POST | `/api/conversations/:id/bookmarks/:bookmarkId/revise` | text・kind・expectedRevision・requestIdで訂正 |
| POST | `/api/conversations/:id/bookmarks/:bookmarkId/deactivate` | expectedRevision・requestIdで無効化 |
| GET | `/api/conversations/:id/bookmarks/:bookmarkId/history` | 変更履歴をsequenceカーソルで取得。既定50件、最大100件 |
| GET | `/api/conversations/:id/bookmarks/:bookmarkId/source` | 原文と出典の検証結果を取得 |

投影は内部関数までとし、先行段階では生成用の公開APIを増やさない。

入力不正・有効件数上限は400、別会話または不存在のしおり・出典は404、版／requestId競合は409、既存writerの混雑は503。成功はDB commit後に返す。未知の内部例外は本番ホストのエラーハンドラーへ渡す。controller自身が既知のドメインエラーを適切なステータスへ変換し、現行appの汎用500に依存しない。

ハンドラーは既存方式に合わせ`registerContinuity(app, service)`として公開する。テスト用アプリには既存と同じBearer・Origin検査を設け、未認証では書き込めないことを確認する。本番への認証適用は後続配線時にも確認する。

### 6.2 画面部品

- 選択済みユーザー発言から作成するフォーム、しおり一覧、訂正フォーム、無効化操作、出典表示を実装する。
- 専用の`ContinuityClient`を注入する。`EumenesClient`への追加を前提にしない。
- しおり一覧はサーバーの値を正本とし、React Queryで取得する。独立した永続Zustand storeやlocalStorageを作らない。
- query keyには`client.identity`と`conversationId`を含め、会話間の混同を防ぐ。
- 更新成功後は関連queryを再取得する。409では入力を残し、最新状態を読み直して再編集できるようにする。初版では楽観的に成功表示しない。
- requestIdは1回のユーザー操作に対して固定し、通信再送で再生成しない。別の編集内容を送るときに新しく発行する。
- 現在の無効化状態、出典の欠落／変更、取得・保存エラーを表示する。
- 本番会話画面への組み込みは行わない。部品テストで実際にフォーム操作を通す。

## 7. ファイルと所有者

以下は新規作成予定パス。実装開始時に同名ファイルが追加されていた場合は既存内容を読み、上書きしない。

| 担当 | 所有するファイル／領域 |
| --- | --- |
| 親エージェント | `api/domains/continuity/contracts/index.ts`、`api/domains/continuity/index.ts`、`scripts/domains.ts`、本書 |
| A：保存・API | `api/domains/continuity/repository/`、`service/`、`controller/`、`test/persistence.test.ts`、`test/http.test.ts` |
| B：投影 | `api/domains/continuity/projection/`、`test/projection.test.ts` |
| C：クライアント・画面 | `client/continuity.ts`、`web/src/domains/continuity/`、`web/src/components/domains/continuity/` |

`scripts/domains.ts`へ`continuity`を追加し、backend・web・componentsのパスを登録する。依存先は`conversation`のみとする。queue、scheduler、dialogue、larmへの依存を追加しない。domain registryは他作業とも共有するため、親が最新内容を読んで追加分だけを反映する。

`api/application/*`、`client/index.ts`、`web/src/App.tsx`、既存MessageList、SQLite infrastructureは先行実装の変更対象外。型が不足する場合もサブエージェントが共有ファイルを独断で変更せず、親へ必要な変更を報告する。

## 8. Claude Codeでの実装順序

### Step 0：親が境界と契約を確定する

1. 最新のAGENTS.mdと実装を読み、queue／スケジューラーの追加・共有ファイルの変更を確認する。
2. 本書の先行範囲を維持して、Zodスキーマ、サービス／投影の入出力、APIエラーを確定する。
3. domain registryへ追加する。新ドメインの登録以外に検証規則を緩めない。
4. API・画面の部品検証で使う型付きfixtureを定める。fixture成功を実DB・実HTTPの成功とは扱わない。

### Step 1：3サブエージェントで独立実装する

- Aは保存・更新・読取snapshot・HTTPと実DBテストを担当する。
- Bは合意済みsnapshot型を入力として、純粋な投影と境界ケースのテストを担当する。Aの内部実装へ依存しない。
- Cは合意済みクライアント契約を基に画面部品とテストを担当する。Aの完成まではtransport fixtureを使う。

各担当は所有ファイルだけを編集する。新規の汎用基盤やジョブ処理へ範囲を広げない。共通契約を変える必要が出た場合は親が変更をまとめてから、全担当へ同じ版を渡す。

### Step 2：親が独立ドメインを結合する

1. public entryのexportと型を揃える。
2. 一時DBでconversation migrationとcontinuity migrationを適用し、サービス→HTTP→専用クライアントの接続を確認する。
3. クライアントのHTTP結合テストは`api/domains/continuity/test/`へ配置し、既存のdomain test runnerで選択されるようにする。
4. 画面テストは`web/src/domains/continuity/test/`またはcomponents配下へ置く。新たなテストrunnerは追加しない。
5. 対象検証を直列に実施する。同じ作業ディレクトリで実装更新とverifyを同時実行しない。

## 9. 受入条件

| 分類 | 確認する挙動 |
| --- | --- |
| 保存・再起動 | 3種類を保存でき、DBを閉じて開き直しても現在値・出典・履歴が一致する |
| 訂正 | 最新版だけが有効になり、旧版は変更履歴で確認できる |
| 無効化 | 有効一覧・投影から外れ、無効項目一覧と履歴には残る。会話原文は削除しない |
| 出典 | 別会話・不存在・assistant発言からの作成を拒否する。欠落／digest不一致は通常の投影に混入しない |
| 並行更新 | 同じexpectedRevisionからの2更新は片方だけ成功し、もう片方は409になる |
| 再送 | 同一requestId・同一入力でイベントを増やさない。内容が違えば409。後の訂正後に再送しても状態を巻き戻さない |
| 原子性 | 出典不正・件数超過・書き込み失敗で部分的なイベントや成功結果を残さない |
| 会話の分離 | 他会話のしおりを取得・更新できず、他会話の更新でstateRevisionが変わらない |
| 投影 | 同一snapshotの結果が安定する。予算ちょうどは成功、1byte超過はoverflow。日本語・絵文字でもUTF-8で測る |
| snapshot | stateRevisionと項目が同じDB snapshotに由来し、更新の途中状態を組み合わせない |
| API接続 | 専用クライアントからテスト用HTTPアプリを経由して実DBの作成・訂正・無効化が成立する |
| 画面 | 操作成功後に正本を再取得する。競合時は編集内容を失わず、保存失敗を成功表示しない |
| 独立性 | queue／scheduler／LARMなしで全受入テストを通せる。タイマーやworkerを起動しない |

実装開始前に既存conversationの対象検証を記録する。実装後は次を順に実行する。

```sh
bun run verify -- --domain continuity
bun run verify -- --domain conversation
```

上記は`continuity`をdomain registryへ登録した後のコマンドである。本書を追加しただけの時点では実行対象が存在しない。

ドメイン検証では全体ビルドやブラウザーE2Eの成功を主張しない。共有作業が落ち着いて全体統合の準備完了を報告する際には、次を実行する。

```sh
bun run verify:all
```

現在の全体検証は静的検証・backend/webテスト・web build・fixtureによるブラウザー試験を含む。実マイク・実LARMの受入とは別である。先行実装には実LARMの認証情報やライブ試験を要求しない。全体検証が他の開発中領域で失敗した場合は、その結果と対象検証の結果を分けて記録する。

先行実装の完了報告には、実装した部品、実行した検証、本番未配線であること、後続接続の未実施を記載する。

## 10. 後続計画に進む条件

queue／スケジューラーの実装が揃った後、次の境界を実コードで確認して接続計画を作る。ここで列挙した項目は先行実装の作業項目ではない。

1. run・job・attemptの対応、取消要求と取消確定の違い、再起動時の回復を誰が管理するか。
2. 推論開始時にcontinuity snapshotを束縛し、保存・出力直前に現在版と照合する場所。
3. 訂正前のrunの遅延結果を拒否する方法。取消通知の成功だけで失効完了とは判断しない。
4. dialogueの採用済み回答からTTS合成・音声配信・再生に進む各段階で、失効を伝播する方法。
5. しおり、現在発話、会話履歴を合わせた入力予算と、過去の発言を現在の命令へ昇格させない配置。
6. migrationの追加順、APIの認証・Origin検査、クライアントの合成、実画面への配線。

将来、しおりの明示保存までqueueへ載せる必要があるかは、その時点の設計から判断する。現行の同期トランザクションで成立する処理を、スケジューラー導入のためだけに非同期化しない。

## 11. 本書作成時の検証

既存のドメイン構成、公開エントリー、DB writer、クライアント分割、検証コマンドの定義を読み合わせた。変更は本書の追加のみ。実装、migration適用、queue／スケジューラー変更、アプリ起動、アプリのテストは実施していない。
