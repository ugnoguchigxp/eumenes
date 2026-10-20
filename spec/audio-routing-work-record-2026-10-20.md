# 音楽・ボーカル・効果音のLARM連携

## 目的・範囲・完了条件

利用者の2026-10-20の依頼に従い、既存のmusic担当・共通ジョブ・MusicWorkspaceを使って3用途を送信し、効果音も同じ音声アーティファクトで再生・保存する。用途の解釈はLLM、明示選択はフォーム、API契約・上限検証はコード、実行モデルの振り分けと起動停止はLARMが担う。SAAA、認証、DBスキーマ、サーバー操作は対象外。着手時のspec/README.mdとcompute設計の未コミット差分には触れない。

外部仕様の正本は [local-LLM-harnessの指定コミット](https://github.com/ugnoguchigxp/local-LLM-harness/tree/d570d69e85bd0f6029b60e336cdc1e76a3033800)（ブランチ `codex/stable-audio-provider`）。依頼に挙げられた仕様HTML、coreのmusic.ts・music-routing.ts、daemonのroutes/music.ts、agent-connections.yamlの5ファイルを確認した。通常のmodelはauto、要求taskはmusic/sound-effect。modelsのtask=vocalsはモデル情報の分類であり、要求taskではない。

## 接続・実施順

1. LARMの入力契約・providers/models読取り・音声結果のruntime/長さを既存gatewayへ接続。長さを補完・短縮せず、modelsから上限を検証する。
2. 公開済みV1/V2を保持し、bundleでmusic.create@3・music.generate@3と担当手順を追加。既存music planner/generatorを再利用する。既存の専用music実行方式の移行は今回行わない。
3. MusicWorkspaceの3用途選択、小数秒入力、用途別上限・既定値表示、効果音の詳細表示を既存OpenUI source/actionsへ接続。表示JSONに音声URLや秘密を保存しない。
4. 部分→結合→music/larm/capabilities/artifactと利用側domainのverify。生成POST一度、全状態、400、取消、旧保存結果の回帰を確認する。
5. 保存済み接続のread-only APIでlive可否を確認し、可能なら短い3用途を一度ずつ生成・デコードする。サーバーの起動・停止・再起動は行わない。実スピーカー聴取は別に報告する。

完了条件は3用途の構造化要求、歌詞混入・矛盾拒否、用途別長さ・省略の維持、model/runtimeの保存、待機中POST再送なし、失敗・取消を成功扱いしないこと、既存再生・保存・タグ・お気に入り・検索の回帰確認。

## 基準と残作業

変更前のmusic-versions / music-e2e / music serviceの28試験は成功。実装、対象内の部分・結合・domain検証、実LARMの3用途とブラウザ再生、最終差分点検は完了。Artifact全体gateと実機器聴取の制約は後述し、全体合格とは扱わない。


## 実装した接続と変更理由

| 接続 | 登録と実装 |
| --- | --- |
| 会話→担当 | function `music` → `toolchain:music.create@2` → `package:music.create@3`。bundleに新しい用途の説明・例を登録 |
| 担当→計画 | `profile:music.create@2`、`skill:music.create@3`、`tool:music.generate@3`、新契約 `musicPlanV3`。元依頼と現在のProviderモデル情報を担当へ渡す |
| 計画→実行 | 既存music domainの `music.plan` → `music.generate`。既存queueの `maxAttempts:1`、同runの重複防止、受付ID保存を維持 |
| 実行→結果 | LARM gatewayの共通music経路。model=auto、構造化task/instrumental/lyrics、用途別maxの検査、長さ省略の保持。jobIdを照会し同じジョブをDELETEで取り消す |
| 結果→Artifact | `artifact:music.generation@3` → 登録済み `adapter:music-screen@1` と `query:music-screen.list@1` → 既存MusicWorkspace。`schema:music-screen-generate@2` の文字列フィールド内にJSONで明示選択を保持 |

- 新定義は `api/domains/capabilities/bundles/music-routing.bundle.json`、画面新版は `music-screen.bundle.json`。公開済みのV1/V2の定義・本文・schemaは変更していない。旧版seed後の追加と繰り返しseedを確認した。既存の非同期music実行方式を、別のcommand/session方式へ移行する設計変更は行っていない。bundleの生成画面は既存登録adapterを使う。
- LARMの契約・送信は `api/domains/larm/contracts/music-generation.ts`、`service/music-request.ts`、`service/playground.ts`。GET providersのid/modelsを取り込み、Providerやモデル名に固定依存しない。`task=vocals` は送信しない。入力の歌詞混在・未知オプション・品質・形式・参照音源指定を拒否する。通常のPOSTは一度だけ。
- `api/domains/music/service/handlers.ts` と `contracts/index.ts` はtask、実モデル、Runtime、実際のdurationを保存する。Providerからのcancelledも取消状態として保存し、音声を公開しない。音声コピーの上限は、600秒のstereo/48kHz/32-bit PCMとコンテナヘッダーを収める256MiBへ調整し、gateway読取りと保存側を揃えた。上限超過は失敗であり、音声の切詰めはしない。長尺WAVの実生成は未実施。
- `GET /api/music/providers` と `client/music.ts` で、既存認証のまま用途別情報をWebへ渡す。接続先は既存settings domainの読み取り専用操作を使用し、接続設定・秘密・製品DBをコピーしていない。
- DesignSystemのMusicCreationFormで歌なし音楽／ボーカル／効果音を選ぶ。長さは小数入力、未指定は用途別既定値、用途切替時にも入力値を短縮しない。効果音では音楽用の選択と歌詞欄を隠し、保持中の歌詞も送信しない。歌詞は自由記述promptへ重複させず構造化選択へ保持し、合計容量を検査する。
- `packages/artifact-ui/src/media-components.tsx` とWebの `creation-selection.ts`／`use-music-creation.ts`／`use-music-runtime.ts` で既存イベントと会話APIに接続した。音声URLは既存ホストが解決し、詳細には効果音・小数秒・実モデル・Runtimeを表示する。ライブラリの選択曲にも保存済み生成レコードのtask/runtimeを既存の生成参照で引き継ぐ。旧保存結果は追加フィールドがなくても読める。

## 固定試験・画面確認

結果の詳細ログは [検証ログ](../verification-reports/music-routing-2026-10-20/) に保存。

| 段階 | 入力・対象 | 結果 |
| --- | --- | --- |
| 基準 | music-versions / music-e2e / music service | 28成功 |
| 契約・外部API | 3用途、小数秒、用途別max、長さ省略、歌詞混在、形式・品質・オプション、新Provider/model/runtime、HTTP400、全7状態、遅れた202後のDELETE | `larm/test/music-generation.test.ts` の11件成功（domain検証にも含む） |
| 版互換 | 旧版seed、bundle新版、繰り返しseed、旧schema不変、新schema | 3件成功（domain検証にも含む） |
| 部品 | 歌なし・ボーカル・効果音、非表示歌詞の除外、1.5秒、180.5秒から歌なしへ切替えて拒否・値保持、既存Workspace | 13件成功 |
| 会話・API結合 | `music-audio-routing` / `music-e2e` / `music-library` / `music-routing` / `music-screen-adapter` の5ファイル | 26件成功。生成・音声取得・保存・検索・タグAND・お気に入り・Range・取消・旧版表示を確認 |
| Domain | `bun run verify -- --domain music --domain larm --domain capabilities --domain dialogue` | 成功。backend 790件、Web 39件、型・境界・format・lint・DesignSystem build成功。入力変更・dist変更の整合性エラーなし |
| 登録 | 両bundleのcheck | issueなし |
| Artifact画面 | 実際の登録V3 JSONをArtifactRendererで描画。PC/390px、用途・1.5秒・歌詞非混入のイベント・詳細。HTTP要求をfixtureで満たしサーバーを起動しない | 成功、pageerror 0。 [画面とイベント](../verification-reports/music-routing-ui/) |

最終domain記録：[report.json](../verification-reports/runs/2026-10-20T07-13-19-823Z-d2d73325-829a-4b57-bcd2-1e73a9c84104/report.json)。

## 実LARM確認（各用途一回、再送なし）

2026-10-20、保存済み接続のGET providersから新Providerと3モデルのtask/default/maxを確認し、catalogのservice URL・descriptionを確認してから実行した。`scripts/music-routing-live.ts --run` はサーバーを起動せず、同じgatewayへ短い要求を一度ずつ渡す。通常ログへprompt・歌詞・秘密・Provider生応答を記録しない。

| 用途 | 要求秒数 | 音声の実測秒数 | 実モデル / Runtime | 結果 |
| --- | --- | --- | --- | --- |
| 歌なし音楽 | 5 | 5.0065 | stable-audio-3-small-music / stable-audio | 生成、Opusデコード、最後までのブラウザ再生成功 |
| ボーカル | 5 | 5.1265 | acestep-v15-turbo / music | 同上。歌詞をlyricsへ送信 |
| 効果音 | 1.5 | 1.5065 | stable-audio-3-small-sfx / stable-audio | 同上。歌詞なし |

実測値のわずかな差は返されたファイルの長さで、要求秒数をEumenesが変更したものではない。実モデル名はLARM応答からの記録であり、製品コード・設定・ファイル名へ固定していない。実行後、この検証が生成したLARM上の3音声だけを削除した。ローカル音声、jobId、phase列、実測、再生終了状態は [実接続結果](../verification-reports/music-routing-live/2026-10-20T07-06-57.051Z/results.json) に保存。実生成後の変更は型import・取消表示の整理・境界用re-export・音声容量上限の引上げであり、短い3要求の内容と実行手順は再試行していない。

## 未確認・担当外の検証不合格

- 実スピーカーでの聴取、実LLMによる依頼の用途選択・引数生成、600秒や各非Opus形式の実生成は未確認。実LLMを使わない固定モデルの会話結合と、実LARM gatewayの3生成を分けて記録する。音声MVPの実機器3往復受入を完了したとは扱わない。
- Artifactを含めたverifyは、今回未変更の `packages/artifact-ui/src/composition-fixer.ts`（827行）と `ui-studio-components.tsx`（974行）の既存行数超過で停止した。[不合格ログ](../verification-reports/music-routing-2026-10-20/artifact-gate.log)。全体gateやverify:allの合格は宣言しない。同じ停止条件があるverify:allを追加で繰り返していない。
- Artifact所有試験は別途実行し72成功・2失敗。`composition.test.tsx` の子13件拒否、`nested-layout.test.tsx` の深さ4上限の期待が現行契約と一致しない。現行契約は深さ6で、関連するcontracts/compiler/試験/行数超過ファイルがHEADから未変更であることを確認した。期待値や製品契約は変更していない。[試験ログ](../verification-reports/music-routing-2026-10-20/artifact.log)。今回の音楽・効果音画面自体は部品・Web・結合・実ブラウザ確認が成功している。
- 稼働中Eumenesのサーバー停止・起動・再起動、本番反映は行っていない。bundle新版の公開は通常の起動時登録を必要とする。commit/pushも未実施。

## 俯瞰評価・最終点検

版互換の失敗は、新フィールドを旧schemaの保存計画に混ぜたことを再現して修正し、旧契約のまま再読込みする形で解消。新版画面のfixture期待値も新しいrevisionと結果情報へ更新した。俯瞰評価では「同じ失敗の再試行」ではなく原因別の修正と確認へ進めると判断し、会話で通知した。

ブラウザ単独fixtureの初回失敗は、通常Viteが与えるprocess.envと、空ページで利用できないcrypto.randomUUIDが原因だった。製品コードの変更で回避せず、production相当の環境定義とlocalhostへのfixture応答へ条件を変更し成功した。実サーバーの起動は行っていない。正常なモデル起動待ちを停止・再起動していない。

最終差分は、着手時の担当外spec 2ファイルを保持し、対象内の変更だけを確認した。個別発話・特定のテーマの語句分岐、Provider名・モデル名による振り分け、LLMの意味判断を代替する処理は追加していない。task/instrumentalによるコードの検査は外部API契約の強制に限定する。`git diff --check` 成功。

context_compile 1回、compile_eval 1回。runId `00000000-0000-0000-18e0-2a4efddc5501` の評価を保存済み。
