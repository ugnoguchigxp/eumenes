# 判断モデルを独立したScriptで比較するベンチマーク設計

**モデル推論を一度記録し、その結果を使って精度・棄却閾値・表情遷移を何度でも比較する**構成を推奨する。製品のAPI・DB・UI・起動処理・依存関係に組み込まず、Ryzen上で明示的に実行するScriptとして完結させる。

2026-10-09に実装の承認を受け、独立CLI・モデルadapter・集計・自己検証を実装した。実際のコマンド・対応範囲は[scripts/decision-bench/README.md](/Users/y.noguchi/Code/eumenes/scripts/decision-bench/README.md)を参照する。以下は設計上の方針と初版の差を含む。

## 最小構成

```text
scripts/decision-bench/
  bench.py          # validate / run / calibrate / score / self-test
  adapters.py       # Laya・Verdict・Encoderを共通形式へ変換
  cases.jsonl       # 個人情報を含まない合成例と正解ラベル
  README.md         # 実行手順と、各adapterに必要な環境

verification-reports/decision-bench/<run-id>/
  manifest.json     # 条件と入力・設定・モデルのhash
  predictions.jsonl # 個別の出力、全候補確率、時間、失敗理由
  resources.jsonl   # モデルprocessのメモリとCPU
  summary.json      # 集計と比較可能性
  comparison.csv    # 表計算で比較できる表
  report.md         # 結論、混同行列、失敗例ID、測定の限界
```

標準ライブラリでデータ検証・HTTP・集計・レポートを実装する。モデル固有のライブラリはadapter内で必要な時だけ読み込む。Python環境は評価専用または実機の既存環境を指定し、製品の依存関係を増やさない。モデルの自動ダウンロード・学習・サービス再起動も通常の実行には含めない。

既存の[evaluate-delivery-live.ts](/Users/y.noguchi/Code/eumenes/scripts/evaluate-delivery-live.ts:1)は製品ルール込みの比較用として残す。新Scriptは`createLarm`や`chooseSpeechDelivery`をimportしない。前回の[小規模比較](/Users/y.noguchi/Code/eumenes/spec/avatar-expression-context-design-2026-10-09.md)は設計の参考にし、候補ゲートや温度設定を隠して混ぜない。

## データは会話の順序と正解を持つ

1行を現在の発話チャンクとする。最低限の形式は次のとおり。

```json
{"id":"recovery-01-0","group":"recovery-01","index":0,"split":"test","user":"最近ようやく体調がよくなったんです。","current":"それはよかったですね。","primary":"empathy","acceptable":["empathy","warmth","none"],"transition":"start","tags":["short","context-dependent"]}
{"id":"recovery-01-1","group":"recovery-01","index":1,"split":"test","user":"最近ようやく体調がよくなったんです。","current":"無理せず、ゆっくり過ごしてください。","primary":"empathy","acceptable":["empathy","none"],"transition":"hold","tags":["reassurance"]}
```

クラスは`none / warmth / joy / empathy / curiosity / surprise`。`primary`は一致率・F1用、`acceptable`は許容外率用。**通常を許容するかは例ごとに付け、全例に自動追加しない。** `transition`は`start / hold / change / any`として、人が必要とする境界変化を明示する。主ラベルの差だけで不要な切替を決めない。

同じgroupは、一つのユーザー発言に対する連続した回答とする。ユーザー発言が変わる場合は別groupにする。直前チャンクは`group＋index`からScriptが構成し、入力ファイルに重複して保持しない。判定には現在までしか渡さず、正解ラベル・許容集合・未来のチャンクは渡さない。

データ検証でIDの重複、順序の欠落、未知ラベル、`primary`が許容集合にない例、groupが複数splitに跨がる例を拒否する。学習・校正・評価は会話と類似テンプレートの単位で分ける。

最初は各クラス10例程度＋文脈対照・遷移例を含む60〜100固有チャンクで動作を確認し、本評価は400〜600程度へ増やす。合成例と実ログ由来例の成績は別々に示す。実ログは公開APIから限定的に抽出して人が確認し、個人情報を含むデータは既にGit対象外の`verification-reports/`に置く。予測結果には本文を複製せず、例IDとhashを保存する。

## 測定は二段階に分ける

### 一段目はモデルの出力をそのまま保存する

共通の日本語ラベル定義・役割付き入力を固定し、各モデルでA・B・Cを実行する。

| 入力方式 | モデルが見られる情報 |
| --- | --- |
| A | 現在チャンク |
| B | 元のユーザー発言＋現在チャンク |
| C | 元のユーザー発言＋直前チャンク＋現在チャンク |

