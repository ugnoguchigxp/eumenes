# 一時ファイル（共有ファイル）

サーバーの起動中だけ残るファイルの置き場（domain `scratch`）。持ち主のない内容（利用者の添付・長い貼り付け・担当の書出し）を、リソース `eumenes://scratch/<uuid>` にする。会話の台帳で番号 `a<n>` が付くので、会話エージェントとサブエージェントの間で同じ番号で受け渡せる。再起動すると中身はすべて消える。残したいものは画像ライブラリや Markdown 文書に保存する。

状態: 実装・固定試験済み（2026-11-07）。実 LARM での「添付画像→3D」、サブエージェントの書出しを別の担当が読む往復、サーバー反映後の画面、実機器は未確認。設計と実装の記録は [設計書](../spec/server-scratch-cache-design-2026-11-07.md)（§15 に設計からの調整）。

## 何が一時ファイルになるか

| 時 | 内容 | 台帳の登録元 | 作り手の表示 |
| --- | --- | --- | --- |
| 発言の前 | 添付画像の元画像（BMP だけは正規化後の PNG/JPEG） | `attached` | 利用者が添付 |
| 発言の前 | 画像以外の添付ファイル（Markdown・テキスト・CSV・JSON・PDF・GLB） | `attached` | 利用者が添付 |
| 発言の前 | 2,000字を超える発言の本文。名前は「貼り付けた文章 HH:MM」。発言そのものは変えない | `attached` | 利用者が貼付 |
| 作業の中・後 | サブエージェントが `scratch.write` で書き出し、`finish.links` で返したもの | `work` | 担当の表示名 |
| 作業の後 | application の adapter が `ScratchStore.put`（origin `written`）で書き、結果に `eumenes://scratch/<uuid>` を入れたもの。同じ会話の項目だけが台帳に入る | `work` | 担当の表示名 |

画像以外の添付は会話モデルの入力に載せない。一時ファイルと台帳にだけ入り、担当へ渡して読ませる。

## 受け付ける種類と上限

| 種類 | MIME | 入口 |
| --- | --- | --- |
| 画像 | `image/jpeg`・`image/png`・`image/bmp`・`image/webp` | 添付画像 |
| 文書 | `text/markdown`・`text/plain`・`text/csv`・`application/json` | 添付、貼り付け、`scratch.write` |
| PDF | `application/pdf` | 添付 |
| 3D | `model/gltf-binary` | 添付 |

SVG・HTML・実行形式は 415 `scratch_type_unsupported` で断る。

| 項目 | 値 |
| --- | --- |
| 置き場所 | `<dataDir>/scratch/<bootId>/<uuid>`（`dataDir` は `EUMENES_DB` のディレクトリ、既定 `./data`）。ファイル名は uuid だけ |
| 索引 | メモリーだけ。SQLite に書かない |
| 合計 | 2 GiB。超える前に古い順に 1.5 GiB まで消す |
| ディスクの空き | 5 GiB 未満なら合計の超過と同じに扱う |
| 1件 | 100 MiB（`scratch.write` は 1 MiB） |
| 件数 | 2,000件 |
| 名前 | 先頭120字（制御文字を除く） |
| 同じ内容 | 同じ会話・同じ sha256 は同じ項目を返す |
| 同時アップロード | 2件まで。超えると 429 `scratch_busy` |

## 掃除と貸出

| 規則 | 内容 |
| --- | --- |
| 消す順 | 最終使用時刻の古い順。`resource.read`・`refs` での引渡し・貸出・HTTP の取得で時刻を更新する（State への表示では更新しない） |
| 貸出 | 処理中のジョブ（3D の取込など）が借りている項目は消さない。30分で自動返却 |
| 入らない | 貸出中以外を全部消しても入らない書込みは、何も消さずに 507 `scratch_capacity` で断る |
| 起動 | lifecycle `scratch_start` で自分の `<bootId>` を作り、前回の残りを背景で消す（listen を待たせない） |
| 停止 | 自分の `<bootId>` を消す。消せなくても次の起動で消える |
| 消えた項目 | 台帳の行は残るが解決できないので、提示中・共有中・チップに出ない。読むと `item_not_found` |

## 会話エージェント（Router）から見える形

`## State` の「提示中」に今の発言の添付・貼り付けが、「共有中」にこの会話の一時ファイル（提示中に無いもの、最終使用の新しい順に6件）が出る。

```text
提示中:
- a7「IMG_2041.jpg」（利用者が添付、画像 1600×1200）
- a3「青緑のロボット」（直前の返事で示した）
共有中:
- a9「競合3社の価格表.md」（Web調査が作成、Markdown 8KB）
- a5「貼り付けた文章 13:58」（利用者が貼付、テキスト 6KB）
```

| 規則 | 内容 |
| --- | --- |
| 誰が読むか | Router の選択呼出しが `## State` 全体を読む。agency の発話側には時刻の行だけが入る |
| 渡す | 担当への引継ぎは、State に出た `a<n>` を最大8件 `refs` に付ける（選択が選んだときはそれ）。担当の `RESOURCES` 区画に URI と先頭が入る |
| 範囲 | 番号は会話ごと。別の会話の一時ファイルは指せない |
| 書く | 会話エージェントは書けない。書き出しは担当に頼む |
| 発話 | 番号・URI は読み上げない |

## サブエージェントから見える形

ホストが全担当に2つの道具を付ける（package が自分で同じ道具を持つときはその binding）。誘導型の Web 調査（guided）には付けない。`scratch.write` は会話の実行があるときだけ付く。どちらも「道具を使わずに終える」検査では数えない。

