# テスト環境移行 初回実装の検証記録

本書は初回実装時点の履歴。利用者の継続指示後の修正・検証・残課題は [継続の検証記録](continuation.md) を参照。

実施日：2026-10-15。基準HEAD：`2086a25baadbd78354672d085641cfc0b95858f8`。Bun 1.4.3、macOS arm64。製品コードや既存試験の期待値は変更していない。

## 実装・検証済み

- A：複数domain指定、所有パス・試験の重複排除、DS unitの実行、ブラウザなしacceptance 4本の追加、runner/project棚卸し。
- B：DS通常型検査→DS build→利用側型検査→試験、共有distの前後hash、実行別レポート、未実行・割り込み・無効化、CIの常時artifact保存。
- M：工程時間・結果の集計、60コミットの所有パス集計、全件合格時に限るjob分割の理論下限比較、CI準備時間の記録を追加。実CIでの費用比較と改善率の判定は未実施。

| 確認 | 結果 |
| --- | --- |
| 移行・計測・入力hashの回帰試験 | 13合格、0失敗。ビルド失敗後の停止、出力改変・欠落、入力変更、SIGTERM、レポート履歴を含む |
| ブラウザなしacceptance 4本 | 61合格、0失敗。runnerはfakeDriverを使用 |
| OCR＋Google Accountsのverify | 48 Bun＋2 Web＋4 DS試験合格。全工程19,571ms。前後の入力hash・dist hash一致 |
| test:domainの複数指定 | 同じ54試験合格 |
| 変更したスクリプトのformat/lint | 合格 |
| CI定義 | YAML解析・準備処理のshell構文・alwaysでの保存条件を確認。GitHub上の実行は未実施 |
| 全件verify | 変更前と同じ境界違反で停止。inventory合格、boundaries失敗、残りはnot_run |
| root型検査 | 未変更のブラウザ試験のTS2769で失敗。今回のスクリプトに型エラーなし |
| ブラウザ／live／実機器 | 今回の範囲外のため未実行 |

## 全件合格を妨げる既存事項

1. `api/application/google-accounts.test.ts` の `../domains/capabilities/bundles/settings-google.bundle.json` 参照が、applicationは公開入口を使うという境界規則に違反。変更前の全件検証でも同じ失敗を記録した。
2. `tests/browser/object-recognition.spec.ts:265` にTS2769。`ArrayBuffer | Iterable<number>` を `ArrayBuffer | ArrayLike<number>` に渡している。対象ファイルは未変更。

いずれも期待値や検査対象を弱めず、担当外として修正していない。全件レポート `2026-10-15T11-05-27-634Z-c0c6026c-a535-4261-9609-7e7308b1801f` の入力hashは前後一致している。合格と表現する範囲は上記の局所・選択検証まで。

## 計測の判断

全530試験ファイル中、通常検証506、ブラウザ24。Storybookは別に75 sourceから試験を生成するため、ファイル数と足し合わせて試験件数にはしない。OAuthの `.test.mjs` はBunの発見対象であり従来の全件範囲に残した。

直近60コミット（docs/specとMarkdown以外のtracked変更）ではコード変更52、所有パス内だけ2、単一domainだけ0。現行graphによる参考値であり、旧新graphを使ったaffected選択や速度改善率ではない。

比較可能な変更前・変更後の全件合格記録がないため、改善率もCI並列化効果も判定していない。Cのaffectedは見送り、DのsnapshotとCI job分割も未導入。まず既存の全件失敗を別途解消し、同じ必須範囲・OS・runtimeで合格サンプルとCIのinstall/postinstall時間を集める。静的なjob分割モデルは準備・待ち・転送・集約を除いた理論下限で、実測とは区別する。

## 証跡

- [変更前全件結果](baseline-report.json)
- [変更後全件結果](all-report.json)
- [複数domain結果](domains-report.json)
- [runner/project棚卸し](inventory.json)
- [履歴・時間集計](metrics.json)
- [回帰試験](migration-tests.log)、[acceptance](acceptance-tests.log)、[domain検証](domain-verification.log)、[root型検査](root-typecheck.log)

共有distは開発サーバー・ブラウザ試験・他のbuildと重ねない。検証前に該当プロセスがないことを確認して実施した。前後hashは一時変更後の復元や他利用者への影響を防げない。SIGKILLやホスト停止ではrunningが残り、合格として扱わない。

差分点検では、製品の意味判断を条件分岐へ移す変更や、特定業務シナリオだけの処理は追加していない。変更は検証の構造・実行・結果保存と文書に限定した。

context_compile / compile_eval：この実装ターン各1回、会話累計各4回。
