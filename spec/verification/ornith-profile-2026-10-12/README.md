# Ornith基本Profile・接続処理の変更と検証

実施日: 2026-10-12。変更対象はEumenesの初期Profile、共通LARM接続、推論の主/補助接続指定、関連試験・説明。保存済み接続URL・audience・認証方式・明示Profileは維持した。LARMの製品設定・ランタイム・他consumerの接続は変更していない。

## 目的と完了条件

新規・Profile未指定時に `ornith1.5Strix` を選び、保存済み選択を保持する。主256K × 1と補助64K × 最大3を独立したConnectionで使用し、5つ目はLARMの待機を追跡してready前にclaim・推論しない。既存のrenew・再claim・解放・再接続を再利用し、補助は終了時に解放する。Gemma4は選択できるまま維持する。

既存の設定schema・保存処理、catalog/claim、Provider adapterと推論control契約を確認し、それらを再利用した。意味判断・LLM指示は変更していない。追加したProfile名による分岐は、利用者指定の接続構成と公開catalog契約の検証だけを担う。

[LARMの全体コンセプト](https://chatgpt.com/space/page_9fab9c53bce8819181c9c8256a3b303a)の「必要なProvider subsetだけを要求」「202では同じConnectionを追跡」「資源調停・起動はLARMの責務」に従う。不要なProviderの先行予約、手動のモデル起動、他consumerの接続解放はしない。

## 実装

- settingsの初期値、保存文書のProfile欠落時、LARM portのProfile欠落・空文字時をOrnithへ変更。初回の明示的な環境変数指定と保存済みProfileは維持する。クライアントと設定入力は元から文字列を扱い、両Ornith名とGemma名を受理する試験を追加した。
- 通常の回答は主接続、既存の `mode=control` のLLM要求は独立した補助接続へ渡す。Ornith以外の明示Profileは従来経路を維持する。主接続での並行推論は順番に実行し、取消された待機要求が後続を追い越さない。
- 補助は主接続を保持したうえで `ornith1.5Strix-64k` を要求し、終了・取消・親のcloseで解放する。LARMが最大4枠を調停する。追加要求は同じ待機Connectionを、呼出元の期限・取消とLARMの終端状態に従って追跡する。
- Profileと `catalogRevision` を `/v3/agent-profiles` から取得し、作成時に `expectedCatalogRevision` を送る。modelと256K/64Kの契約、catalogとclaimのcontext一致を検査する。
- Provider接続先・モデル・資格情報はclaimから取得する。返されたendpointをbaseURL/daemonURLと照合し、初回とrenew後の接続に使う。日英TTS、Ruri両Provider、embeddingは選択Profileを読む既存処理を再利用する。
- 各portと補助要求に固有のclient識別子を与える。同じportのrenew・再接続では維持する。これは実接続で、同じclient/profileの並行作成が同じConnectionを返した再現結果に基づく。固定fixtureもこの再利用を再現し、独立した4つの識別子を検査する。

## 検証結果

部分試験→domainの結合検証→公開LARMへの実接続の順で実施。全体ゲートの結果は別に示す。

| 検証 | 結果・証拠 |
| --- | --- |
| 着手時LARM baseline | 108 pass / 0 fail。[baseline-larm.txt](baseline-larm.txt) |
| LARM domain | 112 pass / 0 fail。format・lint・型検査も通過。[verify-larm.txt](verify-larm.txt) |
| settings domain | backend 22、Web 33試験が成功。新規・欠落Profile、初回の明示指定、保存済みGemma/Ornith選択の再読込みを確認。[verify-settings.txt](verify-settings.txt) |
| inference domain | 62 pass / 0 fail。主/補助roleを既存の回答/control経路が渡すことを確認。[verify-inference.txt](verify-inference.txt) |
| clientと設定入力 | 93試験が成功。Ornith両名とGemma名の受理・維持を確認。[client-web.txt](client-web.txt) |
| 全体型検査 | 成功。[typecheck.txt](typecheck.txt) |
| 実接続 | 下表の全項目成功。[live.json](live.json) |
| verify:all | 担当外の既存 `web/src/App.tsx` のサイズ上限超過で最初のゲートが失敗。後続の全体試験は未実行。[verify-all.txt](verify-all.txt) |

| 実接続で確認した項目 | 結果 |
| --- | --- |
| 主1＋補助3の独立Connection | 成功。主1件と補助3件のreadyを確認した後、4要求を一緒に送信 |
| 応答モデル | 全5応答が `ornith-1.5-strix-lean` |
| 履歴分離 | 合成した独立履歴にそれぞれ異なる長い識別子を置き、全5応答が自分の識別子を完全に含み、他の識別子を含まないことを確認。全応答が `finish_reason=stop` |
| 5つ目の待機 | `pending / waiting-capacity` 中は推論0件。先行する補助1件の終了・DELETE後にreadyとなり応答 |
| 解放 | 主/補助・音声への切替・embeddingの計7接続をすべて解放し、DELETEの成功または終端応答を確認 |
| ASR | `granite-speech-4.1-2b` のclaimと無音WAVの通信が成功。無音は空の認識結果を許容する契約 |
| 日本語TTS | `voicevox-core`。WAV 79,404 bytes取得 |
| 英語TTS | `kitten-tts-nano-0.8-fp32`。WAV 170,044 bytes取得 |
| Ruri文章言語 | 日本語・英語をそれぞれ正しく分類し、対応TTSへ送信 |
| Ruri態度 | `ruri-v3-30m-speaking-attitude` のclaimと6択判定が成功 |
| embedding | Profileの `intfloat/multilingual-e5-small` 空間で384次元の結果を取得 |
| 保存済み設定 | backendの読み取り専用操作で取得し、検証前後の一致を確認。実接続検証だけProfileを指定し、製品設定は書き換えていない |

renewとtokenの再claim、公開接続確認からの再接続、待機取消・親closeによる補助回収は固定試験で確認した。実接続で900秒のTTL満了を待つrenew試験は実施していない。音声の取得はスピーカー・マイクを使う3往復の実機器受入ではない。

## 調査時の観測と修正

最初の主接続の全Provider要求は待機となった。必要なsubsetを要求し、同じConnectionを追跡すると `deploying → ready` が約5.7秒で成立した。待機だけを根拠に利用者へ枠を空ける依頼をしたのは誤りであり、コンセプトと公開状態を確認して修正した。

初回の補助3件は同じclient名により1件のConnectionへ再利用された。固有識別子で解決した。接続の独立性を判定する前に推論を始めない検証だったため、この初回は4セッション成功には数えていない。[live-initial-client-reuse.json](live-initial-client-reuse.json)

最初の履歴試験は128token上限で長い識別子の完全一致が成立しなかった。出力上限を1024へ増やし、同じ長い識別子の履歴形式・完全一致と他識別子の不在という期待値を維持して再検証し、全5件が成功した。製品の出力上限4096は変更していない。Ruriの確認用runnerも既存契約の `current_chunk` と `claimed_model` に修正した。これらは製品側の意味判断・固定応答による修正ではない。

## 差分点検と残る制約

利用者の語句・個別の会話・分類結果に応じた製品分岐や固定応答は追加していない。新ライブラリ、DB migration、認証方式変更、LLMへの指示変更、他domainの修正はない。着手時から多数の未コミット差分があり、本件と無関係な既存差分は保持した。

全体ゲートを止めた `web/src/App.tsx` は着手時から変更済みで、本件では編集していない。814行と `Workspace` 624行（既存budget 606）の超過を報告し、budgetやテスト期待値を緩めて通していない。対象domain・全体型検査・実接続の成功と、全体ゲート未通過を区別する。

再確認: `bun scripts/ornith-profile-live.ts --run`。保存済みの接続先とbackend認証を使い、検証で作った接続だけを解放する。会話本文、音声、token、保存済み設定を結果JSONへ書かない。

ContextStill: `context_compile` 1回、`compile_eval` 1回（run `00000000-0000-0000-18dd-c5924b6099de`、評価保存済み）。
