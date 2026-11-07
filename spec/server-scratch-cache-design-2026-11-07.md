# 一時ファイル（scratch）の設計（2026-11-07）

状態: 合意済み（2026-11-07 利用者回答「実装してください」）・P1〜P5 実装済み・fixture 検証済み。live（実 LARM での添付→3D、サブエージェントの書出し→別担当の読取り）とサーバー反映・実機器の確認は未実施。実装時の調整は §15。

依頼（2026-11-07 利用者）

1. 「サーバーが起動している間だけ存在できるキャッシュを作ろうと思います。…プロンプトに画像を添付しておくると、LLMはそれを参考に回答します。ですが、この画像はそれっきりで、これを起点に次のアクションに繋げられません。この画像を3Dオブジェクトに作って欲しいというリクエストに応えられません。一時的に参照できるファイルだったり、markdownだったり、という立ち位置です。実際にはメモリーでなくてよくて、ssdに書き込んで構いませんが、ある程度容量が一杯になるとクリーニングが実行される感じです」
2. 「2GBは確保してもいいです。3Dだけに使うものでは無いですね。ただ、常に会話前後に引用ID的な物を使ってエージェント間の共有に使える想定です」

第2版の変更: 目的を「会話の前後で引用IDを付け、エージェント間で内容を共有する置き場」にした（§2〜§4、§8、§9）。3D化は使い道の一つとして §11 に移した。容量は2 GiBで確定。

## 1. 現状

| 項目 | 今の動き | 場所 |
| --- | --- | --- |
| 引用ID | 会話ごとのリソース台帳が `eumenes://<kind>/<id>` に番号 `a<n>` を振る。登録元は `work`・`found`・`viewed` | `api/domains/dialogue/service/resource-ledger.ts`、`contracts/resources.ts:7` |
| 会話エージェントに見える番号 | State の「提示中」に、直前の返事で示したものと画面に表示中のものだけ（4行まで） | `api/domains/dialogue/service/state-text.ts:195-226` |
| サブエージェントへ渡す | `delegate` の `refs` に `a<n>` を書くと、URI と先頭2,000字が RESOURCES 区画に入る | `api/domains/dialogue/service/delegate-refs.ts` |
| サブエージェントが読む | 共通の `resource.read`（1件の作業で8回まで、残すのは4,000字まで）。持ち主の domain が600 token以内に縮めて返す | `api/domains/agent-runtime/service/resource-access.ts`、`step-actions.ts:215-238` |
| サブエージェントが返す | `finish.links` に、渡された URI か自分の tool が返した URI だけ書ける。台帳に `work` で入る | `resource-access.ts`、`work-links.ts` |
| 持ち主のない内容 | 添付画像（SQLite の BLOB）、長い貼り付け、担当の下書き・抜き書き・中間の表は、どの domain のリソースでもないので番号が付かない | `api/domains/conversation/repository/attachments.ts` |
| 3D生成の元画像 | LARM 画像ライブラリの生成済み画像だけ | `api/application/media/model3d-adapter.ts:71-84,152-170` |

引用IDの仕組み（台帳・渡す・読む・返す）は揃っている。足りないのは、持ち主のない内容に番号を付ける置き場と、どの担当からでも書き出せる口。

## 2. 方針

新しい domain `scratch`（表示名「一時ファイル」）を、持ち主のない内容の持ち主にする。中身は SSD 上のファイル、索引はメモリーだけに持ち、サーバーの起動ごとに空から始まる。各ファイルはリソース `eumenes://scratch/<uuid>` として台帳に入り、引用IDは既存の `a<n>` をそのまま使う。新しいID体系は作らない。

| 層 | 置くもの |
| --- | --- |
| `api/domains/scratch` | 保存・索引・容量・掃除・貸出（lease）・ResourceAdapter・HTTP の読出し。ほかの domain を参照しない |
| `api/domains/agent-runtime` | 共通の `scratch.write` と、`resource.read` の `offset` |
| `api/domains/dialogue` | 台帳の登録元 `attached`、State の「共有中」 |
| `api/application` | 添付・貼り付けから一時ファイルへの登録、各 domain との接続 |
| capabilities bundle | resource kind `resource.scratch` |

