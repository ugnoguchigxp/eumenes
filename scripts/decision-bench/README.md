# 判断モデルの独立ベンチマーク

同じ日本語チャンクで判断モデルを測り、保存した確率から閾値・遷移制御を再比較します。製品の判断処理・DB・Web・LARM接続には組み込んでいません。モデルを呼ぶのは`run`だけです。

## すぐ試す

Python 3.10以上とLinuxまたはmacOSを使用します。基本機能と自己検証はPython標準ライブラリだけで動きます。Bunは起動コマンドの省略に使うだけで、backendの起動は不要です。

```sh
bun run decision:bench validate
bun run decision:bench:check

# モデルを使わない動作確認。結果はfixtureとして記録される
bun run decision:bench run --adapter fake --repeats 1 --warmup 0 \
  --out verification-reports/decision-bench/fixture

# 保存結果からA B CとDを再集計。モデルへの接続はない
bun run decision:bench score \
  --input verification-reports/decision-bench/fixture \
  --out verification-reports/decision-bench/fixture-score
```

Pythonだけの場合は`python3 -B scripts/decision-bench/bench.py <command>`です。`--help`および各コマンドの`--help`で引数を確認できます。`--out`を省略した`run`・`score`は現在の作業ディレクトリの`verification-reports/decision-bench/`に新規ディレクトリを作ります。このプロジェクトではGit対象外です。既存の出力先は上書きしません。

## Ryzen上のLayaを測る

以下は**Layaが動いているRyzen側**で実行します。手元のMacの`127.0.0.1`には接続しないでください。フォルダ内のPythonファイルと`cases.jsonl`だけを別ホストへ移しても実行できます。

```sh
python3 -B scripts/decision-bench/bench.py run \
  --adapter laya-http --endpoint http://127.0.0.1:8086/v1/systemone \
  --revision 55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851 \
  --modes A B C --repeats 3 --warmup 10 \
  --out verification-reports/decision-bench/laya-http
```

このrevisionは調査時の稼働モデルです。配備済みrevisionが変わった場合は確認して指定し直してください。不一致は失敗として記録します。`--pid <推論serverのPID>`を追加すると同じホストの`/proc`からメモリとCPUを読みます。PID未指定・読み取れない項目は`null`であり、clientの小さなメモリ量をモデル使用量として代用しません。

HTTPではモデルのロード時間・device・thread数を確認できないため、未測定・未確認になります。`--threads`はHTTP serverの設定を変更しません。認証が必要なら`EUMENES_BENCH_TOKEN`を環境変数で指定します。token・会話本文・providerの生応答は結果ファイルへ保存しません。URLへのtoken埋め込みも禁止しています。

## 校正と遷移制御

```sh
# calibration splitだけで温度と閾値を選ぶ
bun run decision:bench calibrate \
  --input verification-reports/decision-bench/laya-http \
  --out verification-reports/decision-bench/laya-policy.json

# test splitだけで評価。校正時と同じmodel・入力形式を照合する
bun run decision:bench score \
  --input verification-reports/decision-bench/laya-http \
  --policy verification-reports/decision-bench/laya-policy.json \
  --deadline-ms 150 \
  --transitions none hysteresis vote3 ema min-chunks \
  --out verification-reports/decision-bench/laya-score
```

`score`はraw結果と各policyの結果を併記します。policyなしでは未校正・閾値0.6が検討用の既定値です。`--threshold`で変えられます。`--deadline-ms`は保存したadapter判断時間＋準備時間を使う**期限超過シミュレーション**で、実際の取消やTTS開始時間は測りません。adapter判断時間にはtokenizeまたはnative HTTPの往復を含みます。workerの往復時間は資源計測・通信の負荷も含むため別に保存し、期限の計算には混ぜません。

ヒステリシスは現在の候補が0.8未満、旧候補が0.25以上、両者の差が0.30以内の時だけ旧表情を保持します。多数決は直近3チャンク、EMAは今回0.65・前回0.35、最小保持は2チャンクを使います。EMA・最小保持は現在スコア0.85以上の強い変化を優先します。失敗・期限超過・低信頼は通常に戻し、過去の表情で隠しません。これらは固定した比較用条件で、製品へ推奨する最適値ではありません。