| 道具 | revision | 内容 |
| --- | --- | --- |
| `resource.read` | `tool:resource.read@3` | 渡された URI を読む。一時ファイルの文書は `offset`（UTF-8 のバイト位置）から 8KB を 600 token 以内で返す。1件の作業で8件（URI ごと）まで。同じ URI はページを送っても最新の1ページだけを残し、件数を増やさない |
| `scratch.write` | `tool:scratch.write@1` | 文書を一時ファイルに書き出す。1件の作業で8回まで |

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
| `text` | 1 MiB 以内。超えると `scratch_too_large` |

会話へ返すときは `finish.links` に書く。書いた URI は「自分の道具が返した URI」として受け付けられ、台帳に `work` で入って次の回から `a<n>` になる。返さなかった書出しは、その作業の中だけで使える。

```json
{"action":"finish","summary":"3社の価格を表にしました","links":["eumenes://scratch/2c1d7a40-…"]}
```

`resource.read` の結果（文書）:

```text
一時ファイル「議事録_1107.md」（Markdown 24KB、位置 2400〜4800／全 24576）
…本文…
続き: offset 4800
```

画像・PDF・GLB は本文を返さず、名前・種類・大きさ・作り手・注記だけを返す。

## 添付画像を3Dにする

「これを3Dにして」で、3D担当（`toolchain:model3d.studio@3`）の snapshot の `images` の先頭に、この会話で添付した画像（origin `attached`）が入る（生成画像と合わせて5件）。

| 順 | 処理 |
| --- | --- |
| 1 | 担当が添付画像の `imageRef`（`eumenes://scratch/<uuid>`）を `sourceImageRef` に選ぶ |
| 2 | host が source `{type:"shared-image", id}` に変え、項目を貸し出す |
| 3 | 生成ジョブの最初の段（「元画像を保存中」）で WebP・長辺2000px以下に変換し、LARM 画像ライブラリへ取り込む（生成ごとに固定のキーで冪等） |
| 4 | 取り込んだ画像で既存の 3D 生成へ進み、貸出を返す |

取り込んだ画像は LARM 画像ライブラリに残る。段3の前に一時ファイルが消えていれば `model3d_image_not_found`、取込に失敗すれば `model3d_source_import_failed` で失敗にし、作り直さない。

## Web

| 項目 | 内容 |
| --- | --- |
| 添付 | 入力欄の添付メニュー「ファイルを選ぶ…（Markdown・PDFなど）」、または会話欄へのドラッグ＆ドロップ（画像以外は一時ファイル側へ振り分ける）。送信時にアップロードしてから `fileIds` 付きで発言を送る |
| チップ | 発言の下に一時ファイルのチップを出す（その発言の添付画像そのものは除く） |
| 開く | チップから会話欄のダイアログで開く。画像は表示、テキスト・Markdown・CSV・JSON はそのままの文字、ほかはダウンロード |

## API

| 経路 | 内容 |
| --- | --- |
| `POST /api/conversations/:id/scratch?requestId=<uuid>` | 添付ファイルのアップロード（multipart、欄 `file` の1件だけ）。`requestId` を項目の id にするので、再送は同じ項目を返す。201 で項目を返す |
| `GET /api/scratch/:id` | 項目（本文なし） |
| `GET /api/scratch/:id/content` | 本体。`X-Content-Type-Options: nosniff`・CSP sandbox。画像と `text/*` 以外は `Content-Disposition: attachment` |

発言の送信（`POST /api/runs`）は `fileIds`（最大8件）で、利用者が添付したこの会話の項目だけを受ける。client は `client/scratch.ts`（`uploadScratchFile`・`scratchItem`・`scratchContent`）。

| エラー | HTTP |
| --- | --- |
| `scratch_type_unsupported` | 415 |
| `scratch_too_large` | 413 |
| `scratch_capacity` | 507 |
| `scratch_busy` | 429 |
| `invalid_scratch_input`・`scratch_name_invalid`・`scratch_empty` | 400 |
| `item_not_found` | 404 |

## ログ

件数と大きさだけを出す。ファイル名・本文・会話 id は出さない。

| event | 欄 |
| --- | --- |
| `scratch.evicted` | `reason`・`count`・`bytes` |
| `scratch.sweep_failed` | 前回ディレクトリの削除の失敗 |
| `scratch.attachment_failed` | 添付画像を一時ファイルにできなかった（発言の受付は続ける） |

```json
{"level":"info","component":"scratch","event":"scratch.evicted","reason":"capacity","count":42,"bytes":523190272}
```

## 置き場所と確認

| 層 | 場所 |
| --- | --- |
| domain | `api/domains/scratch/`（store・describe・resource-adapter・controller） |
| 添付・貼り付け・書出し・3Dの取込の接続 | `api/application/scratch/` |
| 台帳 `attached`・State の提示中／共有中 | `api/domains/dialogue/service/shared-files.ts`・`state-text.ts` |
| ホストの道具 | `api/domains/agent-runtime/service/host-tools.ts`・`resource-access.ts`、定義は `api/domains/capabilities/builtin/resource-read.ts` |
| 3D の元画像 | `api/application/media/model3d-adapter.ts`、`api/domains/model3d/service/handlers.ts` |
| Web | `web/src/workspace/useChatFiles.ts`・`ChatImageInput.tsx`・`ScratchViewer.tsx`・`chat-send.ts` |

```sh
bun run verify -- --domain scratch
bun test api/domains/scratch api/application/scratch api/domains/dialogue/test/shared-files.test.ts api/domains/agent-runtime/test/host-tools.test.ts
bunx vitest run web/src/workspace/ScratchViewer.test.tsx web/src/workspace/ChatImageInput.test.tsx
```

対象外: 再起動・会話をまたぐ保持、会話エージェント自身の書出し、一時ファイルの画像の画素をサブエージェントへ入れること、PDF の Markdown 化（Docling の既存経路）。
