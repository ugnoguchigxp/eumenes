# 英語声の固定対応と設定欄の撤去

最新の全体検証: 既存のMusicCreationForm試験の型エラー6件は、ユーザー依頼により修正済み。型検査・全単体試験・buildを通過したが、browser fixtureで3件失敗したため全体gateは未合格。同じ3件の単独再試験は成功。詳細は [型エラー修正と再検証](music-type-error-fix.md)。以下の全体gate欄は固定対応実装時点の記録。

2026-10-12。ユーザーの指定により、日英の声の対応と英語速度を固定した。日本語のキャラクター選択だけで英語声が連動する。

| 日本語のキャラクター | 英語の声 | 英語速度 |
| --- | --- | --- |
| 四国めたん / ずんだもん / 春日部つむぎ / 雨晴はう | Rosie | 1.0 |
| 玄野武宏 / 剣崎雌雄 | Jasper | 1.0 |

対応は個々の日本語声名の推測や辞書で分類せず、LARM公開catalogの `voice_presentation=feminine|androgynous|masculine` を使用する。Rosie / JasperのIDと速度1.0はユーザーが指定した外部TTSの固定パラメータ。意味・意図判断は追加していない。対象声が未公開、種類が不明・不一致なら別の声に推測転送せず失敗する。Provider単位の既存catalog保持を再利用し、句ごとの初期化・追加LLM呼出しはない。

英語の設定値は合成処理から削除し、英語では常に固定対応を使う。旧保存文書の `englishVoice` / `englishMasculineVoice` / `englishSpeed` は読取り互換用に残すが、実行には反映しない。旧設定値を渡しても男性はJasper・速度1になる回帰試験を含む。日本語の音声・速度・スタイル等は従来設定を維持する。

Webの「日本語と英語の読み上げ」設定ブロックを撤去した。分類有効化・言語判定Provider選択・英語声・男性英語声・英語速度・再取得のUIは残さない。backendの公開接続確認APIと、通常環境の既存分類有効化は維持する。接続契約、Ruriの文章全体二分類、本文採用、取消と旧世代排除、前の再生終了を待つ順序制御は変更していない。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| LARM gate | 108件成功、失敗0。固定対応、既定声が違う場合、旧override無視、catalog保持、不明・不一致、取消、claim / 更新 / 旧epoch等 |
| settings gate | backend21件・Web30件、format・lint・型・境界・サイズ・入力hash一致まで成功 |
| inference gate | 61件成功、失敗0。設定snapshot・取消・採用経路を維持 |
| 通常環境の実接続 | 公開されている6名すべて、固定対応のKittenTTS合成・accepted=1。試験後の日本語声・style復元も成功 |
| 通常ブラウザ | 言語判定接続先、英語声、男性英語声、英語速度の各操作要素が0件 |
| 全体gate | 境界・サイズ・SQL・文書・format・lint・root型検査成功。backend等1626成功 / 1既存skip / 0失敗、Web305成功、client314成功。その後担当外のDesignSystem型検査で停止 |

実接続は `bun scripts/speech-voice-pair-live.ts --run`。通常backendのsettings APIで日本語声を一時的に順に選び、固定の自然な英語文をRuri経由で合成した。receiptの実合成model・speechVoice・採用を確認し、日本語設定を元に戻した。並行設定変更があれば復元で上書きしない。 [実接続記録](voice-pair-live.json)。速度1.0はfixtureの実HTTP payloadを検証しており、公開receiptが速度を返したという意味ではない。

全体gateの未解決箇所は既存の `packages/design-system/src/components/MusicWorkspace/MusicCreationForm.test.tsx` の `ByRoleOptions.exact` 型エラー（6箇所）。今回の範囲外なので変更していない。同じ既存失敗を追う再実行や期待値緩和はしない。実マイク3往復・実発話割込みの受入は別途。

通常backendを更新して固定版を起動済み。現在の日本語声は春日部つむぎ。自分の試験で作ったUI設定部品2ファイルと専用UI試験を撤去し、削除した操作が再出現しない確認を既存音声sectionの試験へ移した。最初の可変設定案のUI試験ではlabel伝播の不足が見つかり修正したが、最終版ではその部品自体を撤去した。

画面確認中の声一覧取得でLARM Controlの `/v1/audio/voices` が一度429になり、一覧取得失敗を表示した。時間をおいた明示再取得で6名のcatalogが復旧した。ユーザーが操作しているタブは変更せず、確認用タブで最終画面を保存した。[設定欄削除後の画面](fixed-voice-settings.png)。この一時的な外部制限について製品コードは変更していない。

ContextStillは今回compile/eval各1回、会話累計各10回。runId `00000000-0000-0000-18dd-c2c1ca7a2cf7`。評価文のWeb件数309は誤記で、上表の実行ログの305が正本。
