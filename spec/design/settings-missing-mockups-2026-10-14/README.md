# 設定アーティファクトの追加画面見本

2026年10月14日に、既存資料で画像がなかった3画面の配置見本を追加した。画像内の作業名、主張、状態、数値はレイアウト確認のための例示であり、製品データやAPI仕様ではない。項目・操作・保存先は登録bundleとdomainの公開操作を正本とする。

| 画像 | 対象 | 登録定義で指定する構成 |
| --- | --- | --- |
| [codex-delegation.png](codex-delegation.png) | `settings.dots` | 4区分のタブ。委任した作業は一覧と選択詳細。 |
| [world.png](world.png) | `settings.world` | 常時表示の状態サマリー、主張の一覧と忘却の状況のタブ。 |
| [external-work.png](external-work.png) | `settings.external-work` | 登録済みの実行前確認項目をカードに配置。 |

共通のタブ、一覧と詳細、サマリー、設定カードを使い、画面別の配置はbundleの定義で選ぶ。画像にある登録外の操作やフィルターは追加しない。
