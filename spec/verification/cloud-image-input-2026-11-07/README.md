# クラウド画像入力の検証

2026-11-07。[実装計画](../../cloud-image-input-implementation-plan-2026-11-07.md)。固定試験では製品DB・保存設定・稼働中のEumenesを変更せず、許可された試験用サーバー2本を起動・終了した。その後、稼働反映・実画像送信・必要な再起動の明示許可を得て、以下のlive受入も完了した。

## 固定試験

- 画像関連の最終10ファイル: **71成功、0失敗、397 assertions**。会話の受付からクラウドへの画像引渡しと回答保存、LARMの正式計数、Codexのnative画像入力・同じ接続での能力検査・画像非対応時の生成拒否、Claudeの認証ゲート、BMP変換を確認。
- Webの2ファイル: **8成功、0失敗**。cloud-onlyでLARM接続が呼ばれない、設定切替前の応答を採用しない、古いエラーの解除、不明な接続では画像をアップロードせず下書きを残す、文字だけの送信が可能であることを確認。
- `bun check`: 成功。`bun run build:web`: 成功。ビルドの既存chunk警告は残る。
- 変更した実装・試験ファイルを明示したlintは成功。通常の全体lintは別作業の未使用importで停止している。
- 広いbackend試験: **1,444成功、1失敗、214ファイル**。失敗は `api/domains/dialogue/test/specialist.test.ts` の `returning: unsaved work...`。今回の推論・LARM変更をHEAD版へ戻した比較用コピーでも、同じ期待値不一致を再現した。期待値や会話コードを変更していない。

証拠の集計と実装ファイルhashは [fixture-summary.json](fixture-summary.json)。合成画像だけを使い、画像本文・credential・製品設定のdumpは含めていない。

## ブラウザーと実アカウントの一覧

- ブラウザー4ケースすべて成功（50.2秒）。広幅・狭幅、paste/drop/選択、サムネイル解除と拡大、画像のみの送信、履歴の再読込、通常の添付操作による再添付、受付失敗時の保持、cloud-onlyでLARM接続要求0件を確認。[結果](browser-summary.json)、[狭幅の画像付き会話](chat-narrow.png)、[狭幅の入力欄](composer-390.png)。ブラウザーは消音した。
- 初回のブラウザー起動で、今回追加した契約schemaがLARMのサーバー用public entryを参照し、ブラウザーへAsyncLocalStorageを取り込む不具合を検出。`larm/contracts`だけを参照するよう修正し、型・ビルド・関連試験と4ケースを再確認した。最初の実行を成功件数に含めていない。
- 許可されたCodexの一覧取得だけを実行し、保存済み選択のLunaがcatalogに存在し、`inputModalities`が`text`と`image`であることを実アカウントで確認。[一覧確認の記録](codex-catalog.json)。モデルへの画像送信や推論は行っていない。
- 追加確認した既存の`client/larm.test.ts`は、204のmock応答をJSONとして読む箇所で失敗。clientもHEAD版へ戻した比較用コピーで同じ失敗を再現し、期待値・API契約は変更していない。

## 大きな画像の通信境界

Codexのapp-serverは入力を`userMessage`の開始・完了通知で返す。2 MiB超の有効なPNGを使い、この通知が従来の回答用1 MiB/行・4 MiB累計の上限に衝突する失敗を固定試験で再現した。

送信した要求の長さを基準に、同じthreadの入力確認通知だけを別枠で計数するよう修正した。1通知は送信要求のbytes＋4 KiBのframing、通知累計はその2倍まで。通常の回答・未知の通知は従来の上限を維持する。同じ大きな画像を送った場合にも、大きすぎる回答は拒否されることを確認した。画像を外す、縮める、出力上限を全体的に緩める処理は追加していない。この修正後の再実行が上記71件。

## gateの状態

通常の選択domain gateは、過去の検証コピーが試験一覧へ混入し、並行作業の変更も検知したため無効。製品データ・秘密を除いたソースコピーを作り、そこで続行した。

隔離環境では試験一覧・依存境界・SQL境界・domain文書の検査を通過した。今回追加した公開schemaの参照と関数規模は修正済み。残る停止理由は別作業の `browser-interact.bundle.json` の書式、`media/live-bridge.ts` の未使用import、`dialogue/work-ledger.ts` と `memory/forget.ts` の関数規模。隔離先の生成catalogの整合差も別に記録した。これらを避けるために規則や期待値を緩めていない。全体gate成功とは扱わない。

## 稼働環境のlive画像受入

**成功。** 07:50 JST、稼働WebからPNGを1枚添付して実モデルへ送信し、13.6秒で回答が保存された。保存済み設定revision 170のcloud-only経路を使い、接続・モデル・設定を変更していない。実行記録は `model=gpt-6-luna`、`source=cloud`、`billingPath=codex`、`status=succeeded`、`accepted=1`。runIdは `313780cb-414b-4393-a4e1-8f19ba5b0199`。

[送信画像](live-input.png)は960×640のPNG。送信文は色・形・個数・配置・英数字を尋ねるだけで、答えは含めなかった。ファイル名は `live-input.png`、保存された添付にannotationはない。採用された回答は次の内容で、画像とすべて一致した。

> 赤い円が3個あり、上段の左・中央・右にあります。青い正方形が2個あり、下段の左・中央にあります。緑の三角形が1個あり、下段の右にあります。画像の英数字は「R7K4」です。

稼働画面の再読込後も、画像1枚（960×640）と回答の表示を確認した。画面エラーは0件。検証ブラウザーは消音し、確認後に閉じた。API・Webはそれぞれ8787・5173で稼働を継続している。

証拠: [live-summary.json](live-summary.json)、[再読込結果](live-web-summary.json)、[添付した画面](live-web-input.png)、[回答の画面](live-web-answer.png)。これらは新規検証用の画像・入力・採用済み回答だけを含む。通常ログ・設定dump・credential・Provider生応答は含めない。先の `fixture-summary.json` と `codex-catalog.json` は各検証時点の記録として保持する。

起動時には、旧プロセスのDB終了処理が残る間の `database_writer_owned` と、`bun run dev` の30秒起動確認のtimeoutを観測した。旧所有者の終了を確認し、文書にあるAPI・Webの個別起動で復旧した。API健全性・画像能力・実画像認識・再読込確認はその後に成功した。起動のための製品コード変更やロックファイル削除は行っていない。起動時には並行作業分の既定migrationによる自動バックアップも記録されている。DBを直接開く手動操作は行っていない。

## 残る受入範囲

Claudeのsubscription一覧と一般のOpenAI互換HTTPは画像能力を確認できないため、実行経路の有効化を保留する。送信変換の固定試験を、実接続の対応確認に読み替えない。
