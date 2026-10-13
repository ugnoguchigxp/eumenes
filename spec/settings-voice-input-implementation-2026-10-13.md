# 音声と入力の設定アーティファクト

## 目的と範囲

既存の音声・入力設定を、登録済みのOpenUI settings-sectionと共同下書きへ接続する。旧設定画面は維持し、保存は既存のsettings apply APIに集約する。用途割当とクラウド送信許可はAIと接続の所有のままにする。

読み上げ・聞き取り・機器の3区分。TTS一覧の能力からスタイル・速度・高さ・抑揚を表示する。クラウドは現行OpenAI互換adapterの声ID・速度を編集する。英語の固定声・速度・言語判断器は編集しない。声一覧取得、試聴、機器確認は保存操作と分離し、終了・対象変更後の古い結果を採用しない。

## 共通機構と保存先

SettingsSectionの制御入力・区分・詳細欄・許可操作を拡張する。SettingsDraftHost、settingsArtifactRuntimeのsource/revision/receipt検証、既存voiceSampleとlarmVoices API、キャラクター変更操作を再利用する。新しいArtifact種別・SQL・音声生成API・意味判断分岐は追加しない。

既存settings_document(id=1).documentのvoice、general.asrLanguages、larmの音声項目、resources[id]のvoice/speedへ保存する。機器一覧・試聴状態・選択中の区分・声検索・編集対象の登録モデルは一時状態で保存しない。秘密はsourceへ出さない。

## 作業と完了条件

1. 汎用入力・区分・操作をDesignSystem/OpenUIに追加。
2. 所有domainの登録項目・動的能力・カタログ・試聴・機器確認を接続。
3. 変更一覧、旧画面との共同下書き、閉じても残る編集を確認。
4. 部分試験→settings/artifact結合→ブラウザの実保存・再読込・狭幅を確認。横断検証の失敗は担当内外を区別する。
5. 差分と実装状況を設計資料へ反映。

実サービスと実機器の音声受入は別検証とする。設定移行の試験を音声MVPの3往復受入と扱わない。

## 現在地

音声と入力の実装・部分試験・結合試験・ブラウザ通し確認を完了。詳細は[検証記録](verification/settings-voice-input-2026-10-13/README.md)。全体gateは既存の担当外size-budgetで停止。旧設定画面の削除とほかのフォームの移行は後続。