## 3. 会話の前後の共有

| 時 | 何が一時ファイルになるか | 登録元 | 作り手の表示 |
| --- | --- | --- | --- |
| 前 | 利用者の添付画像（変換前の元画像） | `attached` | 利用者が添付 |
| 前 | 利用者の添付ファイル（§5 の文書・3D、P5） | `attached` | 利用者が添付 |
| 前 | 2,000字を超える利用者の発言の本文（発言そのものは変えない） | `attached` | 利用者が貼付 |
| 中 | 会話エージェントが `delegate` の `refs` に `a<n>` を書く（既存） | — | — |
| 中・後 | サブエージェントが `scratch.write` で書き出し、`finish.links` で返したもの | `work` | 担当の表示名が作成 |
| 後 | domain の adapter が結果を一時ファイルに包んで返したもの（domain の内部 API） | `work` | 担当の表示名が作成 |

Agency・Pursuit の作業も同じサブエージェントの実行と台帳を通るので、同じ規則で共有される。

## 4. 引用の規則

| 規則 | 内容 |
| --- | --- |
| IDの範囲 | 引用IDは会話ごと。別の会話からは指せない |
| 指す | 会話エージェントは `a<n>`、サブエージェントは URI を使う（既存） |
| 見える | 会話エージェントには、毎ターン State の「提示中」と「共有中」に番号が出る（§8.1） |
| 渡す | `delegate` の `refs`（既存）。一時ファイルも他のリソースと同じに扱う |
| 読む | `resource.read`。一時ファイルの文書は `offset` で続きを読める（§9.2） |
| 書く | サブエージェントだけが `scratch.write` で書ける。会話エージェントの道具は増やさない |
| 返す | `finish.links`（既存の検査のまま）。`scratch.write` の返した URI は「自分の tool が返した URI」に当たる |
| 返さなかった書出し | 台帳に入らず、その作業の中だけで使える。LRU で消える |
| 発話 | 番号・URI は道具の引数と画面のチップだけで使い、読み上げない（既存の `a<n>` と同じ扱い） |
| 消えた | 再起動・掃除で無くなった項目は、提示中・共有中・チップに出ない。読むと `item_not_found` |

## 5. 保存の構成

| 項目 | 決め |
| --- | --- |
| 置き場所 | `<dataDir>/scratch/<bootId>/<uuid>`。`dataDir` は既存の `dirname(EUMENES_DB)`（既定 `./data`）。ファイル名は uuid だけで、利用者のファイル名を使わない |
| 索引 | メモリーの Map（id・会話・名前・MIME・大きさ・sha256・画像なら縦横・注記・作り手・作成時刻・最終使用時刻）。SQLite に書かない |
| 書込み | 同じディレクトリの一時名へ書いてから rename（`api/infrastructure/atomic-file.ts`）。rename 後に索引へ入れる |
| 同じ内容 | 同じ会話・同じ sha256 は同じ項目を返し、最終使用時刻だけ更新する |
| 1件の上限 | 100 MiB（`scratch.write` は 1 MiB） |
| 件数の上限 | 2,000 件 |
| 寿命 | サーバーの起動から停止まで。時間による期限は持たない（容量だけで消す） |

受け付ける種類:

| 種類 | MIME | 入口 |
| --- | --- | --- |
| 画像 | `image/jpeg`・`image/png`・`image/bmp`・`image/webp` | 添付、domain 内部 |
| 文書 | `text/markdown`・`text/plain`・`text/csv`・`application/json` | 貼り付け、`scratch.write`、添付、domain 内部 |
| PDF | `application/pdf` | 添付、domain 内部 |
| 3D | `model/gltf-binary` | 添付、domain 内部 |

SVG・HTML・実行形式は受け付けない（`scratch_type_unsupported`）。

## 6. 容量と掃除

