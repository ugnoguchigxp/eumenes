# 追加サーバー用の準備コード削除：検証記録

2026-10-25。[削除範囲と判断](../../dots-no-relay-cleanup-2026-10-25.md)。独自relay・結果受取箱の常設計画は撤回した。稼働中のPCからdotsへ仕事を渡し、停止中の結果はChatGPTで確認する。起動後の自動回収は追加していない。

## 削除と互換性

- relay wire契約と専用試験、旧bundleの全体複製fixtureを削除。
- 未実装の起動時同期スイッチ、利用されない固定一択の受付担当設定、relayの可用性コールバック・固定状態・実行拒否条件・画面表示を削除。
- 受付/外部Skillから独自サーバー必須条件を除いた。native作業先のcloud/local区分、権限、作業期限、既存の報告と停止は維持する。
- dots/0006で不要な保存フィールドだけを削除。他の設定とrevisionは保持。旧キー名はこの移行と移行試験にだけ残す。
- 公開済み版を上書きしない。保存済み設定画面の競合をログの対象IDで特定し、新版を登録。登録失敗ログに対象IDと検証位置を加える最小限の補足も行った。

## 検証

件数には重複があり、合算してユニーク件数とはしない。

| 検証 | 結果と記録 |
| --- | --- |
| 対象の部分・結合 | 26件成功・130 assertions。[partial.log](partial.log) |
| 登録・保存・capability bundle | 22件成功。[registration.log](registration.log) |
| dots domain回帰 | Bun 64件・Web2件成功。[domain-tests.log](domain-tests.log) |
| 選択と遅い応答のWeb試験 | 1件成功。[web.log](web.log) |
| ブラウザ通し | 1件成功。仕事一覧、狭幅、結果、回答、取消、保存・reload、削除した設定の非表示を確認。[browser.log](browser.log) |
| bundle dry-run | issues=[]。[bundle.json](bundle.json) |
| 全体型検査 | 2,625ファイル成功。[typecheck.log](typecheck.log) |
| lint・format・境界 | 対象ファイル成功。[lint.log](lint.log)、[format-check.log](format-check.log)、[boundaries.json](boundaries.json) |
| 標準domain gate | 境界・SystemContextの後、既存の3ファイルの行数制限で停止。今回そのファイルは変更せず、上限も緩めていない。[domain-gate.log](domain-gate.log) |
| 実ローカル反映 | 通常の開発起動を復元。設定artifact@5と仕事artifact@3をAPIで取得。保存設定は6項目で、不要な2項目なし。受付は無効のまま。[local-api.json](local-api.json) |

画面: [仕事一覧](workspace-narrow-browser.png)、[設定](settings-before-save.png)。ブラウザは隔離した実backendと模擬Session/報告を使う。今回、実dotsの仕事は送信していない。PC停止中の実受入も行っていない。

全体gateの停止理由は `packages/artifact-ui/src/composition-fixer.ts` 827行、`contracts.ts` 859行、`ui-studio-components.tsx` 974行。DesignSystemの変更はない。標準gateはbuild前に停止したため、他作業の開発サーバーと共用distのビルドは重ねていない。独立したdomain試験と全体型検査を別途実行した。

差分では意味判断の語句分岐や個別依頼の固定応答を追加していない。他作業のコードは修正しない。途中に観測した他作業の型不整合は最終型検査では解消していた。追加のサービス契約・配備・課金は行っていない。
