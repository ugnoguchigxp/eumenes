# LARM 外部機能アプリと成果物連携の実装計画

作成日: 2026-10-09 JST。状態: レビュー用草案、実装前。

独立した機能コンポーネントのメンテナンスと日常利用を両立するため、各リポジトリの機能本体・単体アプリ・外部連携を維持し、Eumenes を利用先の一つにする。LARM は配備したアプリの発見と実行資源を管理し、Eumenes は会話からの操作、成果物への参照、表示、修正対象の受渡しを担当する。

初版は Markdown アプリ一つで「会話から作成 → 横に表示 → 人が編集 → AIが修正 → 再起動後に再表示」を完成させる。Docling、カレンダー、帳票は共通基盤の後続利用先とする。本書の契約名、API、DB、ファイル配置は追加設計案であり、配備済みの LARM や外部アプリが対応しているという意味ではない。

## 1 判断の前提と現在の実装

Eumenes の参照 HEAD は `828038afdefaf23917223a017e1e75152ed1959e`。2026-10-09 の作業ツリーには Web 調査ツールチェーンの未コミット実装がある。本計画はその作業ツリーを読んだ追加設計であり、HEAD のみでは実装の前提を満たさない。着手時に差分と既存 gate の結果を再確認し、進行中の実装を巻き戻さない。

| 確認した実装 | 現状と今回の扱い |
| --- | --- |
| `api/domains/capabilities/service/index.ts` | 版付き登録、検索、準備、失効検査がある。backend は既定で `web`、validator は組込みキー。任意の外部 schema の実行基盤ではない |
| `api/domains/tool-runtime/contracts/index.ts` | Adapter 契約と invocation 台帳がある。結果は検索 hits と取得 documents に限定される |
| `api/domains/tool-runtime/service/index.ts` | 結果本文は有界のメモリー vault。期限付き `result_ref` を永続成果物IDとして使わない |
| `api/domains/agent-runtime/service/index.ts` | 能力を選ぶ経路はあるが、選択後の入力処理に `researchInput` の固定処理が残る |
| `api/domains/agent-runtime/contracts/index.ts` と `service/verify-report.ts` | 子の完了と報告検査は出典付き調査用。書込み成功の検査には拡張が必要 |
| `api/application/toolchain.ts` | 単一 Web Adapter を組み立てる。外部アプリへの振分けは未実装 |
| `api/domains/larm/service/playground.ts` | catalog 発見、画像・楽曲の job と成果物取得の実装例がある。protocol と path は既知のものに限定される |
| `web/src/domains/agent-runtime/ResearchTaskCard.tsx` | 調査状態・報告・出典表示がある。汎用成果物パネルではない |
| `api/application/server.ts` と `api/infrastructure/sqlite/` | 単一 writer、commit 後の SSE 通知、worker 開始前の復旧がある。これらを再利用する |

以下の SHA-256 はレビュー時点の主要ファイルの識別用。変更後は新しい baseline を検証記録に残す。

| ファイル | SHA-256 |
| --- | --- |
| `api/application/toolchain.ts` | `dd23f9b5734e93e76cb1c30f978aee63619e3765622999a6deab64cc39ee5fea` |
| `api/domains/tool-runtime/contracts/index.ts` | `ca2981c0c289e760bcb6f40ad7521fe33d888e66298c395da82d9e56106fd394` |
| `api/domains/agent-runtime/contracts/index.ts` | `9e2327237bc1406998d3a615222212fa891aef7421268a79b760bba9e14d9cd5` |
| `api/domains/capabilities/service/index.ts` | `fec859bf0f89ce1f7f9647d41c715154d348682d01bbf3d198865fc5dae83e9b` |
| `web/src/domains/agent-runtime/ResearchTaskCard.tsx` | `e360f180e92deea6a4e90e4e955c6ab36383cc47494bb4bb199f078292e43428` |

既存計画は [Web調査ツールチェーン計画](.archived/toolchain-web-research-implementation-plan-2026-10-09.md)、境界は [domain規則](../docs/domains.md)、ログは [logging規則](../docs/logging.md) を参照する。既存の fixture 成功やサービス試用を、今回の外部アプリ連携の検証済みとして数えない。

## 2 利用先とリポジトリの責務

