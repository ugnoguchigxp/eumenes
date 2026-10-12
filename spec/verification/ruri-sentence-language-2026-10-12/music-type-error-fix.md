# 全体検証を停止していた音楽画面の型エラー修正

2026-10-12。ユーザーの明示依頼により、`packages/design-system/src/components/MusicWorkspace/MusicCreationForm.test.tsx` の6件のTS2769を修正した。

Testing Libraryの `getByRole` / `queryByRole` では `exact` は対応しているoptionではない。文字列の `name` は既存実装で完全一致になることを、ローカルの `@testing-library/dom` のrole queryとmatches実装で確認した。6箇所から未対応の `exact: true` だけを外し、名前、操作、期待値は維持した。製品コードやLLMへの指示には変更がない。

| 検証 | 結果 |
| --- | --- |
| 変更前のDesignSystem型検査 | TS2769を6件再現 |
| 変更後のDesignSystem型検査 | 成功 |
| 該当フォーム試験 | 4件成功 |
| DesignSystem全単体試験 | 1,109件成功、65ファイル |
| music domain gate | backend1件・Web13件。型・境界・サイズ・format・lint・入力hash一致まで成功 |
| 全体の静的検査・build | 境界・サイズ・SQL境界・domain文書・format・lint・root型・DesignSystem型・Web build成功 |
| 全体の単体試験 | backend等1,626成功 / 1既存skip / 0失敗、Web305成功、client314成功、DesignSystem1,109成功 |
| 全体のbrowser fixture | 41成功 / 3失敗 / 1既存skip。45件、約4.6分。全体gateは失敗であり、最終入力hash一致は未確認 |
| 失敗3件の単独再確認 | ソース・試験条件・期待値を変更せず、同じ3件すべて成功（約29.4秒） |

全体browserで失敗したのは `tests/browser/voice.spec.ts` の1051行の暫定ASR表示、1236行のサービス試験画面の楽曲音声表示、1279行の長い質問の送信。全体実行時は暫定認識欄が空、サービス試験画面がErrorBoundary表示、送信記録が空になった。fixture backendの相関ログも確認した。単独再実行で再現しなかったため、安定性の原因は未確定。型修正以外の製品変更、timeout延長、skip追加、期待値変更はしていない。

再確認: `bunx playwright test tests/browser/voice.spec.ts --grep 'partial ASR and text|settings playground exercises|a long question with a one-second pause'`。全体の一回の合格と、異なる実行での集計を混同しない。今回の型エラーは解消済みだが、全体gateが安定して通ったとは報告しない。日英音声の固定対応と稼働中アプリは保持した。

今回の変更は上記の試験ファイル6行のみ。formatterはDesignSystemがignore対象のため原書式を保持し、差分空白検査で問題なしを確認した。検証失敗を理由に担当外の音声入力・サービス試験画面へ修正範囲を広げていない。

ContextStillは今回compile/eval各1回、会話累計各11回。