| 規則 | 内容 |
| --- | --- |
| 上限 | 合計 2 GiB。超える書込みの前に掃除する |
| 掃除の目標 | 合計 1.5 GiB 以下まで減らす |
| 空き容量 | ボリュームの空きが 5 GiB 未満なら上限超えと同じに扱う（`fs.statfs`） |
| 消す順 | 最終使用時刻の古い順（LRU）。読出し・`refs` での引渡し・提示中への表示で時刻を更新する |
| 貸出中 | 処理中のジョブが借りている項目は消さない。貸出は最長30分で自動返却 |
| 消しきれない | 貸出中ばかりで目標に届かず新しい1件が入らなければ、その書込みを `scratch_capacity`（HTTP 507）で断る |
| 件数超過 | 2,001 件目の前に同じ順で1件以上消す |

ログは件数と大きさだけを出す。ファイル名・本文・会話 id は出さない。

```json
{"level":"info","component":"scratch","event":"scratch.evicted","reason":"capacity","count":42,"bytes":523190272}
```

## 7. 起動と停止

| 時 | 動き |
| --- | --- |
| 起動 | lifecycle `scratch_start` で `<bootId>` ディレクトリを作る。`scratch/` 下のほかのディレクトリ（前回・異常終了の残り）は listen を待たせずに背景で消す |
| 停止 | 自分の `<bootId>` ディレクトリを消す。消せずに終わっても次の起動で消える |
| 再起動後の台帳 | SQLite の台帳の行は残るが、項目が無いので解決できず表示されない（`responseInTransaction` の既存の扱い） |

dev の watch による再起動でも中身は消える。

## 8. 会話エージェントから見える形

### 8.1 State

「提示中」に直前の利用者の発言の添付・貼り付けを足す。新しい欄「共有中」に、この会話の一時ファイルのうち提示中に無いものを最終使用の新しい順で6件まで出す。どちらも項目が残っているものだけ。

```text
提示中:
- a7「IMG_2041.jpg」（利用者が添付、画像 1600×1200）
- a3「青緑のロボット」（直前の返事で示した）
共有中:
- a9「競合3社の価格表.md」（Web調査が作成、Markdown 8KB）
- a5「貼り付けた文章 13:58」（利用者が貼付、テキスト 6KB）
```

「共有中」は [会話の入力仕様](conversation-input-spec-2026-10-26.md) の State のホストの欄（今・仕事・提示中）に足す4つ目の欄で、本書の合意をもってその仕様の変更とする。

### 8.2 `resources` の read（600 token 以内）

```text
一時ファイル「IMG_2041.jpg」
種類: 画像（image/jpeg、1600×1200、412KB）
作成: 2026-11-07 14:02 利用者が添付
注記（object-recognition）: {"objects":[{"label":"cup","score":0.91}]}
サーバーの再起動で消えます。
```

## 9. サブエージェントから見える形

### 9.1 `scratch.write`（全担当の共通 host tool）

`resource.read` と同じく全担当に出す。1件の作業で8回まで。

```json
{"action":"invoke","tool":"scratch.write","arguments":{"name":"競合3社の価格表.md","mime":"text/markdown","text":"| 社名 | 月額 |\n| --- | --- |\n| A社 | 980円 |"}}
```

```json
{"uri":"eumenes://scratch/2c1d7a40-…","name":"競合3社の価格表.md","bytes":8123}
```

| 欄 | 規則 |
| --- | --- |
| `name` | 1〜120字。表示名で、保存のファイル名には使わない |
| `mime` | `text/markdown`・`text/plain`・`text/csv`・`application/json` |
| `text` | 1 MiB 以内 |

返すときは既存の `finish.links` に書く。

```json
{"action":"finish","summary":"3社の価格を表にしました","links":["eumenes://scratch/2c1d7a40-…"]}
```

### 9.2 `resource.read` の `offset`

`resource.read` に省略できる `offset`（位置。実装は UTF-8 のバイト位置、§15.2）を足す。ResourceAdapter の `read` に `{ offset }` を渡し、一時ファイルの文書は `offset` から既存の上限（600 token）まで返す。続きがあれば最後の行に書く。ほかの kind は `offset` を無視して今の通りに返す。

```text
一時ファイル「議事録_1107.md」（Markdown 24KB、位置 2400〜4800／全 24576）
…本文…
続き: offset 4800
```

