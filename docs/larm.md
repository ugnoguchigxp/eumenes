# LARM の接続・予算・session 構成

LARM 接続では毎回接続状態を API で確認し、claim が返した `configuration.fields.baseURL`、`configuration.fields.model`、`credential.token` を使用します。LLM のみなら `providers: ["llm"]`、音声を使う場合は `providers` を省略して Profile 全体を要求します。期限前の renew 後は再claimで token を更新し、終了時に接続を解放します。メインの入力予算は 256072 token、出力上限は 4096 token です。4 セッション構成の目標は、同じ 512K のランタイムを共有するメイン 256K × 1 と補助 64K × 3 です。補助の入力予算は各 59464 token とし、利用側でセッション数と予算を管理します。補助 selector `SAAA-gemma4-26b-64k` は 2026-10-08 時点で catalog が 404 を返すため、コードからも接続を禁止しています。配備後に catalog を確認し、補助の管理処理を実装してから有効化します。

設定は [setup.md](setup.md)(環境変数)と [settings.md](settings.md)(画面)を参照してください。

## 画像生成

2026-10-10以降の基本サービスは **Qwen-Image 2.1 Turbo（AD-Q4_K）** です。Profileは `SAAA-w-Image`、モデル指定は `qwen-image-2.1-turbo`、生成APIは `POST /v1/images/generations` です。Controlの接続先はSQLiteの保存済みLARM設定を使います。サービス発見・確保応答の `services[].url` を生成先として使い、`description` で利用条件を確認します。URLを設定や手順に固定しません。現行の `GET /v3/agent-profiles?profile=SAAA-w-Image` は `url` を含まず `endpoint` を返すため、その応答では返された `endpoint` をControlのURLに解決します。試用経路は `url` があればそちらを優先します。

```json
{
  "model": "qwen-image-2.1-turbo",
  "prompt": "自然光の入る室内。木目と布地を自然な質感で描いた写真。",
  "width": 1200,
  "height": 800,
  "seed": 42,
  "format": "png"
}
```

| 項目 | 指定方法・省略時の値 |
| --- | --- |
| `width` / `height` | 各辺100〜1280の整数。省略した辺は512。縦横を別々に指定できる。 |
| `steps` | 8固定。省略可能。 |
| `seed` | 省略時0。 |
| `format` | `webp` または `png`。省略時 `webp`。 |
| 品質・画風 | `prompt` に具体的に記述する。品質指定の別パラメータは使わない。 |

内部では各辺を32ピクセル刻みに合わせて生成し、保存・返却画像は指定どおりの寸法に縮小されます。利用側では32の倍数に丸めません。下書きには小さめのサイズ、写真風・イラストの仕上げには大きめのサイズと具体的な描写指示を使います。参照画像による編集は現行APIでは未対応です。

要求時にモデルを起動し、画像保存後に停止します。生成APIは同期応答で、起動・生成・停止の待ち時間を含みます。応答の `artifacts[0].contentUrl` または `artifact.contentUrl` をControlのURLに解決してGETします。保存画像はモデル停止後も取得できるため、取得失敗時はGETだけを再試行します。生成POSTは自動再送しません。

利用者が示したこのPCでの実測目安（2026-10-10）は、512角約16秒、768角約31秒、1024角約58秒、1200×777約53秒、1280角約102秒です。負荷や起動状態で変わります。試用の待機上限は既存の15分を維持します。

非空ASRの本入力には、会話開始前の言語判定controlが一回加わります。既定モデルを使い、8秒・256 token以内、confidence 0.8以上、主要言語すべてが利用者の許可リスト内であることが条件です。英字略語やLatin文字の有無では分類しません。判定不在・不正・判定不能では会話を開始しません。ASRと判定receiptの受理、取消、回答/TTSへの検証parentはbackendが管理します。詳細と検証laneは [toolchain](toolchain.md#タイマーと音声) を参照してください。
