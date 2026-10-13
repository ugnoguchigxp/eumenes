# アーティファクト枠内の画像UI

[実装・検証記録](../../image-embedded-implementation-2026-10-13.md)。通常の制作・一覧をembedded表示にし、会話と並べる。preview表示のみ160px以内へ縮小し、ダウンロード画像の実寸は維持。

| 段階 | 結果 |
| --- | --- |
| DS画像/全画面部分 | 14成功 |
| web画像/Artifact結合 | 58成功 |
| browser fixture | 3成功 |
| 実LARM保存画像読取UI | 12枚、生成/削除0 |
| Storybookの720×720表示 | 境界内、page例外0 |
| image/artifact gate、root型、製品DS/Web build | 成功 |
| verify:all | 既存settings→memory境界違反で初期停止 |

[制作（暗）](creation-dark.png)、[一覧（暗）](gallery-dark.png)、[制作（明）](creation-light.png)、[一覧（明）](gallery-light.png)、[制作（狭幅）](creation-mobile-dark.png)、[一覧（狭幅）](gallery-mobile-dark.png)、[Storybook](storybook-panel.png)。暗色の実画像は保存画像で、計画モデルはfixture。明色はAPI fixture。

[image gate](verify-image.json)、[artifact最終gate](verify-artifact-final.json)、[全体gate](verify-all.json)、[ブラウザ](browser.log)、[実保存画像読取](saved-images-ui-result.json)。全体gate後の登録label更新はartifact gateと型・Web buildで再確認。実LLMの新規生成や実画像の削除は行っていない。