## 10. HTTP

| 経路 | 内容 |
| --- | --- |
| `GET /api/scratch/:id/content` | 本体。アプリ共通の認証・Origin 検査の内側。`X-Content-Type-Options: nosniff`。画像と `text/*` 以外は `Content-Disposition: attachment` |
| `GET /api/scratch/:id` | 索引の項目（本文なし） |

Web と CLI はこの API だけを使う。

## 11. 使い道の例

| 例 | 流れ |
| --- | --- |
| 添付画像を3Dに | §11.1 |
| 長い貼り付けを調べさせる | 利用者が仕様書を貼る → `a5`（利用者が貼付）→ 会話エージェントが `refs: ["a5"]` で調査担当へ → 担当が `resource.read` の `offset` で全文を読む |
| 担当の成果を別の担当へ | Web調査が表を `scratch.write` → `finish.links` → `a9`（共有中）→ 次の依頼で `refs: ["a9"]` を Markdown 担当や計算担当へ |
| 添付画像を別の担当へ | `a7` を物体認識・OCR・画像入力のできる担当へ `refs` で渡す（各担当が一時ファイルの画像を受けるのは担当ごとの対応） |

### 11.1 添付画像を3Dにする

| 順 | 処理 | 担い手 |
| --- | --- | --- |
| 1 | 「これを3Dにして」で model3d の snapshot を読む。`images` の先頭に、この会話の一時ファイルの画像を新しい順で足す（合計5件の枠のまま） | `model3d-adapter.ts` |
| 2 | `generate` の `sourceImageRef` が一時ファイルなら、生成の source を `{ type: "scratch-image", id }` で受け付け、項目を貸し出す | model3d |
| 3 | 生成ジョブの最初の段（表示「元画像を保存中」）で WebP・長辺2000px以下に変換し、既存の image import で LARM ライブラリへ入れる。UUID は生成ごとに固定して冪等にする | model3d の port を application が実装 |
| 4 | 得た artifact id で今の mesh 生成に進み、貸出を返す | model3d |

```json
"images": [
  { "imageRef": "eumenes://scratch/5b0c6f1e-…", "title": "IMG_2041.jpg", "origin": "attached", "createdAt": "2026-11-07T05:02:11.000Z" },
  { "imageRef": "9f3e…", "title": "青緑のロボット", "origin": "generated", "description": "白い背景に…", "createdAt": "2026-11-07T03:40:00.000Z" }
]
```

| 規則 | 内容 |
| --- | --- |
| ライブラリに残る | 3D の元にした画像は LARM 画像ライブラリに取り込まれて残る（3D モデルの元として再起動後も辿れる） |
| 消えていた | 段3の前に一時ファイルが無ければ `model3d_image_not_found` で失敗にする（作り直さない） |
| 容量待ち | 取込の 503 `resource_exhausted` は LARM の共通部品の待機に従う |
| SKILL | model3d の SKILL の「さっきの画像」に「添付した画像（origin `attached`）」を足す。どれか分からなければ聞き返す既存の規則のまま |

## 12. Web

| 項目 | 内容 |
| --- | --- |
| チップ | 添付・貼り付け・書出しの一時ファイルを既存のリソースのチップで出す |
| open | `adapter:scratch@1` の画面で、画像は表示、Markdown は描画、テキスト・JSON・CSV は等幅表示、それ以外はダウンロード |
| 添付ボタン | 画像以外のファイル（§5 の文書・PDF・3D）を足す。画像以外は LLM の入力に載せず、一時ファイルと台帳にだけ入れる |

DesignSystem・OpenUI の追加は[登録手順](../docs/toolchain-extension.md)に従う。

## 13. 段階と確認