温度はNLL、閾値はMacro F1で小さな固定gridから選びます。全6クラスがない校正データ、校正例の失敗、testを使った校正、校正group・templateが混ざる評価、別モデルへのpolicy流用は拒否します。温度はクラスの順位を改善する方法ではありません。

## モデルを直接ロードして比較する

すべてローカルファイルを明示します。Scriptはモデルのダウンロード・学習・service再起動を行いません。必要なライブラリは評価専用のPython環境へ用意します。製品の`package.json`には追加しません。

| adapter | 必要なもの | 入力と出力 |
| --- | --- | --- |
| `laya-local` | `laya`、PyTorch、ローカルcheckpoint | SDKのstate/questions、全候補確率 |
| `verdict` | Transformers、PyTorch、NumPy、ローカルVerdict重み | `query:`入力・`passage:`固定候補、正規化embeddingの類似度×20 |
| `encoder-prototype` | Transformers、PyTorch、NumPy、ローカルRuri等 | `トピック:`入力・候補、正規化embeddingの類似度×20 |
| `encoder-head` | 同上＋学習済みheadのJSON | 正規化embeddingを6クラス線形headへ渡す |

実機で確認したLaya環境はSDK 0.3.20、PyTorch 2.11.0+cpu、Transformers 5.17.0です。EncoderはModernBERT対応のTransformers 4.48以降を使用します。実際のruntime versionはmanifestへ記録します。GPUを使う場合は対応するPyTorch環境を別に用意し、`--device cuda`等を明示します。Layaのdevice fallbackは拒否します。

```sh
# Laya SDKのあるPython環境で実行。既存serviceとは別の評価process
python3 -B scripts/decision-bench/bench.py run \
  --adapter laya-local --model-dir /srv/ai/models/laya-multilingual \
  --model-id laya-multilingual --device cpu --threads 4 \
  --out verification-reports/decision-bench/laya-local

# Ruriを追加学習なしで比較する例
python3 -B scripts/decision-bench/bench.py run \
  --adapter encoder-prototype --model-dir /absolute/path/ruri-v3-30m \
  --model-id cl-nagoya/ruri-v3-30m --device cpu --threads 4 \
  --out verification-reports/decision-bench/ruri-prototype

# Verdict。入力embeddingのcacheは使わず、候補だけ事前計算
python3 -B scripts/decision-bench/bench.py run \
  --adapter verdict --model-dir /absolute/path/verdict-small \
  --model-id Manav2op/verdict-small --device cpu --threads 4 \
  --out verification-reports/decision-bench/verdict
```

Encoderの`--backend onnx --onnx /absolute/path/model_quantized.onnx --quantization int8`ではPyTorchの代わりにONNX Runtimeを使えます。追加で`onnxruntime`が必要です。CPUExecutionProvider専用で、input_ids/attention_mask等から最初の出力に`[batch, tokens, hidden]`のlast hidden stateを返すgraphが対象です。sentence embeddingだけを返すgraphや特殊なinputは明確に失敗させ、別runtimeへfallbackしません。INT8の指定は配布artifactの形式を確認して付けるラベルで、Scriptが量子化するものではありません。

mean pooling＋L2正規化を固定し、現在の対象tokenだけをpoolingする方式は未実装です。判定1回につき入力のEncoder実行は1回。候補embeddingはreadyまでに計算するため、Encoderのfirst predictionは候補の事前計算後である点をmanifestのoption_cacheと併せて見ます。全モデルで同じdevice・threads・データ・上限・反復を指定してください。

`--threads`はTorchまたはONNXの推論用thread数です。tokenizer・runtime等を含めたprocess全体のthread数は`resources.jsonl`の`threads`に別途記録します。

### 学習済みheadの形式

`--adapter encoder-head --head /absolute/path/head.json`を指定します。headは信頼できるローカルJSONのみ読み、pickleはロードしません。以下の各値が必要です。

```text
trained: true
labels: [none, warmth, joy, empathy, curiosity, surprise]
weights: 6 × embedding次元の数値配列
bias: 6個の数値配列
model_fingerprint: 対象checkpointのfingerprint
input_format_sha256: manifestのinput_format_sha256
training_data_sha256: 学習データのSHA256
prefix: "トピック: "
```

fingerprintはローカルモデルの重み・config・tokenizerファイルを内容でhashした値です。prototype測定のmanifestから取得できます。headを作る側も同じmean pooling・L2正規化・役割タグを使ってください。trained宣言と対応metadataを照合し、ランダムheadを自動で作らない設計です。宣言だけで学習の品質・来歴まで証明するものではありません。

