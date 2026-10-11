# 楽曲生成ツールチェーンのOpus対応

2026-10-11。今回は生成・完了音声取得・保存・返却のOpus対応に限定した。音楽再生プレイヤーのツールチェーン分離、ライブラリ、検索、タグ、お気に入り、Range中継は後続作業。

## 目的・範囲・完了条件

既存の会話 → `package:music.create@1` → 推論queue → 生成queue → LARM → musicの保存・認証API → OpenUI Artifactを再利用する。依存順は、配備契約の確認、出力指定・形式検査、保存拡張子、fixtureと確認スクリプト、部分・結合・domain・全体検証、実接続1曲と保存音声の確認、差分点検。着手時の作業フォルダに未コミット変更はなかった。

完了条件は、Opus指定で重複POSTせず、完了音声を再変換なしで保存・認証返却でき、不正形式を拒否し、既存形式と取消経路の回帰試験を通すこと。実確認で作成した曲だけを削除する。実機器の聴取・音楽的品質評価は対象外。

## 接続と実装

backendのsettings domainの読み取り専用操作で保存済みLARM設定を取得した。製品DBや秘密のコピー・設定変更は行っていない。配備先の `GET /openapi.json` と `GET /v3/agent-profiles?profile=SAAA-w-music` はともに200。`services` の `name=music` / `protocol=larm.music-generation.v1`、endpoint `/v1/music/generations`、model `ace-step-1.5`、Opus既定出力と `audio/ogg` を確認した。Control認証をbackendで使用し、musicのProvider claimは行わない。

- `playground.ts`: 生成POSTの `outputFormat` をMP3からOpusへ変更。形式を明示的にMIMEへ変換し、OpusをWAVへ落とさない。
- `playground-media.ts`: 既存の画像・音声の形式検査を移し、`audio/ogg` とOgg / Opus識別ヘッダー検査を追加。外部のバイナリ契約の検証に限定した専用処理であり、意味判断は追加していない。大きい既存関数をさらに伸ばさないために検査部分のみ分離した。
- musicの保存・API、LLM指示、入力schema、profile・skill・tool・packageの登録版はそのまま再利用。新しいDBスキーマ、再変換、生成再送は追加していない。
- Webの保存ファイル名へ `.opus` を追加。プレイヤー部品やOpenUI定義は変更していない。
- fixtureをデコード可能な30秒の無音Opusへ更新し、形式・認証・POST回数・完了段階・不正音声・既存MP3/WAV/FLACを確認。受入例固有の製品分岐は追加していない。
- `music-live.ts`: Opusのデコード確認、現在のプレイヤー要素の確認、完了した確認曲だけの削除を接続。
- `music-ui-check.ts --audio <保存済みファイル.opus>`: 再生成なしで既存Artifactの再生確認を行えるようにした。

## 検証結果

| 段階 | 結果 | 証拠 |
| --- | --- | --- |
| 変更前 | 対象3ファイルの20試験成功 | 作業中の基準測定 |
| 部分・結合 | 28試験成功。Opus指定・Control認証・POST1回・完了後取得・不正形式拒否・旧形式・失敗・取消・会話返却・音声API | [targeted.txt](targeted.txt) |
| LARM domain | 74試験、静的検査・型検査成功 | [verify-larm.txt](verify-larm.txt) |
| music domain | backend 1・Web 5、静的検査・型検査成功 | [verify-music.txt](verify-music.txt) |
| dialogue domain | backend 119・Web 6、静的検査・型検査成功 | [verify-dialogue.txt](verify-dialogue.txt) |
| 全体 | backend等1,479・Web294・client329・DesignSystem1,095・ブラウザ44成功。backend 1・ブラウザ1スキップ。静的検査・型・境界・build・検証入力同一性も成功 | [verify-all.json](verify-all.json)、[出力](verify-all.txt) |
| 実接続 | 実LLM選択・生成指示・POST1回・完了・認証取得・保存・会話返却・Opusデコード成功。最初のブラウザ確認は旧locatorで停止 | [live-events.json](live-events.json) |
| 保存音声でのブラウザ確認 | 再生進行・一時停止・シーク・前後10秒・選曲・保存拡張子成功。認証付き読取fixtureのみ、生成API呼出しなし | [replay-result.json](replay-result.json)、[画面](replay.png) |
| 実機器 | 未実施 | 依頼範囲外 |

全体検証は451,672 msで成功。検証入力hashは `c59afd86cc4faabfe26ff297c4515fde32e16a52bf3ac6c5a6a8d41921ef6838`。検証中はソースを編集せず、終了後に本記録・証拠・既存作業記録だけを追加した。

## 実接続の時系列と失敗分析

日本時間19:57:39に既存受入スクリプトの30秒楽曲依頼を送った。19:57:51に会話が `create_music` を選択し、19:57:56に楽曲担当の生成指示を採用。同時刻のPOSTはmodel `ace-step-1.5`、30秒、instrumental、Opus、balanced。受付jobIdは `music_368fe325-ee58-4f46-9fb6-89a8f81a0bea`、会話runIdは `401db6d9-0429-49e3-9fe1-ac094415c144`。同じjobIdを照会し、完了音声を取得・保存した。

19:58:34のデコード結果はcodec `opus`、48,000 Hz、ステレオ、30.006500秒。[保存音声](track.opus)は確認の証拠として残している。19:58:49のブラウザ待機は旧UIの `楽曲プレイヤー` とvisible条件で停止した。現行DesignSystemは `音楽プレイヤー` とカスタム操作を使い、audio要素は表示しないため、検証スクリプトを正しい名前・attached条件へ修正した。生成・音声取得の失敗ではない。

同時刻に今回のjobIdだけへ楽曲削除を行い204、詳細GETで404を確認した。既存曲への削除は行っていない。実生成の再試行は0回。修正後のliveスクリプト全体は再実行せず、取得済みの同じOpus音声を認証付き読取fixtureに渡してブラウザ受入を成功させた。画面の通知取得警告は既存の隔離fixtureで通知APIが未接続のためで、音楽再生は成功し、今回その領域は変更していない。

最初の全体検証は確認曲削除の `finally` 内のthrowを静的検査が拒否した。後片付けを捕捉付きの独立関数へ移し、静的検査・型検査後の2回目で全体成功した。要件・試験期待値は弱めていない。

## 残作業と差分点検

今回のOpus対応は実装・固定試験・実生成と保存音声のブラウザ確認済み。後続は音楽再生プレイヤーツールチェーンの分離と、その範囲として指定されたライブラリ・検索・タグ・お気に入り・Range再生などの統合。通信切断後の永続ジョブ復帰を含む追加要件も、その契約・範囲を整理してから扱う。

差分に、個別テーマ依存の分岐、LLMの意味判断を代替する処理、プレイヤーの新機能、担当外の修正は追加していない。`context_compile` 1回、`compile_eval` 1回。評価のrunIdは `00000000-0000-0000-18dd-7432476867e4`。