| 段 | 内容 | 確認 |
| --- | --- | --- |
| P1 | `scratch` domain（保存・索引・容量・掃除・貸出・起動時の掃除・HTTP・ResourceAdapter と `offset`・resource kind） | `bun run verify -- --domain scratch`。LRU の順、貸出中を消さない、空き容量、同じ内容、前回ディレクトリの削除、上限超えの 507、`offset` の続き |
| P2 | 会話の前: 添付画像・長い貼り付け → 一時ファイル、台帳 `attached`、State の提示中・共有中 | `--domain scratch`・`conversation`・`dialogue` |
| P3 | エージェント間: 共通 `scratch.write`、`resource.read` の `offset`、`finish.links` への接続、domain の内部 API | `--domain agent-runtime`・`dialogue`・`scratch`。書出し→links→台帳→`refs` で別の担当が読む往復を fixture で |
| P4 | 3D: model3d の `images` 拡張、`scratch-image` source、取込の段、SKILL | `--domain model3d`・`image`・`scratch` |
| P5 | Web: チップ・閲覧画面・画像以外のファイル添付 | Web の固定試験、対象 E2E を個別に実行 |

各段は fixture・live・実機器の結果を分けて記録する。live（実 LARM での往復・添付→3D）は利用者の指示後に行う。

## 14. 対象外

| 項目 | 理由 |
| --- | --- |
| 再起動をまたぐ保持 | 依頼の寿命の定義による。残したいものは画像ライブラリ・Markdown 文書へ保存する既存の経路を使う |
| 会話をまたぐ引用 | 台帳が会話ごとのため |
| 会話エージェントの書出し | 道具の枠（固定）を変えない。書き出しは担当に頼む |
| 一時ファイルの画像の画素をサブエージェントへ入れ直す | 今のサブエージェントは画像入力を持たない。必要になった時点で別設計 |
| 参照画像による画像編集 | LARM の現行 API が未対応 |
| PDF の Markdown 化 | Docling の既存経路があり、一時ファイルとの接続は別設計 |
| 既存の添付の SQLite 保存・Markdown の期限付き入力 | 変えない |

## 15. 実装の記録（2026-11-07）

### 15.1 置き場所

| 段 | 主なファイル |
| --- | --- |
| P1 | `api/domains/scratch/`（contracts・service/store・describe・resource-adapter・controller・test）、`api/application/scratch/scratch-composition.ts`、`server-core.ts`・`server-lifecycles.ts`（`scratch_start`・`scratch`）・`app-modules.ts`・`resources/wiring.ts`、`capabilities/builtin/resource-kinds.ts`、`resources/contracts`（`note`・`ResourceReadOptions`） |
| P2 | `conversation/service/attachments.ts`（`AttachmentStored`）、`dialogue/repository/resources.ts`（`dialogue/0038-resource-attached`）、`dialogue/service/shared-files.ts`・`intake.ts`・`state-text.ts`、`dialogue/contracts`（`SharedFilesPort`・`fileIds`） |
| P3 | `capabilities/contracts/resource-read.ts`（`offset`・`scratchWrite`）、`capabilities/builtin/resource-read.ts`（`resource.read@2`・`scratch.write@1`）、`agent-runtime/service/host-tools.ts`・`resource-access.ts`・`step-handler.ts`・`step-actions.ts`・`tool-selection.ts`・`context.ts` |
| P4 | `model3d/contracts`（`shared-image`・`Model3dSharedImages`・段 `source_import`）、`model3d/service/handlers.ts`・`commands.ts`・`index.ts`、`model3d.bundle.json`（skill・package・toolchain を revision 3 へ）、`application/scratch/shared-image-import.ts`、`application/media/model3d-adapter.ts` |
| P5 | `client/scratch.ts`、`web/src/workspace/useChatFiles.ts`・`ChatImageInput.tsx`・`ScratchViewer.tsx`・`chat-send.ts`・`usePanelResources.ts`・`usePanelFileDrop.ts`・`ConversationHistory.tsx`、`web/src/domains/resources/ResourceChips.tsx` |

### 15.2 設計からの調整

