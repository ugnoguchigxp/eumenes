# Live2Dの後ろに保存画像を敷く（2026-11-23）

状態: 利用者が合意（2026-11-23）。実装済み・fixture検証済み。最初の画像の設定と実画面の確認はbackend再起動後（末尾の「実装・検証結果」）。

## 目的

桃瀬ひより（Live2D）の後ろに、画像一覧の保存画像を背景として表示する。最初に使う画像は「桜並木が見える書斎」（1024×1024 WebP）。

利用者の決定（2026-11-23）:

| 項目 | 決定 |
| --- | --- |
| 背景の対象 | Live2D背景の、キャラクターの後ろの絵 |
| 画像の持ち方 | 保存画像から選ぶ。画像IDは設定（SQLite）に保存し、コード・ファイル名に書かない |

## 現状

| 項目 | 現状 |
| --- | --- |
| 描画 | `.hiyori-avatar-background`（div）のCSS背景の上に、透過のWebGL canvasでモデルを描く |
| 背景の選択肢 | 既定のグラデーション、または「モデルの表示調整」→「背景」欄の背景色（`#rrggbb`） |
| 背景色の保存 | ブラウザーのlocalStorage（`eumenes.avatar.live2d-hiyori.background.v1`） |
| 画像の取得 | `GET /api/images/:id/content`（同一originの認証proxy）。一覧は `GET /api/images/library` |
| 画像の選択部品 | DesignSystemの `ImagePicker`（会話の画像添付・3D生成で使用中） |

## 変更内容

### 画面

「チャットを隠す」→「モデルの表示調整」→「背景」欄の構成:

| 部品 | 動作 |
| --- | --- |
| 背景色（既存） | 変更なし |
| 「画像を選ぶ」（新規） | 「画像一覧から背景を選ぶ」ダイアログを開く。`ImagePicker` を保存画像のみ・1枚選択で表示し、「この画像を使う」で確定する |
| 「画像を外す」（新規） | 画像を選択中だけ有効。画像を外し、背景色または既定の背景へ戻す |
| 「既定の背景」（既存） | 背景色と画像の両方を外す。どちらも未設定のときは無効 |

### 表示規則

| 状態 | 表示 |
| --- | --- |
| 画像あり | 画像を領域いっぱいに中央基準で拡大表示（CSS `center / cover`、縦横比を維持、はみ出しは切る）。その下に背景色または既定のグラデーションを重ねておく |
| 画像なし・背景色あり | 背景色（現状どおり） |
| どちらもなし | 既定のグラデーション（現状どおり） |
| 画像を取得できない（LARMで削除済み・通信失敗） | 下に重ねた背景色・グラデーションがそのまま見える。設定値は消さない。新しい判定や代替処理は足さない |

- 正方形の画像を横長の画面に敷くと上下が切れる。画像の位置調整・ぼかし・暗さの調整は今回追加しない。
- モデルの色調・構図・「上半身」・「リセット」・口パク・表情には影響しない。画像はcanvasの外のCSS背景で、WebGLのtextureや描画ループは増やさない。
- 光の妖精・Spatialの背景は変えない。会話の背景の種類（3種）も増やさない。
- 著作権表示は画像の上でも読めるよう、既存の文字影のまま表示する。

### 保存

| 値 | 保存先 | 形 |
| --- | --- | --- |
| 画像ID（新規） | 設定（SQLite）`general.avatarBackdropImageId` | `string`（1〜128文字、英数字・`_`・`-`）または `null`。既定 `null` |
| 背景色（既存） | ブラウザーのlocalStorage | 変更なし |

- 画像IDの保存は既存の設定API（`applySettings`、`expectedRevision` 付き）を使う。会話の背景を切り替える `useBackground` と同じ経路。
- 画像IDは設定に入るため、別の端末・ブラウザーでも同じ画像になる。背景色は従来どおりブラウザーごと。
- 設定画面（`settings.display`）には項目を足さない。操作は「モデルの表示調整」だけに置く。
- 旧設定（値なし）は `null` として読む。マイグレーションは不要（設定JSONの任意項目の追加）。

### 変更するファイル

| 層 | ファイル | 内容 |
| --- | --- | --- |
| settings契約 | `api/domains/settings/contracts/index.ts` | `general.avatarBackdropImageId` を追加 |
| settings試験 | `api/domains/settings/test/settings.test.ts` | 既定 `null`、形式違反の拒否、保存と再読込み |
| Web設定 | `web/src/domains/settings/index.tsx` | `useAvatarBackdrop(client)`（選択中のID、保存、解除） |
| 背景 | `web/src/components/domains/conversation/HiyoriAvatarBackground.tsx`、`hiyori-avatar.css` | 画像URLをCSS背景へ重ねる |
| 操作 | `web/src/components/domains/conversation/HiyoriViewControls.tsx` | 「画像を選ぶ」「画像を外す」とダイアログ |
| 接続 | `web/src/components/ConversationBackground.tsx`、`web/src/workspace/ConversationPanel.tsx` | client・画像一覧・保存操作をLive2D背景へ渡す |
| 文書 | `docs/avatar.md` | 操作と保存先を追記（`README.md` の機能表にアバターの行はないため追加しない） |

`api/domains/settings/` の3ファイルには別作業の未コミット変更がある。そこへ今回の項目だけを足す。

## 最初の画像の設定

実装後、backendが新しい契約で動いている状態で、設定APIから `general.avatarBackdropImageId` に「桜並木が見える書斎」の保存画像ID（画像生成の履歴 `GET /api/images/generations` の `artifactId`）を保存する。IDは設定にだけ入れ、コード・試験・文書には書かない。backendの再起動は利用者が行う。

## 検証

| 種別 | 内容 |
| --- | --- |
| 部分試験 | 設定契約（既定・形式・保存）、背景の重ね順（画像＞背景色＞既定）、選択・解除・「既定の背景」、画像なしのときの既存表示 |
| domain | `bun run verify -- --domain settings --domain avatar --domain conversation` |
| ブラウザー | `tests/browser/avatar-view.spec.ts` に、選択→表示→再読込み後の復元→解除、画像取得失敗時の既存背景を追加（消音、route fixture、サーバー起動なし） |
| 実画面 | 利用者の画面で桜並木の書斎がモデルの後ろに出ることの確認は、再起動後に利用者が行う |

## 対象外

- 画像の位置・拡大率・ぼかし・明るさの調整
- 光の妖精・Spatialへの画像背景
- 画像のリポジトリ同梱、LARMで削除された画像の複製保持
- 会話からの背景変更（LLMのツール追加）

## 実装・検証結果（2026-11-23）

| 種別 | 結果 |
| --- | --- |
| 実装 | 変更するファイルの表のとおり。加えて画像選択ダイアログ `web/src/workspace/AvatarBackdropPicker.tsx`、型の固定データ `client/test/settings-tasks.test.ts`。設定の保存は `useBackground` と共通の処理にまとめた |
| 型検査 | `bun check` 成功（3,493ファイル） |
| domain | `bun run verify -- --domain settings --domain avatar --domain conversation` 成功（backend 248件成功・2件skip、Web 144件成功） |
| ブラウザー（fixture） | `bun x playwright test tests/browser/avatar-view.spec.ts` 4件成功。実WebGLのモデルの後ろを画像が覆うこと、取得失敗（404）で背景色が見えること、「画像を外す」「既定の背景」を確認。画像の選択はfixtureの代役で、画像一覧ダイアログと設定保存は部品・フック・設定契約の試験で確認 |
| live・実画面 | 未実施。backendの再起動後に、設定APIで最初の画像を保存し、利用者の画面で確認する |