| 対象 | 機能本体 | Eumenes から使うための追加部分 |
| --- | --- | --- |
| [markdownWysiwyg](https://github.com/ugnoguchigxp/markdownWysiwyg) | Markdown の React エディター | 文書保存・版管理・操作API・単体画面・埋込み画面を備えたアプリ |
| [regular-calendar](https://github.com/ugnoguchigxp/regular-calendar) | リソースと予定を扱う React 部品 | 予定の正本、日時契約、操作API、単体画面、埋込み画面 |
| [docling-desk](https://github.com/ugnoguchigxp/docling-desk) | 文書処理、検索、原本表示、ナレッジAPI | Eumenes の利用者範囲との対応、既存APIとビューアーへの adapter |
| [wysiwyg-pdf](https://github.com/ugnoguchigxp/wysiwyg-pdf) | JSON文書による帳票編集とブラウザー印刷 | 文書保存API、埋込み画面。自動PDF出力は別途契約・実装 |

最初に提示されたリンクは表示名が `markdownWysiwyg`、リンク先が `wysiwyg-pdf` だったため、両方を区別している。初版の対象は Markdown とする。

参照したローカル checkout の HEAD は Markdown `1eb93c5f18d5fc41bef2fccf6371ce903ba96675`、カレンダー `f49d39ba4e9cd1a06b9b2e0c8443f759b0264fe3`、Docling `1b27e5ac2d2f66970286a02515a99d49d5688f76`。これらは採用する配備版を確定する値ではない。外部リポジトリの実装状況は着手時に公開契約と照合する。

エディターやビューアーの改善は機能側へ、会話と実行管理は Eumenes へ置く。Eumenes 専用の機能本体のコピーを作らない。単体アプリと埋込み画面は同じ保存APIを利用する。開発版と日常利用する配備版を分け、LARM はリリース版を管理する。

Docling の既存ナレッジAPIは server-to-server の認証を要求し、ビューアーは別の短期セッションを扱う。[ナレッジAPI仕様](https://github.com/ugnoguchigxp/docling-desk/blob/main/docs/knowledge-api.md) と [埋込み仕様](https://github.com/ugnoguchigxp/docling-desk/blob/main/docs/viewer-embedding.md) を優先し、初版 Markdown 用の新契約で既存APIを置き換えない。

## 3 初版の範囲と外部の前提条件

初版の利用者は現在の loopback 限定 Eumenes を使う一人。backend が固定したローカル利用者IDと、管理者が設定した外部アプリの scope を使う。モデル引数やブラウザーの申告で利用者・権限を決めない。多人数のログイン・権限管理は後続設計とする。

初版に含めるもの:

- 接続可能な Markdown アプリ一つと、固定版の create/read/update 能力パッケージ。
- 会話からの作成、現在の文書または明示選択した文書の版付き更新。
- backend での操作と、外部APIが確認した保存結果の採用。
- 成果物カード、横の埋込みパネル、保存版と最新状態の区別、単体アプリで開く操作。
- 選択箇所を会話入力へ添付する操作。添付だけでは送信・AI実行しない。
- 人の保存後の再取得、競合・接続切れ・期限切れ・削除の表示。
- fixture gate と、隔離した実配備の利用者受入を別記録にすること。

初版に含めないもの:

- 汎用 MCP client/server、任意 schema や JavaScript の実行、モデルによるアプリの配備・更新。
- 文書削除、外部公開、第三者への送信、予約からの外部書込み。
- 共同編集、自動マージ、全文履歴の Eumenes への複製、オフライン編集同期。
- 自動的な外部文書の監視、外部変更の全履歴同期、AI task の再起動後の自動継続。
- Doclingへの大量移行、カレンダーの業務ルール、サーバー側PDF出力。

書込みは「作って」「この文書を修正して」という現在の明示依頼、または人の保存操作から行う。検索結果や選択添付、過去の依頼から書込み許可を推定しない。通常の作成・修正に毎回別の承認画面を追加せず、対象が曖昧なら会話で確認する。

外部アプリ側の必須条件は、永続ID、楽観ロックに使う版、過去版の読取り、要求IDによる重複防止、操作結果の照会、短期の閲覧・編集セッション、埋込みイベント契約。LARM側にはアプリの安定したインスタンス識別と対応契約の広告が必要。現行 catalog に未定義なら LARM 側の契約拡張が先行する。これらがない場合は fixture 実装まで進められるが、実配備での完了条件は満たせない。

## 4 固定する設計判断

| 論点 | 初版の決定 |
| --- | --- |
| 接続方式 | 型付きHTTP adapter。アプリごとの違いを adapter に閉じ込める |
| 表示方式 | 各アプリが配信する専用埋込み画面を sandbox iframe に表示する |
| 成果物の正本 | 内容・版・予定は外部アプリ。Eumenes は参照と作成・更新の実績を保存する |
| 開く版 | 会話中の成果物リンクは保存が確認された版。最新を開く操作は明示的に分ける |
| 編集対象 | 明示した成果物IDと基準版。latest を更新要求に使わない |
| APIの互換性 | 実装済み adapter と契約 major の一致、必須機能の確認を条件に能力を有効化する |
| 能力の発見 | 既存の少数候補検索を維持。catalog 全件を system context に入れない |
| 書込みの実行 | ローカル台帳の保存後、transaction 外で外部APIを呼ぶ |
| 保存の完了 | 検証した外部 receipt と、ローカル参照・台帳の保存が両方確定したとき |
| 再起動 | AI run は既存規則で interrupted。外部効果は読取りによる照合だけを行う |
| 失敗時 | 外部保存失敗、保存結果不明、表示失敗を区別する |
| 有効化 | `EUMENES_EXTERNAL_APPS_ENABLED` は既定 `0`。`0`/`1` 以外は起動エラー |

無効化しても既存参照と履歴は消さない。新規の外部操作とセッション発行を止め、カードには無効状態を表示する。外部アプリのリリース更新を Eumenes が実行する機能は設けない。

## 5 Domain と結合の所有

| Domain | 依存domain案 | 所有する処理 |
| --- | --- | --- |
| 新規 `artifacts` | なし | 参照、確認済み版、会話との関連、出典位置、選択添付の構造、SQLと試験 |
| 新規 `external-apps` | `larm`、`queue`、`artifacts` | 接続の検証、HTTP adapter、操作台帳、外部効果の照合、閲覧セッション仲介 |
| 既存 `larm` | なし | サービス発見、catalogの検証、接続情報と秘密の扱い |
| 既存 `capabilities` | なし | 固定版パッケージ、組込みschemaとverifier識別、有効状態 |
| 既存 `tool-runtime` | `capabilities`、`queue`、`artifacts` | 実行参照、結果種別、書込みreceiptと成果物参照の検査 |
| 既存 `agent-runtime` | 既存依存を維持 | package入力の処理、調査と成果物操作の完了検査、親への結果投影 |
| 既存 `dialogue` | 既存依存＋`artifacts` | 選択対象の会話受付、書込み意図、取消、結果の回答採用 |

外部 adapter の結合と成果物パネル用の複合APIは `api/application/` が所有する。`tool-runtime` から `external-apps` を直接 import せず、自分の Adapter port を受け取る。`artifacts` は上位を呼ばず、外部文書を取得しない。transaction 内の複数 domain 保存は application の一つの writer 処理で各公開操作を呼ぶ。

候補配置:

- `api/domains/artifacts/{contracts,repository,service,controller,test}/` と `index.ts`。
- `api/domains/external-apps/{contracts,repository,service,controller,test}/` と `index.ts`。`service/` 内に接続、操作、照合、セッション、`adapters/markdown.ts` を分割する。
- `api/domains/capabilities/builtin/markdown-document.ts` と固定版 `SKILL.md`。
- `api/application/external-apps.ts` で結合、既存 `toolchain.ts` で backend による振分け。
- `client/artifacts.ts`、`client/external-apps.ts`。Web と CLI はこの HTTP client を使う。
- `web/src/domains/artifacts/` にカード、パネル、frame通信、選択添付、近接した試験。
- `web/src/domains/settings/sections/external-apps.tsx` に接続状態と対応可否。秘密の入力・表示は作らない。

`scripts/domains.ts`、境界検査、末尾追加の migration、起動結合、共通 client、SSE の query invalidation を更新する。既存 migration の checksum と順序は変えない。

## 6 接続と外部アプリの契約

以下は Eumenes 内で正規化する契約案。実際の外部 path は adapter と契約fixtureに置く。モデルは任意URL、接続先、credential、利用者IDを指定できない。

```ts
type ExternalAppBindingV1 = {
  appId: string;
  instanceId: string; // 同じ保存領域を指す安定ID。再配備だけでは変えない
  bindingGeneration: number; // 接続先・scope変更で増える
  contract: { name: string; major: 1; minor: number };
  deploymentRevision: string;
  catalogRevision: string;
  features: Array<"create" | "readRevision" | "update" | "operationLookup" | "embed">;
};
type ArtifactRefV1 = {
  version: 1;
  instanceId: string;
  externalId: string;
  revision: string; // 外部発行の不透明な版
  kind: "markdown" | "document" | "calendar" | "layout";
};
type MutationReceiptV1 = {
  requestId: string;
  argumentDigest: string;
  operationId: string;
  state: "succeeded";
  artifact: ArtifactRefV1;
  contentDigest: string;
};
```

baseURL、ブラウザー向け埋込みOrigin、通常画面URL、認証手段は backend の接続設定・発見結果に保持し、上記のモデル向け投影には含めない。`instanceId` は保存領域の同一性を表す。別保存領域への接続変更で旧成果物を再解釈しない。catalogの更新と文書の更新は別の版として扱う。

create は title と Markdown本文、update は成果物参照・`expectedRevision`・置換するMarkdown本文を受ける。read は確定版を読み、latest の解決は別操作にする。初版は全文置換で、部分patch・自動mergeは追加しない。選択箇所の修正でも基準版の全文を取得して新しい全文を作る。

書込みAPIは同じ requestId と同じ引数digestなら同じ結果を返し、同じrequestIdと異なる引数なら409相当で拒否する。更新の基準版不一致も409相当。要求IDによる操作照会は「未受理」「処理中」「成功」「失敗」を区別し、404を保存失敗と推定しない。照会結果とreceiptは actor・scope・instance・要求IDに束縛する。

`argumentDigest` は strict schema で検査した値を、契約で固定したフィールド順・UTF-8 JSONで表現した SHA-256。省略値と既定値の扱いも契約fixtureで固定する。`contentDigest` は保存されたMarkdownのUTF-8 bytesの SHA-256。改行やUnicodeを送信後に黙って正規化しない。外部が本文を変換する場合は、変換後の確定版本文を読み直してdigestを確認する。

初版の入力上限案はタイトル200文字、文書256 KiB、モデルに渡す一回の文書本文24 KiB、選択文字列8 KiB、結果metadata32 KiB、HTTP応答のmeta64 KiB。上限は受信streamでも検査する。基準版全文がモデル予算に収まらなければ修正を止め、範囲縮小を案内する。黙って切り詰めた全文を保存しない。標準HTTP期限30秒、操作追跡の期限10分、セッション最長5分とし、外部の上限が短ければ短い方を使う。

## 7 保存する台帳と成果物参照

| 保存対象案 | 内容と一意制約 |
| --- | --- |
| `external_app_bindings` | instance・契約版・配備版・binding generation・非秘密の接続識別。秘密は保存しない |
| `external_app_operations` | local操作ID、tool invocation ID、requestId、引数digest、基準版、remote operation ID、remote状態、採用状態、取消epoch、期限。requestIdは一意 |
| `artifact_items` | Eumenes内ID、instanceId、externalId、kind。instanceId＋externalIdは一意 |
| `artifact_revisions` | item＋revision、確認済みdigestと表示metadata。本文は保存しない |
| `artifact_links` | 会話・run・invocationと確定版の関連。再照合でも同じ関連を重複作成しない |

`remoteState` は `not_sent / pending / succeeded / failed / unknown / cancelled`、`adoptionState` は `pending / adopted / suppressed / interrupted` の別軸とする。remote保存成功と取消後の不採用を同時に表現する。既存の Run.status と queue の状態列にこの組合せを押し込まない。

外部送信用本文は操作待ちの間だけ、上限付き `request_payload_json` として台帳に保持する。採用・取消・終了後に消し、最大24時間で失効させる。SQLiteの論理削除であり安全消去は保証しない。ログやMemory収集へは渡さない。セッションtoken、frameのnonce、取得本文はメモリーのみとし、期限・再起動で失効する。

会話リンクは当時の確定版を保持する。最新の表示metadataは取得時刻付きcacheであり、外部の正本を上書きする根拠にしない。外部が過去版を削除した場合は、その版が利用できないことを表示し、最新へ無断で置き換えない。

## 8 実行と取消と復旧

1. backend が現在の依頼、対象参照、scope、有効な契約版、基準版を確認する。
2. 単一 writer のtransactionで invocation、外部操作台帳、queue jobを予約する。requestIdと引数digestは送信前に確定する。
3. queue handler は送信直前にも取消epoch、期限、binding generationを確認する。送信開始を記録し、transaction外でHTTPを送る。
4. 同期receiptまたはremote operation IDを受け取り、照会する。通信切断なら保存結果不明とし、POSTを新しい要求IDで自動再送しない。
5. 成功receiptはschema、instance、requestId、digest、対象・基準版、現在の権限を検査する。必要な確定版metadataも外部APIで確認する。
6. 取消epochとtask revisionを再確認し、applicationの一つのtransactionでremote結果、成果物参照、tool完了の保存を行う。agentの結果採用は既存の照合経路を通す。
7. commit後にSSEを通知する。カード・パネル・回答は保存確定後に更新する。

ローカルDBと遠隔DBを一つのtransactionでは保存できない。外部成功後のローカル保存失敗は、同じrequestIdの読取り照合と一意制約で復旧する。送信開始の記録直後に落ちた場合も、実際には未送信かもしれないためunknownとして照合する。明確な未受理結果を受けても、再起動したAI taskから新しい書込みは自動実行しない。

取消前に送信済みなら、外部が対応する取消APIを呼ぶ。未対応・未確認なら「依頼を停止。外部の保存状況は確認中」と表示する。取消完了、期限超過、scope失効後の遅着結果は会話や成果物リンクへ採用しない。外部で作られた成果物は自動削除せず、remote台帳に実績を残す。不採用の成果物は通常カードへ混ぜず、明示的な操作状況確認でのみ、現在の権限を検査して案内する。

再起動時は全handler登録 → 台帳復旧 → 既存agent/dialogueの中断処理 → queue復旧 → worker開始の順を調整し、既存の復旧規則と矛盾させない。旧未送信書込みは中断、送信済み/unknownは読取り照合用のjobだけを予約する。照合は最大24時間・最大8回、間隔を延ばし、読取りに認証失敗が出たら停止する。解決しなければunknownのまま手動確認を案内する。旧AIへの自動回答採用はしない。

機能無効化中は復旧でも外部通信しない。再有効化後も新規POSTはせず、未確定操作の照合を明示操作から開始する。アプリ停止は、通常会話と既存Web調査の動作を妨げない。

## 9 能力と結果と完了条件の拡張

初版の登録は Eumenes の組込み定義として `markdown.create`、`markdown.read`、`markdown.update` を追加する。各toolはstrict schema、出力schema、書込みか読取りかの分類、必要scopeを持つ。接続先が対応しない能力は実行候補にしない。

能力packageに固定版の `inputSchemaKey`、`outputSchemaKey`、`verifierKey` を持たせ、agent-runtimeの `researchInput` 固定処理をpackageごとの処理へ切り替える。verifierはコード内のallowlistで解決し、外部manifestの文字列から任意コードをロードしない。既存web packageの調査検査は維持する。

tool結果は、検索・資料取得、確定版読取り、保存receiptのdiscriminated unionへ拡張する。raw外部応答をLLMに渡さず、必要な本文または短いmetadataへ正規化する。期限付きvaultと永続成果物参照は別の型にする。

worker完了も調査報告と成果物操作報告を区別する。成果物操作では、AIが指定した参照がそのtaskの成功invocationで観測した確認済み参照と一致することをhostが検査する。別taskのreceiptやモデルが創作したIDで完了にできない。親に渡すのは短い要約と確認済み参照、未確定・部分失敗の状態であり、任意HTMLやcredentialを含めない。

文書内の指示や埋込みイベントを新しい実行許可として扱わない。文書本文は引用データとして文脈へ入れ、利用者の依頼と分離する。内部作成本文や編集API応答を音声・態度学習の収集経路へ流さず、会話の最終回答だけを既存経路で扱う。

## 10 成果物APIと画面

以下は新設する Eumenes API案。外部アプリの現行APIではない。

| API案 | 挙動 |
| --- | --- |
| `GET /api/external-apps` | 接続・契約・対応操作・非対応理由。秘密や内部endpointは返さない |
| `GET /api/artifacts?conversationId=...` | その会話で採用された成果物リンクをcursorで取得 |
| `GET /api/artifacts/:id/revisions/:revision` | 外部を確認した指定版のmetadata。現在の権限を検査 |
| `POST /api/artifacts/:id/resolve-latest` | 最新の版を明示的に解決。過去リンクは変更しない |
| `POST /api/artifacts/:id/view-session` | 指定版・read/edit別の短期セッションを外部で発行 |
| `POST /api/artifacts/:id/refresh` | 保存イベントを契機に外部を再確認し、表示metadataを更新 |

会話のsubmitに任意の `artifactContext` を追加する。成果物ID、revision、選択location、短い選択textを受け、scopeと指定版をbackendで確認する。選択textはブラウザー由来の参考情報であり、更新時には基準版本文を再取得する。初版のMarkdown位置は版に属する文字範囲と抜粋。位置・抜粋が一致しなければ再選択を案内する。doclingのページ・slide・sheetは後続の専用location型にする。

Markdown位置は保存版の元Markdown文字列に対するUTF-16 code unitの `[start, end)` とする。表示DOMやTipTapの内部位置を直接送らず、外部アプリが元Markdownへ対応付ける。surrogateの途中を指す範囲は拒否する。対応付けを確定できない選択は文書参照＋抜粋だけで質問へ渡し、範囲更新として扱わない。

カードはタイトル・種類・作成/更新状態・確定版を表示する。パネルは指定版の閲覧と、最新を開いて編集する操作を区別する。履歴の過去版を編集する場合は最新との差を確認し、過去版を基準に黙って上書きしない。「この箇所について質問」は入力欄への添付まで、送信は利用者操作とする。

人が埋込み画面で保存した場合、親はイベントだけで成功扱いせず外部APIで保存版を確認する。その編集実績は `source=user_edit` とし、AI invocationに偽装しない。確認が取れない間は未確認表示を保つ。

最新状態はパネルを開く時、フォーカス復帰時、保存イベント時、明示更新時に確認する。一般的な外部変更の定期監視はしない。進捗表示は保存済み台帳を使い、commit後の既存SSEから再取得する。iframe内の未保存編集は外部アプリが所有し、Eumenes再起動後の復元を保証しない。

CLIも同じAPIと台帳を使い、成果物ID・版・通常画面への案内を返す。CLIからDB・外部アプリのcredentialを直接扱わない。

## 11 埋込み画面の認証と通信

EumenesのAPI token、LARM control token、外部アプリのserver credentialをframeへ渡さない。backendが固定したactorとscopeでセッションを発行し、当該instance・成果物・版・read/edit・最長5分に限定した委任セッションだけをブラウザーのメモリーへ渡す。URL、履歴、DB、localStorage、ログに保存しない。外部アプリは資産取得と保存のたびに権限・版・失効を検査する。

frame URLは管理者登録または検証済み発見結果の埋込みOriginと固定pathから組み立て、任意の成果物URLをそのままiframeへ渡さない。HTTPSの画面からHTTPのframeを開く構成は拒否する。LARMの内部APIアドレスとブラウザーから到達する表示先は別に扱う。

初版のsandboxは `allow-scripts allow-downloads`。`allow-same-origin`、forms、top navigation、popupsは追加しない。この構成に合わせた専用埋込み入口が外部側の必須条件であり、Cookie前提の通常画面をそのまま埋め込まない。

opaque originのframeでは `event.origin` が `null` になり得る。origin文字列の一致だけを認証としない。登録URLとロード状態、`event.source === iframe.contentWindow`、frame単位のnonce、strict schemaを検査し、ready後にMessageChannelへ切り替える。初期送信で必要な `targetOrigin="*"` は、取得済みwindowへのnonce付きbootstrapに限定する。reload・navigationでchannelとセッションを失効させ、再handshakeする。ブラウザーfixtureでこの前提を実証する。

イベントは `ready / saved / selection / error / expired` の固定集合。実行命令、URL変更、shell、任意tool名、外部公開をイベントから受け付けない。title・選択textはtextとして表示し、HTMLを直接挿入しない。通信断や期限切れでは再接続操作を提示し、自動で無期限に権限を延長しない。見せた内容を利用者の記憶から取り消せるという意味の失効表示はしない。

Doclingの既存コード承認・利用者別Bearer方式を使う場合は、その契約に従う。上記セッション方式への統一は別変更であり、Eumenesの接続だけで暗黙に省略しない。

## 12 エラーと運用

| 条件 | 利用者への状態と復旧 |
| --- | --- |
| 非対応major・必須機能不足 | 接続は認識するが能力を無効化。未対応理由を表示 |
| 更新競合 | 保存しない。最新の版を開き、対象を再確認して再依頼 |
| POST後の切断 | 保存結果不明。要求IDで照合し、新規作成を自動再送しない |
| 遠隔成功後のローカル失敗 | 同じ操作を照合し、参照保存を重複なく復旧 |
| 保存成功後のframe失敗 | 保存済みと表示失敗を別表示。再表示だけを試す |
| 文書削除・過去版消失 | その参照を利用できないと表示。最新に自動置換しない |
| scope・credential失効 | 操作・session・照合を止め、接続設定の確認を案内 |
| 通常画面での更新 | 次の明示取得で最新版を確認。過去リンクは保持 |
| 接続先の保存領域変更 | 旧参照を新instanceへ転用せず、接続先変更を表示 |

HTTP redirectは自動追従しない。認証を付けるorigin・pathはadapterごとのallowlistに限定する。外部APIを汎用Web readのURL制限を緩める方法で実装しない。

ログはrootRunId、taskId、invocationId、local operation ID、jobId、HTTP X-Request-Id、state、error code、bytes、時間に限定する。本文、選択、credential、session、設定、Provider生応答は出さない。未知の外部error messageは安全なcodeへ正規化する。障害調査は `bun run logs -- --level warn` から始める。

## 13 実装順と段階ごとの完了条件

| 段階 | 実装内容 | 次へ進む条件 |
| --- | --- | --- |
| T0 | 既存ツールチェーンのbaseline固定、外部契約とfixture、LARMとの契約差分の確定 | 既存Web gateを確認。外部の必要機能・対応版・担当repositoryを明記 |
| T1 | artifactsのmigration・参照・リンク・公開操作・client | 版別の再表示、同名別instance、重複リンク、削除・権限拒否の試験が通る |
| T2 | LARM発見拡張、external-appsのbinding・台帳・HTTP adapter・照合 | rollback時に送信なし。切断・遠隔成功後crash・再起動でも二重作成しない |
| T3 | capability schema・result union・package入力処理・verifier・gateway振分け | 実績のない成果物で完了不可。既存webの結果・出典検査・取消が維持される |
| T4 | 横パネル、frameセッション、handshake、選択添付、settings接続状態 | 実ブラウザーのsandboxで表示・期限切れ・不正イベント拒否が通る |
| T5 | dialogueの対象添付、AI更新、人の編集との競合、CLI、SSE再取得 | fixtureで全往復と取消・再起動を通し、全体gateが成功する |
| T6 | 隔離したLARMと実Markdownアプリで受入 | 作成・人の編集・AI更新・単体利用・再起動後表示を同じ成果物で確認 |

T0〜T5をEumenesのfixture実装完了、T6を実配備での初版受入と呼ぶ。外部側の必須条件が未配備ならT6未実施と記録し、全体の利用可能を宣言しない。音声操作を評価する場合も、既存の実機器3往復受入を省略しない。

## 14 検証と記録

domain試験には、基準版競合、requestId再利用、異なる引数による再利用拒否、remote receipt偽造、別task/instanceの参照、scope失効、取消epoch、期限超過、binding変更、応答上限を含める。application試験には送信前rollback、POST直後crash、遠隔成功後のローカルrollback、復旧job重複、参照保存とtool完了の原子性を含める。

Playwright fixtureは外部サービスのテスト用Originを使い、opaque sandbox、MessageChannel、nonce不一致、別window、schema不正、reload、session期限・失効、未保存編集、保存後再確認を検証する。単なるpostMessage mockでブラウザー受入を代替しない。CLIとWebの同じ対象・基準版でAPIの結果が一致することも確認する。

通常の確認コマンドは、domain追加後に以下を実行する。文書内のコマンドは実行予定であり、今回成功した記録ではない。

```sh
bun run verify -- --domain artifacts
bun run verify -- --domain external-apps
bun run verify -- --domain capabilities
bun run verify -- --domain tool-runtime
bun run verify -- --domain agent-runtime
bun run verify -- --domain dialogue
bun run verify -- --domain larm
bun run verify -- --domain settings
bun run verify:all
```

T6用に `scripts/verify-live.ts` の `--domain external-apps` dispatchと専用scriptを追加する。現行ではこのdomainを実行できない。既存larm・agent-runtime経路とASR WAV条件は変更しない。新しいlive経路は明示フラグ、対象instance、隔離データscope、接続設定がない場合は終了し、fixtureへ代替しない。受入はテスト文書だけを作り、既存の利用者文書を更新しない。

受入シナリオは、文書作成、frame表示、人の修正、選択添付とAI更新、単体アプリから編集、最新再取得、履歴の確定版表示、Eumenes再起動、外部停止と再接続、競合、書込み中取消、保存結果不明の照合。AI出力の意味的な品質は人が別に確認する。

`spec/verification/external-apps/README.md` に対象版、件数、fixture/live/利用者受入の区別、未実施項目を保存する。生データはGit管理外の `verification-reports/external-apps/`。秘密や文書本文を含むtraceを共有用証拠にしない。実装前後の通常会話とWeb調査の回帰も確認する。

## 15 後続の接続

Doclingは検索・親文脈・出典の版と位置・既存ビューアーを接続する。searchの出典参照と新規生成文書の成果物参照を別の型として扱う。DoclingはOffice編集サービスと解釈しない。既存のactor署名とcollection/project/regionのscopeをEumenesのbackendに対応させる。

カレンダーは予定案の成果物と、実行予約のschedulerを別の業務対象にする。表示した予定案だけでqueueや通知を予約しない。正本サービスでtimezone・DST・繰返し・競合・リソース割当の契約を確定してからwrite adapterを有効化する。

帳票は版付きJSON文書の保存・編集から始める。ブラウザー印刷とサーバー生成PDFは別の操作として扱う。出力PDFは編集文書の版と結び付ける。

汎用MCPは具体的な複数接続で共通性を確認した後に追加する。HTTP adapterの導入時点で未使用のMCP設定・空クラス・任意コード実行を作らない。

## 16 AIレビューへの依頼

この計画を、独立した機能リポジトリの保守と日常利用を両立しながらEumenesから操作・表示するための実装計画としてレビューしてください。草案のAPIや配備条件を実装済みと解釈しないでください。現状の確認は第1章の作業ツリーを基準にし、資料だけで確認できない点は不明として扱ってください。

優先して検討する点:

1. LARM、外部アプリ、Eumenesの責務に重複や欠落があるか。機能側をEumenes専用にしていないか。
2. Markdown用の外部必須契約が現実的か。初版で過去版保持を必須とする費用と、履歴の正確さが釣り合うか。
3. domain依存方向とtransactionの所有が一貫しているか。既存Web調査の専用処理を見落としていないか。
4. 保存成功後のcrash、POST結果不明、取消、再起動、無効化で、二重作成・誤った完了・遅着採用が起きないか。
5. opaque sandboxとframe認証の契約が実ブラウザーで成立するか。credentialの漏えい、別文書への権限拡張、イベント偽造を防げるか。
6. 外部API照合と人の編集が競合する場合に、基準版・最新・履歴が混同されないか。
7. 能力のschema・verifier拡張が初版に対して過剰でないか。任意外部schemaやコードへ権限を広げていないか。
8. fixtureとliveの完了条件で本当に利用可能を確認できるか。外部リポジトリの未配備機能を隠していないか。

指摘は「対象章・問題が起きる条件・具体的な影響・最小修正案・受入試験」の順で提示してください。実装前に必須の修正、初版で許容できる制約、後続の改善を分け、一般論の機能追加よりデータ整合性と実装時の手戻りを優先してください。

## 17 未確定事項と実装前の確定条件

| 未確定事項 | 確定する段階と判断方法 |
| --- | --- |
| Markdownの単体アプリを機能repo内へ置くか、別repoにするか | T0。機能のpackage公開を維持し、単体/埋込みが同じAPIを使える配置を選ぶ |
| LARMのアプリ用広告の正式なprotocolとcredential提供方式 | T0。LARM側の公開契約を確認し、本書の内部bindingへadapterで対応させる |
| 文書版・idempotency結果の外部保持期間 | T0。初版は版保持と要求結果の7日以上保持を必要条件案とし、再配備でも同じinstanceを維持する |
| 対応する配備版とsandbox session方式の実装可否 | T0〜T4。外部の契約fixtureとブラウザー試験で固定する |
| 作業ツリーのツールチェーンが合流するbaseline | T0。既存fixture gateと差分を確認し、採用時のcommit/主要hashを記録する |
| 上限値・追跡期限と日常利用の文書サイズ | T6。受入で不足を示す場合だけ、明示的に変更し再検証する |

これらの未確定事項は各repositoryの実装・配備順に影響する。レビュー後に決定を更新し、T0を終える前に必要契約と担当範囲を確定する。