| 項目 | 設計 | 実装 | 理由 |
| --- | --- | --- | --- |
| resource kind の登録 | capabilities bundle | builtin の resource kind 一覧（`resource.scratch`、`producedBy` は空） | 持ち主が host の kind（`event` など）は builtin に置く既存の形に合わせた |
| model3d の source 名 | `scratch-image` | `shared-image` | model3d と scratch は同じ tier で参照できない。model3d は port（`Model3dSharedImages`）だけを知る |
| 取込の容量待ち | LARM 共通部品の待機 | 取込の失敗は `model3d_source_import_failed` で生成を失敗にする（受付待ちは2分まで読む） | 既存の image import クライアントは待機の仕組みを持たない。作り直さない規則（§11.1）のまま |
| BMP の添付 | 変換前の元画像 | BMP だけ正規化後の画像（PNG/JPEG）を共有する | sharp と LARM の画像ライブラリが BMP を受けない |
| 共通の道具 | 全担当 | ホストが付ける（package が自分で持つときはその binding）。誘導型の Web 調査（guided）には付けない。`scratch.write` は会話の実行（execution）があるときだけ | guided は固定の手順。会話の無い実行では書いたファイルの持ち主が無い |
| 「道具を使わずに終える」検査 | — | ホストの道具は数えない | `resource.read`・`scratch.write` は何も取得しない |
| `resource.read` の読み直し | — | 同じ URI は最新の1ページだけを残す（既存の重複除き） | 8件の上限は URI ごと。ページ送りで上限を使い切らない |
| 画像以外の添付の送信 | 台帳にだけ入れる | 送信の入力に `fileIds`（最大8件）を足す。利用者が添付した（origin `attached`）この会話の項目だけを受ける | 送信と添付を同じ要求で結ぶため |
| アップロードの大きさ | 1件100 MiB | 経路は全体の JSON 上限から外し、経路自身が上限を読む（`app.ts`） | 添付画像の経路と同じ扱い |
| 同時アップロード | — | 2件まで、超えると 429 `scratch_busy` | 507 は容量不足だけに使う |
| ログ | `items`・`usedBytes` | `count`・`bytes`（既存のログ欄） | ログの欄は固定の一覧 |
| 閲覧画面 | `adapter:scratch@1` の OpenUI 画面、Markdown は描画 | 会話欄のダイアログ（画像は表示、テキスト・Markdown・CSV・JSON はそのまま、ほかはダウンロード） | Web に Markdown の描画部品が無い。画面の新設は別作業 |
| 「提示中」への表示で最終使用を更新 | 更新する | 更新しない（読出し・`refs` の引渡し・貸出・HTTP の取得で更新） | 毎ターンの表示で時刻を進めると、表示中の6件が消えなくなる |
| 書込みの部品 | `api/infrastructure/atomic-file.ts` | 同じディレクトリの一時名へ `Bun.write` してから `rename`（非同期、fsync なし） | `atomic-file.ts` は同期書込みと fsync で、100 MiB では event loop を止める。再起動で消える置き場に永続の保証は要らない。途中のファイルが正式な名前に出ない点は同じ |
| 層の参照 | ほかの domain を参照しない | `resources` の契約（`ResourceAdapter`・`formatResourceUri`）だけを参照する（`scripts/domains.ts` の depends も `resources`） | リソースの持ち主の domain はすべて同じ形で `resources` の契約に依存する |
| HTTP の経路 | §10 の2経路 | 加えて `POST /api/conversations/:id/scratch?requestId=`（multipart、欄 `file` の1件） | §12 の添付ボタンが必要とする受け口。`requestId` を項目の id にして再送を冪等にする |
| `scratch.write` の 1 MiB | 1 MiB | 入力の schema は 1,048,576 字まで、application の書出し口が UTF-8 で 1 MiB を超えるものを `scratch_too_large` で断る | 字数とバイト数の両方で抑える |
| 「共有中」を出すターン | 毎ターン | 会話の実行があるターン（利用者の発言・ホストの知らせ）。背景の呼出し（記憶担当・agency の背景・prewarm）の State には出さない | agency の背景の委譲は `refs` を渡せず、番号を出しても使えない |
| domain の内部 API（§3「後」） | domain の adapter が結果を一時ファイルに包んで返す | application の adapter が `ScratchStore.put`（origin `written`、作り手は担当の表示名）で書き、結果に `eumenes://scratch/<uuid>` を入れる。scratch の `fromResultInTransaction` が結果の中の、同じ会話で origin `written` の項目だけを拾う。`resources.dialogue.producesInTransaction` は全ツールチェーンに `scratch` を足す（agency の背景作業の結果にも同じ関数を使う） | kind `scratch` の `producedBy` は空で、どの担当の結果からも台帳に入らなかった（2026-11-07 の漏れの確認で修正）。利用者の添付は担当の成果として登録し直さない |

