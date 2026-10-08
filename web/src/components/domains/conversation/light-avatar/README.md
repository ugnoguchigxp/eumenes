# SAAA 光のアバター

[SAAA — 光のアバター](https://saaa-light-voice-study.ugnoguchi.chatgpt.site)の B（光の精霊）を会話画面に静止表示する。描画素材は SAAA のローカル実装から移植した。Site の画面や音声 UI は埋め込まず、外部通信をせずに Three.js 0.186.1 で透過 canvas を描画する。

参照元: `/Users/y.noguchi/Code/SAAA/src/features/chat/avatar/`、HEAD `28616e61ce5fe853383d4af6ec14e5b5d542c076`。参照元ファイルは作業時に HEAD との差分なし。SAAA の checkout、製品 DB、設定、秘密は変更・コピーしていない。

| 元ファイル | 元ファイルの SHA-256 |
| --- | --- |
| `model.js` | `90139c966b307f121020371adeaecbc674def31349406efc85d36767a6d6aacd` |
| `motion.js` | `3194fdf23f98084a6a60a76972dccc3f9b85fb26a4ab9a92d91540df5249f68c` |

移植時に formatter を適用し、未使用引数の名前とリソース解放時の不要な配列化だけを変更した。形状、色、camera、shader、透過描画は維持している。元の pose 関数は素材の初期姿勢に使うが、Eumenes 側は常に `render()` の初期値を使い、リアクション・連続アニメーション・音声同期を呼ばない。

`LightAvatarBackground.tsx` が canvas の生成、サイズ変更、破棄を所有する。設定・辞書画面への移動、タブ非表示、unmount 時に GPU リソースを解放する。遅れて import が完了しても破棄済み画面には canvas を追加しない。WebGL 非対応や描画失敗時も会話は利用できる。静止表示なので「動きを減らす」の有無で身体を動かさない。

Three.js のライセンスを `THREE-LICENSE.txt` に同梱する。