## 正解データと結果の読み方

同梱データは**合成88チャンク、42group、校正12例、test76例**です。2チャンクと4チャンクの会話を含み、表情保持後の切り替えや多数決の遅れも比較できます。正解は仮ラベルで、二人による評価・本番精度の保証はまだありません。少数の校正による最適値をそのまま採用せず、人が確認した400〜600例程度へ増やしてください。

1行は`id, group, index, split, user, current, primary, acceptable, transition`。任意に`source: synthetic|real`、`template`、`tags`を持ちます。直前チャンクはScriptがgroupの順序から構成します。通常を許容するかは`acceptable`で例ごとに指定します。groupのユーザー・splitを途中で変えず、indexは0から連続させます。templateは類似例のsplit跨ぎを防ぐために付けます。

個人情報を含むケースはGit対象外の場所に置き、`--data`で明示してください。製品の履歴を自動抽出する処理はありません。

| 結果ファイル | 内容 |
| --- | --- |
| `manifest.json` | model・hash・条件・first prediction・load・実行完了状態・CPU消費 |
| `predictions.jsonl` | 本文を含まないraw出力・全候補確率・例ID・時間・失敗理由 |
| `resources.jsonl` | readyおよび各推論後のモデルprocessのRSS/PSS/Swap/peak/CPU |
| `summary.json` | 各クラスF1・混同行列・ECE/Brier・source別成績・境界変化・反復ごとの一致率 |
| `comparison.csv` / `report.md` | 比較表と不一致例ID |
| `decisions.jsonl` | `score`での各制御方式の個別判断 |

品質の主値はrepeat 0の固有例、速度分布は全反復です。反復を独立した正解例として水増ししません。失敗は分母に残り、rawではerror、policyでは理由付き通常fallbackになります。信頼度の集計は遷移前のモデル確率に対して行います。

HTTPとローカル、device・threads・学習有無・dataset・共通入力形式等が異なる場合は別のcomparison groupになります。モデル固有のnative形式やprefixはmetadataに記録し、共通の役割・対象・日本語データが同じ条件で比較します。未校正と校正後、prototypeと学習済みheadも区別してください。自動で「一位」を決めません。

入力上限は既定512 tokensです。Encoderはtokenize時に超過を拒否、Laya localはSDKのmax_lenへ指定、HTTPはserver側の設定を変えず報告token数で超過・切り捨てを検出します。報告token数がないHTTPの上限確認は未測定になります。

メモリはRSSだけでなくSwapも確認します。readyまでの起動時間とmodel load時間は別項目で、OSのfile cacheを削除していないため真のcold cache測定ではありません。重みhashや候補計算もstartupに含まれます。GPU/NPUの利用率、実際のTTS開始、声色・アバター同期、統計的有意差のbootstrapはこの初版では測定しません。

## 失敗した場合

終了コードは完了0、データ・引数・整合性の不正2、測定失敗・中断3、自己検証失敗1です。精度が低いだけでは失敗終了しません。接続timeoutでは追加要求を積まず測定を止め、既存serviceには触れません。

部分結果は`manifest.status`で区別し、通常のscoreは不完全runを拒否します。調査目的の`--allow-incomplete`で集計できますが、全データの精度ではありません。rawファイルのhashが変わった場合も再集計を拒否します。例外の本文は会話や認証情報を含み得るため、診断には安全なエラーコードだけを出します。

## 検証範囲

`self-test`は正解・未来情報の非混入、group分離、手計算F1、失敗の分母、ヒステリシスの発動、強い切替、期限fallback、raw保存、校正split制約、再集計のモデル非呼び出し、HTTP契約を確認します。HTTPはローカルfixtureを使います。実機の測定結果は`verification-reports/`へ別に記録し、fixtureと混ぜません。

実装時は自己検証15件と`verify:all`を通し、Ryzen実機のLaya HTTPで同梱88例×A/B/Cの264判定を確認しました。Laya SDKの直接ロードも先行する84例×A/B/Cで確認済みです。EncoderのTorch経路は小さな検証用モデルで動作を確認しましたが、実際のRuri・Verdictの重みとONNX経路は未検証です。Layaの比較データも合成・仮ラベルであり、本番での判断精度を示すものではありません。
