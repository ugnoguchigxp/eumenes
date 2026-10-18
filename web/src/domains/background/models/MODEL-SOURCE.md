# モデルの出所

採用元: 監視銀河Site、commit `2faaae57be7e9d78f74a0b9e2a4cba5538a0c153`（2026-10-18利用者承認）。

14体、33,460点。全点群を元と同じFloat32LE・8成分/32 bytesで保存。元座標・phase・group・seed・size・weightは変更しない。JSONのcomponentsPerPointまたはstrideを検査する。全バイナリのSHA-256は`source-hashes.json`、テストで一致を確認する。旧12体の点群から今回の14体へ置換した。廃止形状のサービス機能や監視APIは削除していない。

`evaluator.ts`は採用元`particles.mjs`の固定座標・有界発光評価器を型付けして移植。`diffusion.ts`と`shaders.ts`は採用済みの6/4群の拡散と原型・拡散点の表示式を再利用する。Eumenes既存のThree.jsを使いvendor JSや別RAFは持ち込まない。選択してもhealth色を保持する。モデル内の自転・変形はしない。

実測は既存snapshotのみ。外部連携とLARM4体は未観測であり、形状の採用を実機器の計測対応と混同しない。