モデルのraw top-1、全候補確率またはlogits、入力token数、切り捨て、推論時間、失敗理由を保存する。この段階では閾値で通常へ変更せず、表情遷移も適用しない。指示文・ラベル定義・入力整形のversionとhashをmanifestへ残す。

同じ例を3回測る場合でも、独立した正解例は1件と数える。反復は実行の揺れと性能分布を見るために使う。順序をseedでランダム化し、モデルは一つずつ測る。前チャンクはランダムな実行順から取らず、元データの順序から取る。

初回推論を別に保存した後、例えば10回のwarmupを除外してwarm性能を測る。バッチ1、同じdevice・thread数・seedで比較し、異なるthread数の最適化比較は別条件にする。P95には観測数を添え、少数測定を安定した性能保証として扱わない。

比較する日本語本文はモデル間で同一にする。品質評価の主セットは各モデルの上限内に収まる入力を使い、モデルごとの無言の切り捨てを許さない。長文・切り捨ては別のstressセットとして失敗率やfallbackを評価する。tokenizerや入力整形の違いは記録する。

### 二段目は保存結果で制御方法を比較する

モデルを再実行せず、校正・閾値・ヒステリシス・多数決・EMA・最小保持を比較する。DはCの出力を`group / repeat / index`で戻し、前の確定した判断だけを使う。

温度・閾値は`calibration` splitで決め、設定ファイルとして固定する。`test` splitで設定を最適化しない。未校正のraw評価と、校正後のpolicy評価を併記する。候補数を可変にする実験は固定6択の評価と別条件にする。

校正用データがない場合は校正を拒否する。policyはモデル・入力方式・ラベル定義ごとに作り、違うmodelやA/B/Cへ無条件に流用しない。確率やlogitsが取得できないadapterでは、校正・EMAなど必要な情報がない機能を明示的に無効にする。

最小保持は、初期版ではチャンク数による比較に限る。実時間の保持を比較するには音声の再生時刻・区間長を含むtraceが必要で、モデル推論時間から音声の長さを推定しない。

**二段目の期限超過シミュレーションは実際の取消動作の測定ではない。** 例えば150msを超えた結果を通常に置き換えるときは、model latencyと仮の期限超過率を表示する。Dの処理時間は別に測り、Cの時間をDの実測値として再掲しない。

## モデルを交換する部分は小さく保つ

adapterの責務は「load、predict、metadata、close」。共通入力を各モデルの形式へ変え、共通出力へ戻す。製品のmotionやVOICEVOXパラメータは決めない。

| adapter | 用途 |
| --- | --- |
| `laya-http` | 現在のRyzen内native APIへ問い合わせる。稼働中モデルの基準測定。既存サービスを再起動しない |
| `laya-local` | 同じcheckpoint・SDKを評価用processでロードする。ロード時間・メモリ・他のローカルモデルとの比較用 |
| `verdict` | 日本語入力と固定候補を埋め込み、rawスコアを返す。入力cacheは無効、候補cacheは条件を記録して許可 |
| `encoder-prototype` | Ruri等のembeddingと固定ラベル表現の類似度を比較する。追加学習なしの基準 |
| `encoder-head` | 学習済みの小型分類ヘッドを使う。headのhash・学習データhash・クラス順・前処理を照合する |

未学習・ランダム初期化のheadで精度を測らない。prototypeと学習済みheadは別条件として表示する。最初から学習機能をベンチマークに内蔵しない。

モデルprocessは評価コマンドの子processとして起動し、同じJSONLの入出力で扱う。起動から`ready`までとモデルのload処理自体を別々に記録し、`predict`の区間を判断時間として分離する。モデルがGPUを使う場合は計算完了を待って計時する。結果の確率がNaN、クラス不足、非正規化の場合はadapterエラーにする。丸めによる合計誤差だけは固定した小さな許容幅内で正規化し、元の合計と処理した事実を残す。

HTTPとローカル推論の数字を同じ欄で順位付けしない。公平なモデル比較は全モデルを同じローカルworker経路で行う。現在のHTTP値は運用中の参考として別に表示する。実機にないモデル・ライブラリは明確なエラーで停止し、別モデルへ自動fallbackしない。

## 集計する指標

| 分類 | 必須の出力 |
| --- | --- |
| 判断品質 | raw top-1一致率、6クラスMacro F1、クラス別precision/recall/F1、混同行列、許容外率 |
| 出現と棄却 | 必要な表情のrecall、通常例への誤表情率、fallback率と理由、失敗・timeout・truncation率 |
| 連続性 | hold境界での切替率、change境界での変化検出率とチャンク数の遅れ、遷移制御で増減した誤り |
| 信頼度 | ECE、Brier score、スコア帯別の誤り、上位2候補の差、校正の有無 |
| 速度 | warm P50/P95、最初の推論、入力整形＋tokenizeを含む時間、全体の往復時間、sample数 |
| 資源 | readyまでのロード時間、RSS/PSS/peak、Swap、process CPU時間、wall時間、使用thread数 |