### 15.3 固定試験

| 試験 | 件数 | 結果 |
| --- | --- | --- |
| `api/domains/scratch/test/`（LRU の順、貸出中を消さない、期限切れの貸出、空き容量、件数、同じ内容と同じ id、前回ディレクトリの削除、上限超えの 507、`offset` の全ページ、画像の説明、HTTP の見出しと 415） | 16 | 成功 |
| `api/domains/dialogue/test/shared-files.test.ts`（`attached` での台帳登録と発言への結び、提示中・共有中、番号の無い項目と消えた項目を出さない、保存失敗でも受付） | 3 | 成功 |
| `api/domains/agent-runtime/test/host-tools.test.ts`（ホストの道具の付与条件、書出しの提示と `finish.links`、入力の検査） | 4 | 成功 |
| `api/domains/model3d/test/model3d.test.ts`（添付画像の取込→ライブラリ画像で送信、消えた画像・取込失敗） | 30（新規2） | 成功 |
| `api/application/media/model3d-adapter.test.ts`（添付画像の提示と `shared-image` への変換） | 5（新規1） | 成功 |
| `api/application/scratch/scratch-composition.test.ts`（添付の共有・BMP、貼り付け・`fileIds`、書出しと大きさの上限、ライブラリ取込） | 4 | 成功 |
| Web（`ChatImageInput`・`ConversationComposer`・`ScratchViewer`・`ResourceChips`） | 既存＋新規 | 成功 |

### 15.4 レビューと修正

独立レビュー1回（正しさ・セキュリティ）の指摘6件をすべて直した。

| 指摘 | 重大度 | 修正 |
| --- | --- | --- |
| 大きなテキストの `resource.read` が全文を code point の配列に展開し、メモリと CPU を使い切る（約20M字で RSS 4.5GB） | 高 | ファイルの `offset` から 8KB だけを読む（`store.slice`）。`offset` は UTF-8 のバイト位置で、文字の途中は次の文字の境界へ進める。このため `resource.read` を revision 3 にした（revision 2 は登録済みの本文のまま） |
| 同じ id の並行 `put` で使用量が二重に計上される | 中 | id（id が無ければ会話と内容）ごとに書込みを直列にし、後続は先の結果を返す |
| 空きが5 GiB未満のボリュームで、`put` のたびに貸出中以外を全部消したうえで失敗する | 中 | 貸出中以外を全部消しても入らない書込みは、何も消さずに 507 で断る |
| 121〜200字のファイル名の添付が共有されない | 低 | 名前を先頭120字で切る（空になるときだけ断る） |
| 3D の添付画像の一覧が会話 `main` 固定 | 低 | 依頼した会話の添付を出し、その会話の項目だけを受ける |
| 取消・送信前の失敗で 3D の貸出が残る | 低 | 送信の試行が終われば成否にかかわらず手放す。取消でも手放す。保持の表は貸出の期限（30分）で自動的に消す |

レビューで問題なしとされた範囲: id は全て uuid で検証してからパスにする（パストラバーサルなし）、配信は SVG・HTML を受けず `nosniff`・CSP・画像と `text/*` 以外は添付として配信、本文上限の除外は認証と Origin の検査の後、会話をまたぐ参照なし、State へ出す名前は制御文字を除く、ログに本文・ファイル名を出さない、`dialogue/0038` の作り直しは全列・索引・UNIQUE を保つ。

### 15.5 起動の確認と verify

