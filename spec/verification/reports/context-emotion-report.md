# 回答全体の感情判定・2026-10-09

実装と開発用サーバーへの反映を完了。実会話の「それは素敵な由来ですね。」にLayaの親しみ判定を保存し、設定済みの名前「あみ」の横に🙂が表示されることを確認した。

## 現在の処理

回答全体と直近4発言を対象に一度判定する。返信内の感情表現と最新ユーザー発言で候補を絞り、候補と「通常」を実Layaに比較させる。親しみ・喜び・寄り添う・興味・驚きの5感情。引用・コード・定義文は除外し、候補なしは判定を省略して理由を記録する。nativeの選択確度0.6以上の結果だけ表示する。通常・不確実には絵文字を付けない。

回答と判定を同時に保存し、音声の各句と読み上げ直しで同じ結果を使う。TTSの有無によらず判定する。発話は完成した回答の採用まで待つ。テキストの逐次表示は維持する。長文はnativeの入力上限を守るため回答の先頭・末尾600文字以内、各発言120文字以内へまとめる。中央だけにある感情表現や、候補辞書にない言い回しは拾えないことがある。

旧motionだけのアイコンは表示しない。旧migrationは維持し、新しい回答計画を追加tableで保存する。取消後の結果と無関係なreplay句は採用しない。判定の出所・理由・時間をログへ残すが、会話本文・認証情報・Provider生応答は残さない。

## Fixture

- `context-emotion-all.log`: verify:all成功。backend201、Web55、browser12。型・境界・書式・lint・ビルド・最終入力hashも成功。
- `context-emotion-*-verify.log`: delivery、conversation、inference、dialogue、voice-dialogueの所有・利用側検証。
- `context-emotion-emoji-fixture.png`:名前横の喜び・親しみ、通常と旧sleepy非表示、再読込の確認。
- 3句への同じ判断IDの共有、音声なしの保存、native判断中の取消と遅着拒否を追加試験。

## Live Laya

初期の全6候補＋長い指示は48反復で21一致に留まった。短い指示と候補の根拠確認へ変更した。

| 評価 | 結果 | 記録 |
| --- | --- | --- |
| 調整用16例 | 15/16一致、感情10/11、通常誤付与0/5 | context-emotion-live-candidate-final.jsonl |
| 別14例・各3回（修正前） | 39/42一致、用語定義へ誤付与3回 | context-emotion-live-validation.jsonl |
| 定義除外後・同じ14例各3回 | 42/42一致、感情21/21、通常誤付与0/21 | context-emotion-live-validation-final.jsonl |
| 実会話replay | HTTP200、68652bytes、warmth・確度0.9682、agreeing | context-emotion-real-replay.jsonl |

14例の予想は最初の実行前に固定したが、誤判定を直した後は同じ例の再評価である。精度の一般化保証や独立した42例とは扱わない。調整用の「不安」の1例は低確度で表示しないまま残した。通常回答の即時省略も一致数に含むため、すべてがnative Layaの判定ではない。sourceとreasonで区別できる。最終native判断はおおむね数十〜百ms、実会話replayの判定は701msだった。

サーバー再起動後の独立clientによる調整用再評価は接続待ち30秒で停止し、成功扱いしない（context-emotion-live-development-final.stderr）。同じ稼働サーバーのreplayは成功した。稼働中のProfileを取り合って再接続を繰り返す検証は行わない。

Laya公開仕様参考: [公式リポジトリ](https://github.com/NandhaKishorM/laya)、[Agent reference](https://nandhakishorm.github.io/laya/reference/agent/)。nativeのJSON choiceとanswer_confidenceを採用する。文字列から仮の高確度や感情結果を作らない。

## 実画面・実機器

context-emotion-real-ui.pngは実会話APIと実Laya判定を使った画面。透過アバターはready・canvas1、名前横は「あみ🙂」、事実説明にはアイコンなし。開発用APIと画面を再起動済み。実TTSは合成まで確認し、ブラウザで音声を鳴らしていない。実マイク・ヘッドホンの3往復受入は未実施で、音声MVPの受入完了とはしない。

Context Still: context_compile1回 / compile_eval1回。