HTTP adapterのメモリはclientではなく、**同じRyzen上の推論server PID**を明示して測る。PIDが指定できない項目は`null / not_measured`とし、ゼロにしない。新規workerの起動でもOSのfile cacheは残るので、ロード時間の条件を記録する。既存サービスの再起動やOSのcache削除は行わない。

失敗例を精度の分母から黙って除かない。raw評価では失敗を不正解として数え、成功した例だけの値も補助的に出す。policy評価では通常fallbackを別に数え、通常が多いために高精度に見える現象を明らかにする。欠けたクラスは「評価例不足」と記載する。

比較表にはモデルrevision、量子化、device、threads、学習有無、データhash、入力方式、policy hashを載せる。異なるデータ・学習条件・入力整形・transportを混ぜた自動ランキングは作らない。必要なら同じ会話に対する差を会話単位のbootstrapで確認する。

このScriptで測れるのは判断と制御の性能である。**実際のTTS開始遅延、声色の聞こえ方、アバターとの再生同期は測定しない。** モデル候補を絞った後の実機受入として扱う。

## 想定する使い方

以下のCLIを実装した。Python 3.10以上を使用し、model測定は実機側で実行する。

```bash
# データとラベルを確認
python scripts/decision-bench/bench.py validate --data scripts/decision-bench/cases.jsonl

# Ryzen上の既存LayaをA B Cで測る
python scripts/decision-bench/bench.py run --adapter laya-http --endpoint http://127.0.0.1:8086/v1/systemone --data scripts/decision-bench/cases.jsonl --modes A B C --repeats 3 --out verification-reports/decision-bench/laya-reference

# 全モデルのraw結果を別々に採取した後、校正データだけで設定を作る
python scripts/decision-bench/bench.py calibrate --input verification-reports/decision-bench/laya-reference --split calibration --out verification-reports/decision-bench/laya-policy.json

# モデルを呼ばず、評価データ上で制御方法を比較
python scripts/decision-bench/bench.py score --input verification-reports/decision-bench/laya-reference --split test --policy verification-reports/decision-bench/laya-policy.json --transitions none hysteresis vote3 ema min-chunks

# 複数モデルの集計を比較する。入力条件が違えば別の表になる
python scripts/decision-bench/bench.py score --input verification-reports/decision-bench/laya-local verification-reports/decision-bench/ruri-head verification-reports/decision-bench/verdict --split test
```

認証が必要なendpointではtokenを環境変数で渡し、引数・manifest・ログに出さない。接続先やPIDは明示する。CLIにはWebやDBとの自動接続を含めない。SSHはRyzen上でこのCLIを一度起動するために使い、1推論ごとにSSHを起動して時間を混ぜない。

出力先は新規directoryに限定し、既存の結果を上書きしない。JSONLを途中まででも保存し、完了・中断・不完全をmanifestに記録する。通常の終了コード0は測定完了、非0はデータ不正・実行失敗・不完全結果とし、精度が低いだけでは実行失敗にしない。

## 実装と検証の順番

1. データ形式、Laya HTTP測定、raw JSONL、基本集計、fake adapterによる自己検証までを作る。まずここだけで今回の小規模比較を再現できる。
2. A/B/C、校正split、閾値・Dの再集計を追加する。既存のヒステリシス式をそのままコピーせず、確率0.6以上でも保持が実際に発動する境界例を検証する。
3. Laya local workerと資源測定を追加し、同じ経路で代替モデルを測る。VerdictとRuriを別々に実行する。

自己検証の成功条件は、既知の予測列でF1・混同行列が手計算と一致すること、未来チャンク・正解がmodel入力へ漏れないこと、groupの境界で遷移状態がresetされること、強い新候補が速やかに切り替わること、timeoutと不正な確率が隠れないこと。`score`と`calibrate`ではfake adapterも含めモデル呼び出しを拒否し、再集計が推論を起こさないことを確認する。

実装後は`self-test`、少数例のlive測定、同一raw結果での再集計の再現性を確認する。資源測定できない項目は欠測のまま報告し、測定のために製品サービスを操作しない。製品コードへ変更が入る場合はこの設計の範囲を外れるため、利用domainのverifyと`verify:all`が必要になる。

初版は88合成例、校正12例とtest76例、raw記録、A/B/C、温度・閾値校正、Dの再集計、CPU/メモリ、READMEとpackage.jsonの起動コマンドを含む。実時間の保持、GPU/NPU利用率、bootstrap、対象tokenだけのpoolingは未実装である。製品の表情・TTS経路、モデル配置、commit・push・worktreeは変更していない。
