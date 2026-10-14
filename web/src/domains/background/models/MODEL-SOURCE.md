# モデルの出所

ユーザー提供の `monitor_galaxy_12_models_input.zip`（Library ID: `libfile_8248a1da1e2881918f497e0294956c3f`）をMacへmaterialize済みの監視銀河sourceから移植した。

採用したSite source: 監視銀河 v11、commit `0eb20e1f640678585afd9c89ec64d1d951507209`。

`assets/*.bin` は元データと同じFloat32 little-endian・stride 8（32 bytes/点）。元座標・phase・group・seed・size・weightを保持する。全12モデル計29,952点。CPUのSHA-256は `0fb9ff086be67b3307dbef48c031a76ce21b03fd79380c79478b00e539fd8e60`。JSONはメタデータとして取り込み、整形だけを変更した。

CPUのGLSL・役割別発光・10%の段階的拡散はSiteの `motion.js` / `shaders.js` / `scatter.js` の採用式から移植。Eumenes既存のThree.js packageを使うため、Siteのvendor JSは複製していない。Three.jsのライセンスは依存packageに含まれる。

12種類は展示用サンプルで、導入済みのProviderや取得済み機器を表さない。Blenderファイルは含めていない。