| 確認 | 結果 |
| --- | --- |
| 本番 DB の写しで `buildServices`→停止 | 成功。適用済みマイグレーション（`dialogue/0038` を含む）の checksum 不一致なし。`resource.read@3`・`scratch.write@1`・`skill:model3d.studio@3`・`toolchain:model3d.studio@3` を登録 |
| 写しでの起動中の警告（本変更の外） | `browser-interact.bundle.json` の `skill:browser.interact.operator@1` が登録済みの本文と違い、bundle が読み飛ばされる |
| `bun run verify -- --domain scratch …` | inventory の段で停止。`artifacts/pursuit-integration-20261106/` 配下の 4,205 件の試験が実行経路に無いため（本変更の外）。後続の段を個別に実行した |
| 境界・SystemContext・SQL境界・domain文書 | 成功（境界の指摘は markdown の試験1件で本変更の外） |
| サイズ予算 | 本変更のファイルは予算内（残る3件は ImagePicker・MarkdownWorkspace・useWorkspace で本変更の前から） |
| 型 | 本変更のファイルにエラーなし（markdown・docling の並行作業中のエラーは残る） |
| 書式・lint | 本変更の91ファイルで指摘なし |
| 試験 | §15.3 と、関係 domain・application の一式（結果は §15.6） |

### 15.6 試験の結果（修正後）

| 範囲 | 結果 |
| --- | --- |
| `api/domains/{scratch,dialogue,agent-runtime,model3d,conversation,capabilities,resources}`、`api/application/{scratch,media,resources,toolchain}`、`app`・`server`（停止順に `scratch` を追加）・`migrations`・`lifecycle`、登録済み統合試験 | 1,211件成功 |
| Web（`web/src/workspace`・`domains/resources`・`domains/model3d`・`domains/dialogue`） | 142件成功・1件失敗。失敗は `shell-artifact.test.tsx`（CLI 画面の source 取得が error になる。本変更の外で、本変更の前から） |

live（実 LARM での添付→3D、書出し→別担当の読取り）、サーバー反映後の画面での確認、実機器は未実施。

### 15.7 漏れの確認と文書（2026-11-07）

利用者の指摘「READMEなのか機能一覧かわかりませんが、そちらに反映してないのか、他のエージェントが識別出来ていませんね」を受け、§1〜§14 をコード・試験と突き合わせ直した（独立の確認1回）。

| 確認 | 結果 |
| --- | --- |
| 実装の漏れ | §3「後」の行（domain の adapter が結果を一時ファイルで返す）が台帳に入らなかった。§15.2 の最終行のとおり実装した。試験は `api/domains/scratch/test/store.test.ts`（結果の中の URI のうち、同じ会話・origin `written` だけを拾う）と `api/application/server.test.ts`（組み立てた services の `producesInTransaction` が `scratch` を含む） |
| §15.2 に無かった差 | 書込みの部品・層の参照・HTTP の受け口・`scratch.write` の字数とバイト数・「共有中」を出すターンの5件を §15.2 に足した |
| 文書 | 機能一覧と文書の索引に一時ファイルが無かった。`docs/scratch.md` を新設し、`README.md`（機能表・文書の一覧・3D の行）、`docs/README.md`、`docs/chat-images.md`（画像以外の添付・添付画像の共有）、`docs/resources.md`（提示中・共有中・ホストの道具・登録元 `attached`）、`docs/model3d.md`（添付画像からの生成・`model3d.studio@3`）、`docs/toolchain-extension.md`（担当に付く共通の道具と一時ファイルの使い方）、`api/domains/scratch/README.md`（`offset` はバイト位置）を直した |
| アプリ内の識別 | Router の選択呼出しが `## State` 全体（提示中・共有中）を読み、引継ぎは State の `a<n>` を最大8件 `refs` に付ける（`routed-router.ts`）。3D担当の SKILL は origin `attached` を知っている。担当に付く `resource.read`・`scratch.write` は道具の一覧に出る |
| 試験（修正後） | `api/domains/{scratch,dialogue,agent-runtime}`・`api/application/{scratch,resources,agency,media}`・`server.test.ts` で927件成功。Web（`ScratchViewer`・`ChatImageInput`・`ConversationComposer`・`domains/resources`）で23件成功。書式・lint・境界・domain 表は成功。型は本変更のファイルにエラーなし（残る5件は並行作業中の `packages/artifact-ui` の Markdown） |
