# 担当の振り分け（Toolchain Router）の作り直し 調査と設計（2026-11-01）

状態: 案（調査・設計のみ）。製品コード・設定・サーバー・モデルは変えていない。数値は、製品 DB の読み取り専用の集計（集計値だけ。発言の本文は読んでいない）と `data/logs/api*.jsonl` の集計、既存の設計書・検証記録から取った。モデルの性能は公開値と理論推定で、Eumenes の担当の振り分けで測った値ではない。

利用者の依頼（2026-11-01）: 担当の選択・起動を、速く・正しく・単純にする作りを、今の実装を精査して独立に考える。追記（同日）:「Rerankerを導入するなら、Ruriによる『ツール利用か会話か』の二値判定も、削除候補にすべき」「Rerankerまたは専用Routerに、通常会話・各Toolchain・判断保留を統合し、1回の推論で振り分ける設計を第一候補として評価する」。

関係する文書: [担当の検索と選び方](toolchain-search-choice-design-2026-10-30.md)、[local ハーネスの作り直し](local-harness-rebuild-plan-2026-10-30.md)、[ハーネスの一本化](single-harness-plan-2026-10-31.md)、[迷ったら検索の1位](local-choice-top-candidate-design-2026-10-31.md)、[意図判定](intent-gate-design-2026-10-29.md)、[判断モデルのベンチマーク](decision-model-benchmark-design.md)、[登録と拡張の手順](../docs/toolchain-extension.md)。

## 0 結論

| # | 問い | 答え |
| --- | --- | --- |
| 1 | Embedding 検索を残すか | 担当探しの段（`find_toolchain`）は残し、中身を「全候補の採点」に替える。今の規模（担当26＋読む道具5＋ホストの操作）では Embedding の上位k件による絞込みは外す。Embedding の索引は消さない（訂正の記憶の近傍探し、100件規模での絞込み、検索の確認に使う） |
| 2 | CrossEncoder か判断モデルか | どちらも「候補の説明文を条件にして、閉じた候補集合に確率を付ける」形で使い、LARM の `system-one` の choice（Eumenes が Ruri の意図判定で既に使う形）に載せる。会話を含めた統合の判断を学習なしで試せるのは、候補の説明を並べて1回の forward で選ぶ判断専用モデル（d1-2B。生成しない）だけなので、PoC はこれを先に測る。CrossEncoder は担当どうしの採点に強く学習の手順も揃っているが、会話の候補は学習しないと採点できない。決めるのは同じ評価データでの測定（§4、§7） |
| 3 | 追加学習なしで足りるか | 担当どうしの区別（作る／流す）は、どちらの方式でも今の Embedding より良くなる見込み。会話か依頼か（雑談の誤起動）は、汎用の Reranker では学習なしでは足りない（「質問と文書の関連度」で学習されており、話題が近いだけの雑談を断る学習をしていない）。d1-2B は振り分け・意図分類を用途に挙げるが、公開値は提供元の自社測定だけで、日本語の振り分けの精度は分からない。指示語・訂正は、どの方式も評価データで確かめるまで足りるとは言えない |
| 4 | 誤選択を即時に直す方式 | 利用者の明示的な訂正だけを「訂正の記憶」に残し、次の採点で近い発言にだけ上限付きの補正をかける。重みは逐次更新しない。重みの学習はまとめて行い、固定の評価で通ったときだけ版を切り替える（§5） |
| 5 | LLM の最終選択をなくせるか | 通常の経路からはなくす。残すのは、どの候補の点数も低い回の「上位3件からの選ぶ呼出し」だけ。即答・パイプライン・記憶の欄を埋める呼出しは残るが、選ぶのではなく、選ばれた1担当の欄だけを書く |
| 6 | 選択から非同期実行までの最も単純な形 | 発言 → ホストが宛先を決められる回はそのまま → Router 1回（会話・担当・仕事・確認を同時に採点） → 決定表 → 会話の回か、今の引き渡し（予告・TODO・Queue） |
| 7 | 消せる・まとめられるもの | 選ぶ呼出しの多候補 schema と選び直しのループ（低い点数の回だけに縮める）、LLM に書かせる `say`・`request`、候補の枠（専用3・パイプライン2・汎用2・差0.05）、過去の選択の 0.8 の線と `fromHistory` の印、迷ったら1位の設計、選ぶ呼出しの system の優先順位の決まり。Ruri の意図判定は、統合 Router が測定で劣らないと確かめた後に消す（§3.6、§8） |
| 8 | モデル1つの追加は見合うか | 見合う。LARM の選ぶ呼出しは中央値 45.3 秒・26回中9回が出力の上限で切断（実測）。Router の採点は、小型の CrossEncoder で 0.2〜1 秒、d1-2B で 0.2〜6 秒（どちらも推定。CPU と前置きの再利用の有無で変わる）。重みは 40 MB〜1.9 GB。本当の費用はモデルではなく、人手で正解を付けた評価データ（400〜600件）と、その保守 |

第一推奨は「統合 Router」（§3）: 会話・担当・仕事・確認を1回の判断で振り分け、LLM の選ぶ呼出しは点数の低い回の fallback だけにする。モデルは PoC で決める。最初に測るのは d1-2B（学習なしで統合の判断を試せる）、次に CrossEncoder（hotchpotch xsmall-v2、ruri-v3-reranker-310m）。Ruri の二値判定は、統合 Router の会話の判定が Ruri を使う今の振り分けに劣らないと測定で確かめられた段階（R4）で削除する。Reranker を入れるだけでは会話の判定は良くならないので、CrossEncoder を使う場合は会話を含めた正解データでの学習と校正を同じ段階に含める。

## 1 今の実装の診断

### 1.1 実際に呼ばれる経路

利用者の発言で始まる回（`routed-turn.ts` の `runRoutedTurn`）。10-31 の一本化で、会話のモデルが LARM でもクラウドでも同じ経路を通る。

| 段 | コード | 中身 | 所要時間（実測） | LLM 呼出し |
| --- | --- | --- | --- | --- |
| 0 宛先の決定 | `routed-turn.ts` `runRoutedTurn` | 専門担当のセッション中は担当へ直接（この経路の外）。聞き返しの答え → 依頼の回。確認待ち・質問待ち → 保留の回（選ぶ呼出し）。Ruri の `request` が保存済みの閾値（0.6）以上 → 依頼の回、ほか → 会話の回。判定の失敗 → 依頼の回 | Ruri: p50 30 ms、p95 125 ms（95回、LAN 往復込み）。モデル内 3〜5 ms（10-09 の記録、CPU・int8） | 0 |
| 1 担当探し | `executor-search.ts` `find` → `toolchain-routing.ts` `routeInTransaction` → `capabilities/service/toolchains.ts` `candidatesInTransaction` | 発言の先頭2000字を LARM の embedding で query にし、担当ごとの文（「名前: 説明」・`useWhen`・`examples`、平均9.2文）との内積の最大値で並べる。枠（専用3・パイプライン2・汎用2、1位との差 0.05）で切る。過去の似た選択（内積 0.8 超、3件）を読み、印を付ける | 判定の後から候補まで p50 89 ms、p90 1.29 s（62回） | 0 |
| 2 選ぶ | `routed-steps.ts` `requestTurn`、`routed-choice.ts` `choiceMessages`・`choiceSchema` | 候補ごとの枝の `anyOf` で JSON を1つ返させる。枝は `none`・`ask`・担当（`say`・`request`・`target`・`refs`・`inputs`）・`memory.request`・`t<n>` の check/amend/cancel。ホストが断れば理由を添えてもう1回（計2回） | LARM: 中央値 45.3 s、p90 68.0 s、最大 78.2 s（26回、うち9回が出力の上限で切断）。クラウド: 中央値 5.3 s、p90 6.3 s（34回） | 1〜2 |
| 3 確かめて渡す | `routed-steps.ts` `carryOut` → `executor-delegation.ts` `handOver` → `work-dispatch.ts` | 影響＝max（呼出しの宣言、担当の `minImpact`）。変更・取り消せない仕事は確認の文。ほかは予告を流し、配信を待ってから、実行の種類ごとに Queue へ入れ、TODO を作り、選択を記録する | — | 0（担当の中で別） |

経路の時間のほとんどは段2。Ruri（30 ms）と検索（89 ms）は合わせて 0.2 秒未満で、選ぶ呼出しの 1/200 以下。

選ぶ呼出しの入力の実物の形（`choiceMessages` が作る user メッセージ。値は説明のための例）:

```text
## Earlier
- 今日はちょっと疲れた
## State
今: 11/01 18:20（前の発言から 1分）
t1: 鎌倉の天気（終わった）
直前の返事: お疲れさまでした。
## Candidates
{"tool":"find_toolchain","result":{"candidates":[{"id":"music.library","title":"音楽の再生","summary":"…","useWhen":["…"],"execution":"session"},{"id":"music.create","title":"作曲","summary":"…","useWhen":["…"]},{"id":"image.create","title":"画像","summary":"…","useWhen":["…"]}]}}
- memory.request: …
- t1: 鎌倉の天気の様子を確かめる（終わった仕事）
## User
コーヒータイムにぴったりな音楽をつくって
```

### 1.2 設計書と実装の食い違い

| 文書の記述 | 実装（コード） | 区分 |
| --- | --- | --- |
| `docs/toolchain.md` の候補の提示:「FTS(trigram)、LARMのembedding、似た依頼での過去の選択をRRFで統合」 | `candidatesInTransaction` は embedding の担当ごとの最大内積だけで並べる。`ftsRank` は常に `null`。過去の選択は `fromHistory` の印だけで順位を変えない。同じ文書の前の段落は「FTSや過去の選択を加点しない」と書いており、文書の中でも食い違う | 文書が古い。RRF は実装されていない |
| 過去の選択の印（`fromHistory`） | `candidateOf` が印を候補の行に出さない。選ぶ呼出しに届かない | 蓄積は選択に効いていない（[迷ったら検索の1位](local-choice-top-candidate-design-2026-10-31.md) §5 の指摘どおり） |
| Local と Cloud のハーネスの差 | 10-31 の一本化で cloud のハーネスと道具のループは削除済み。差は推論の行き先と、クラウドへ送る厳密な schema（`strictChoiceSchema`）だけ | 実装済み |
| 迷ったら検索の1位に頼む | 出力の上限で切れた回は今も会話の回へ（`requestTurn` の `cut` → `talk`）。§4.5 #4（`target` の `new`）だけ実装 | 案・合意待ち |
| 検索の確認（変更後の前後比較） | 再起動後の比較は未実施 | 未実施 |
| Ruri の二値判定 | 配備済みのモデルは旧5分類（request・chat・followup・noise・incomplete）。`request` の確率を閾値 0.6 で切って2択にしている。二値への再学習は未着手。閾値 0.5 の案は利用者の確認待ち | 構想段階 |
| 日常のタスク担当（`task`） | bundle を `dormant` に改名し、検索に出ない。記録に残る `execute_task` 7件は休止前のもの | 停止中 |
| パイプライン | 実行の仕組み（`execution: pipeline`、選ぶ呼出しの枝）はある。公開済みの担当はない | 実装済み・未使用 |
| データ駆動の登録 | 9担当（`web.search`・`web.service-search`・`history.research`・`world.query`・`excalidraw.edit`・`object-recognition.manage`・`image.create`・`music.*`）は `runtime-meta.ts` の固定表で実行の種類を決める | 移行途中 |
| 選択の記録 | 訂正（誤った担当・正しい担当）の欄がない。`outcome` は担当の実行の結果で、選択の正誤ではない。30日で消える | 学習の材料にならない |

### 1.3 記録からの集計（2026-11-01、読み取り専用）

選択の記録（`toolchain_selections`）: 399件（10-12〜11-01）。担当を選んだ回 207、会話で答えた回 180、断られた回 12。今の embedding 空間のベクトルを持つ回 244。

embedding で候補を出し担当を選んだ171回の、選ばれた担当の順位:

| 順位 | 1位 | 2位 | 3位 | 4位 | 候補になかった |
| --- | --- | --- | --- | --- | --- |
| 回数 | 106（62%） | 37（22%） | 15（9%） | 11（6%） | 2（1%） |

| 値 | 結果 |
| --- | --- |
| 1位と2位の類似度の差（1位が選ばれた回 / 2位以下が選ばれた回の平均） | 0.025 / 0.008 |
| 1位の類似度の範囲 | 0.776〜0.943 |
| 有効な担当 / 読む道具 / 担当ごとの文の数 | 26 / 5 / 平均9.2（6〜21） |
| embedding のモデル | 10-12 の検証記録では 384次元の多言語 e5（small）。今の catalog の値は確認していない |
| 担当を選んだ207回の `outcome` | completed 103、failed 57、answered 17、partial 16、not_found 4、cancelled 2、clarification_required 2、なし 6 |
| 失効 | 最古は 11-11 に消える。11-15 までに 97件が消える |

Ruri の意図判定の記録（`dialogue_intent_judgments`、10-29〜11-01）: 95回。`request` 62、`chat` 19、`followup` 10、`incomplete` 2、判定の失敗 2。依頼の回へ 61（うち引き渡しに至った 39）、会話の回へ 32、判定なし 2。正解ラベルは付いていない。

ログ（10-30〜11-01、`dialogue.choice_made` 60回）の選ぶ呼出しの結果: LARM 26回の内訳は切断 9、音楽の作曲 4、聞き返し 3、セッション型 3、画像 2、ほか 5。クラウド 34回は切断 0。

### 1.4 複雑さと遅さの原因

| 観測 | 構造の原因 |
| --- | --- |
| 選ぶ呼出しが LARM で中央値 45 秒、35% が切断 | 1回の呼出しに「候補を比べる」「頼み方（`request`・`say`・`target`・`refs`・`inputs`）を書く」を同時にさせ、今のモデルは考える分を段階で抑えられない（作り直し計画 §11.6） |
| 選ばれた担当が1位でない回が 38% | 検索の点数の差が小さすぎる（1位と2位の差は平均 0.008〜0.025）。発言と1文ずつの内積の最大値は、「作る」と「流す」のような動詞の違いをほとんど区別しない |
| 判断の場所が3つ（Ruri の閾値、検索の枠、LLM） | 誤りがどこで起きたか、どこを直せばよいかが追えない。Ruri の見逃し（`request` 0.571 < 0.6 で会話の回へ、run `f652e84d`）は後段で救えない |
| 枠・差 0.05・汎用の扱い・パイプラインの優先を、検索の規則と選ぶ呼出しの system の両方に持つ | 点数が当てにならない分を、規則と LLM の説明で補っている |
| 訂正が学習されない | 訂正を記録する欄も、それを使う口もない。記録のラベルは LLM の選択で、`outcome` は実行の成否 |
| 担当を足したときの確認が「過去の発言の順位」だけ | 選ぶ呼出しの結果は検索の確認では再現できず、到達できるかを機械で確かめられない |

## 2 方式の比較

### 2.1 比べた方式

| 記号 | 方式 | 中身 |
| --- | --- | --- |
| A | 今の検索＋LLM の選択（最適化込み） | 今の形のまま、検索の文の直し、迷ったら1位、推論の設定で詰める |
| B | Embedding の上位K件 → Reranker | 今の検索で上位8〜12件を取り、CrossEncoder で並べ直して選ぶ |
| C | 全候補を Reranker | 絞込みをせず、有効な全候補を CrossEncoder で採点する |
| D | 判断専用モデル | d1-2B のような生成しない判断モデルに、候補の説明を criteria として並べ、1回の forward で候補ごとの確率を得る（`system-one` の choice）。固定ラベルの分類ヘッド（今の Ruri・Laya の使い方）とは違い、候補は呼出しごとに変えられる |
| E | Hybrid | Embedding・FTS、Reranker、小型判断モデル、履歴の補正、LLM の fallback を組み合わせる |
| F1 | 常駐の会話 LLM の1トークン採点 | 選ぶ呼出しを、生成させずに候補記号の確率（logprob）だけで読む |
| F2 | encoder の近傍と学習ヘッド | Ruri 等の embedding だけで、説明文との類似度・正解例の近傍・小さな学習ヘッドを組み合わせる。CrossEncoder を使わない |
| U | 統合 Router（推奨） | 全候補を1回で採点する判断（D または C）を核に、会話・仕事・確認・記憶の操作も同じ候補として採点し、訂正の記憶で補正し、決定表で決める。点数が低い回だけ上位3件で選ぶ呼出し |

### 2.2 評価

○＝良い、△＝条件付き、×＝悪い。速さは段1〜2の合計（LARM）。精度は見込みで、どれも Eumenes のデータでは測っていない。

| 軸 | A | B | C | D | E | F1 | F2 | U |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 担当どうしの区別 | ○（LLM が読む。ただし切断で失う） | ○ | ○ | △（2B 級の比較の力は未知） | ○ | ○ | △（bi-encoder の限界） | ○ |
| 会話か依頼か | Ruri 頼み | Ruri 頼み | 学習しないと Ruri 頼み | ○（用途に含む。日本語の精度は未知） | Ruri 頼み | ○（会話の LLM が読む） | △ | ○（D なら学習なしで試せる。C なら学習が前提） |
| 候補の漏れ | ×（枠の外は出ない。2/171 は候補外） | △（上位K件の外） | ○（なし） | ○（なし） | △ | ○ | ○ | ○ |
| 速さ（推定。§4.4） | 45 s（実測の中央値） | 0.1〜0.5 s | 0.2〜1 s（小型）、310M を CPU なら数秒 | 0.2〜6 s（前置きの再利用と CPU・GPU で変わる） | 1〜45 s | 1〜3 s（会話モデルの prefill） | 0.1 s | D か C の値 |
| 重み（§4.1） | なし | 40 MB〜1.3 GB | 40 MB〜1.3 GB | 1.1〜1.9 GB（GGUF） | 合計 | なし | なし〜数十MB | D か C の値 |
| 会話 LLM との競合 | 同じ LLM を数十秒占有 | なし（CPU） | なし（CPU） | CPU ならなし、GPU なら iGPU を共有 | 構成次第 | 同じ LLM を占有 | なし | なし（CPU） |
| モデルの入れ替えの影響 | 会話モデルを替えるたびに振る舞いが変わる | なし | なし | なし | 一部 | 替えるたびに校正し直し | なし | なし |
| 担当の追加 | 文を書けば出る | 文を書けば出る | 文を書けば出る | 説明を書けば出る（criteria） | 文を書けば出る | 文を書けば出る | 正解例が要る | 文を書けば出る |
| 実装の量（Eumenes） | 小 | 中 | 中 | 小（今の `system-one` の choice の口） | 大 | 中（LARM の口が要る） | 中 | 中 |
| 保守 | 規則と system の文が増える | Reranker と検索の二重 | Reranker と学習 | 公開から5日。学習の手順は非公開（提供元に問合せ） | 部品が最多 | モデルごとの記号の扱い | 学習ヘッドの再学習 | 1モデルと評価データ |
| 到達できるかの機械の確認 | ×（LLM を呼ばないと再現しない） | △ | ○ | ○ | △ | △ | ○ | ○ |

### 2.3 利用者の挙げた3つの構成

| 構成 | 利点 | 欠点 | 判断 |
| --- | --- | --- | --- |
| Ruri → Reranker | 雑談では Reranker を呼ばない。Ruri は既に動いている | 判断が2段で、Ruri の見逃しを後段で救えない。閾値（0.6・0.5）を別に保守する。計算の節約は 1 回あたり 1 秒未満で、選ぶ呼出しの 45 秒に比べて意味がない | 移行の途中（R2〜R3）だけ使う |
| 統合 Reranker | 1回で会話か担当かを決め、誤りの原因と訂正の口が1つになる。宛先の候補に仕事・確認・記憶の操作も入れられる | 雑談への誤起動を防ぐ学習と校正が要る。追加学習のない Reranker では会話の候補を正しく採点できない | 第一推奨（U）の形。核は Reranker に限らず、候補の説明を並べて選ぶ判断モデル（d1-2B）も同じ口で比べる。Ruri に劣らないことを確かめてから、Ruri を消す |
| 軽量な専用 Router モデル | 固定ラベルの分類ヘッド（今の Ruri の使い方）なら最も速い（1回の encoder）。候補の説明を入力にとる判断モデル（d1-2B）なら、会話・担当・保留を1回で選び、担当を足しても学習し直さない | 固定ラベルは、担当を足すたびに学習し直しが要り、正解例ができるまで新しい担当が選ばれない（到達できない担当を作る）。d1-2B は新しく、日本語の振り分けの精度・CPU の速さ・学習の手順が分からない | 固定ラベルは採らない。説明を入力にとる判断モデルは、U の第一候補として PoC で測る |

### 2.4 方式ごとの判断

- A: 担当どうしの区別は一番良いが、LARM の会話モデルでは考える分で 45 秒・35% 切断。モデルを替えるたびに直す必要があり、「場当たり的な修正を増やさない」目的に合わない。クラウドの会話モデル（5 秒）なら実用だが、local を主とする以上、主経路にしない。fallback として残す。
- B と C: CrossEncoder は発言と担当の説明を同時に読むので、「作って」と「流して」の違いを点数に出せる（bi-encoder の内積ではこれが弱い。§1.3 の差 0.008）。今の規模では、小型の CrossEncoder なら全件を採点しても 1 秒未満の見込み（§4.4）なので、上位K件で切る理由がない。B の上位K件は、候補が百件を超えたときの絞込みとして同じ口に足せばよい。
- D: d1-2B は文を生成しない判断専用モデルで、候補（criteria: 名前と説明）を並べた入力に1回の forward で確率を返す（§4.1）。LARM の Ruri（今の意図判定）・Laya と同じ判断モデルの扱いで、会話の LLM を2つ置くことにはならない。CrossEncoder が候補を1件ずつ独立に採点するのに対し、全候補を同じ入力の中で比べるので、「どれにも当たらない＝会話」を候補の1つとして選ばせやすい。Eumenes 側は、今の意図判定と同じ `system-one` の choice に候補ごとの criteria を入れるだけで済む。弱みは、公開から5日で公開値が提供元の自社測定だけ、CPU の速さが非公開、選択肢の数の上限が不明、学習の手順が非公開、ライセンス（LFM Open License v1.0、年商1千万ドル以上の法人の商用利用を除く）。
- Laya（laya-multilingual）は、学習なしではほぼチャンス水準（MASSIVE intent 0.342〜0.366）で、20択未満を推奨している。今の候補数（33〜44）には学習なしでは使えない。
- E: 部品が最も多く、「単純にする」目的に反する。U は E のうち必要な部品（全候補を1回で採点する判断、訂正の記憶、上位3件の fallback）だけを残したもの。
- F1: 追加のモデルなしで会話か依頼かも読める点は魅力。ただし LARM に「生成させずに候補の確率を返す口」が要り、考えるモデルでは考える分を飛ばす口も要る。会話モデルを替えるたびに校正し直しになる。会話モデルの入れ替えが多い Eumenes では、校正と訂正の蓄積がモデルの入れ替えで失われない独立の Router の方が保守しやすい。
- F2: 最も軽い。訂正の記憶の近傍探しにはこの仕組みを使う（U の一部）。ただし担当の主な採点を bi-encoder に任せると、今の検索と同じ「動詞の違いが点に出ない」問題が残る。

## 3 推奨: 統合 Router

### 3.1 流れ

```text
利用者の発言
  │
  ├─ ホストが宛先を決められる回 ─────────────── そのまま（Router を呼ばない）
  │    ・専門担当のセッション中 → 担当へ
  │    ・画面のフォームからの依頼（pinned）→ 指定の担当へ
  │
  └─ Router（1回）
       入力: 今の発言＋直前の返事＋前の発言（指示語のため）
       候補: conversation.respond ＋ 有効な担当すべて ＋ 読む道具
             ＋ memory.request ＋ 仕事（t<n>.check / amend / cancel / redirect）
             ＋ 確認・質問（c<n>.approve / decline、t<n>.answer）
       採点: LARM の Router（system-one の choice。候補の説明を criteria にして送り、
             候補ごとの確率を受け取る。中のモデルは判断モデルか CrossEncoder）
             ＋ 訂正の記憶の補正（Eumenes）
       校正: 温度と種類ごとの偏り（評価データの calibration で決める）
       │
       └─ 決定表（§3.3）
            ├─ 会話 → 会話の回（今の talk、道具なし）
            ├─ 担当 → 欄の要る担当だけ「欄を埋める呼出し」→ 今の引き渡し（影響・確認・予告・TODO・Queue）
            ├─ 仕事・確認・記憶 → 今のホストの操作
            ├─ 迷い（上位が並ぶ）→ 1位に頼む（影響なしの担当だけ）／聞き返し（ホストの決まった文）
            └─ どれも低い → 上位3件＋会話＋聞き返しで、今の選ぶ呼出し（fallback）
```

### 3.2 候補（Router が採点するもの）

| 種類 | id（criteria の名前） | 出る条件 | 採点に使う文（criteria の説明、各96 token 以内） |
| --- | --- | --- | --- |
| 会話 | `conversation.respond` | いつも | 「仕事を始めず、話し相手として返事をする（雑談、感想、気持ち、相づち、エージェントへの質問）」。文は登録データ（bundle と同じ形の host 定義）に置き、コードに書かない |
| 担当 | 担当の id | 有効で adapter が使える | `名前: 説明` と `useWhen` の先頭2行。種類（専用・パイプライン・汎用）は文に入れず、校正の偏りで扱う |
| 読む道具 | `read_memory` ほか | 今と同じ | 今の検索の文 |
| 記憶 | `memory.request` | いつも | 今の `memory.request` の説明 |
| 仕事 | `t<n>.check`・`t<n>.amend`・`t<n>.cancel` | `## State` に仕事がある（amend・cancel は進行中だけ） | 「〈仕事の題〉の様子・結果を確かめる」「〈題〉の内容を直す」「〈題〉を取りやめる」 |
| 訂正 | `t<n>.redirect:<担当 id>` | 直前の回（同じ会話、5分以内）に引き渡した仕事が1件あり、その回の予測集合にほかの担当があるとき、その担当ごと（最大2件） | 「直前の依頼「〈元の発言、60字〉」を、〈元の担当〉ではなく〈別の担当〉でやり直す」 |
| 確認・質問 | `c<n>.approve`・`c<n>.decline`・`t<n>.answer` | 確認待ち・質問待ちがある | 「〈確認の文〉に、はいと答える」「…に、いいえと答える」「〈質問〉に答える」 |

今の候補数: 会話1＋担当26＋読む道具5＋記憶1＋仕事 0〜6＋訂正 0〜2＋確認 0〜3 ＝ 33〜44件。

Router への要求の実物の形（今の意図判定と同じ `larm.system-one.v1` の choice。説明文は例で、実際は担当の登録データから作る）:

```json
{
  "model": "<claim の model>",
  "state": {
    "previous_agent": "曲を流しますね。",
    "previous_user": "コーヒータイムにぴったりな音楽をつくって",
    "text": "違う、作曲してほしい"
  },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "利用者の今の発言を、どこへ渡すかを選んでください",
      "criteria": {
        "conversation.respond": "仕事を始めず、話し相手として返事をする（雑談、感想、気持ち、相づち、エージェントへの質問）",
        "music.create": "作曲: 場面や気分に合う曲・BGM・歌を新しく作る",
        "music.library": "音楽の再生: 保存済みの曲やプレイリストを流す・止める",
        "t3.redirect:music.create": "直前の依頼「コーヒータイムにぴったりな音楽をつくって」を、音楽の再生ではなく作曲でやり直す",
        "t3.cancel": "コーヒータイムの曲を取りやめる",
        "weather.forecast": "天気: 地名と日を言われた天気予報を答える"
      }
    }
  }
}
```

応答は今と同じく `answers.route.choice`・`answers.route.probabilities`（criteria のすべて）・`routing.head_revision` を読む。`previous_user` は今の protocol にない欄で、LARM に足す（足せなければ `text` の前に前の発言を置く）。CrossEncoder で実装する場合、LARM は `state` を1つの query にし、criteria の説明を passage にして組ごとに採点し、softmax して同じ形で返す。Eumenes は中のモデルを知らない。

### 3.3 決定表

| # | 条件（校正後の確率 p、1位 p1・2位 p2） | 決定 | 話す文 |
| --- | --- | --- | --- |
| 1 | 1位が `conversation.respond` で p1 ≥ τ会話 | 会話の回 | 会話の回の返事 |
| 2 | 1位が担当・ホストの操作で、p1 ≥ τ採用 かつ p1 − p2 ≥ δ | 1位を実行 | 担当: 予告（担当の登録の文。なければ「「〈担当〉」に頼みます。」）。確認が要れば今の確認の文 |
| 3 | 1位が担当で、τ低 ≤ p1 < τ採用 または差が δ 未満、1位の影響が none | 1位に頼む（[迷ったら1位](local-choice-top-candidate-design-2026-10-31.md) の利用者の希望）。2・3位を訂正の候補として記録 | 「「〈担当〉」に頼んでみます。」 |
| 4 | #3 と同じ点数で、1位の影響が modify_existing 以上 | 今の確認の文（承認が要る）。確認の文で担当の名前を言う | 今の確認の文 |
| 5 | 1位が `c<n>.approve` | p1 ≥ τ承認（τ採用より高い）のときだけ承認。足りなければもう一度確認の文 | 今の決まった文 |
| 6 | 1位が `t<n>.cancel`・`t<n>.redirect` | p1 ≥ τ採用 のときだけ実行。足りなければ「〈題〉を取りやめますか？」と確認 | `say` の代わりの決まった文 |
| 7 | 1位が会話で、2位の担当が τ低 以上 | 会話の回（作業を約束しない）。記録に「迷い」を残す | 会話の回の返事 |
| 8 | p1 < τ低（どれも低い） | 上位3件＋会話＋聞き返しで、今の選ぶ呼出し（fallback）。切れたら会話の回 | 選ぶ呼出しの結果のとおり |
| 9 | Router の失敗（時間切れ・接続） | 今の経路（Ruri → 検索 → 選ぶ呼出し）。R4 以降は検索の1位を使わず fallback の選ぶ呼出し | — |

τ・δ は評価データの calibration で決め、設定（SQLite）に保存する。初期の目安は τ採用 0.6、τ低 0.3、δ 0.15、τ承認 0.85（目安で、測る前の値）。

### 3.4 頼み方の欄を書く場所

選ぶことと書くことを分ける。Router は書かない。

| 実行の種類 | 今（選ぶ呼出しが書く） | 新 |
| --- | --- | --- |
| research・command・task・音楽・画像・描画 | `say`・`request`・`refs` | `request` は利用者の言葉（聞き返しの答えは元の依頼とつなぐ。前の発言を `## Earlier` として担当へ渡す）。原文は今の `originalRequest`。`say` はホストの文（§3.3）。提示中の資源は一覧を担当へ渡し、担当が使うものを選ぶ |
| session（作品を持つ担当） | `say`・`request`・`target` | 保存済みの作品がない担当は `target` なし。作品がある担当は「欄を埋める呼出し」で `target`（`new` か作品）だけを書く |
| instant（天気・株価） | `inputs` | 欄を埋める呼出し（その担当の欄の schema 1つだけ。候補を比べない） |
| pipeline | `say`・`inputs` | 欄を埋める呼出し |
| read | `inputs` | 欄を埋める呼出し |
| `memory.request` | `kind`・`what`・`detail` | 欄を埋める呼出し |
| `t<n>.amend`・`t<n>.answer` | `text` | 利用者の言葉をそのまま |

欄を埋める呼出しは今の `choiceSchema` を「候補1件・`none`・`ask` だけ」にした形で、新しい仕組みを作らない。比べる相手がないので考える分は短くなる見込みだが、測っていない（§7 で測る）。

### 3.5 担当の選択と実行の許可を分ける

| 判断 | 誰が | 根拠 |
| --- | --- | --- |
| どこへ渡すか | Router（点数）＋決定表 | 候補はホストが作った閉じた集合。Router は集合の外の id を出せない |
| 影響の大きさ | ホスト（今の D7 の規則: max（対象の有無、担当の `minImpact`）） | Router の点数で影響を下げない |
| 実行してよいか | 影響 none はホスト、modify_existing・irreversible は利用者の承認 | 承認は配信済みの確認文への答えだけ（今の規則）。#5 の τ承認 は誤承認を減らすための追加の線 |
| 取消・期限・権限 | ホスト（今の `current`・`acted`・Queue の dedupe） | 変えない |

信頼の境界: Router の入力は利用者の発言・直前の返事（未信頼のデータ）と、登録済みの候補の文だけ。ツールの結果・Web の本文・担当の報告は入れない。Router には SystemContext がなく、出力は候補の点数だけなので、外部のデータが Router の権限や system を書き換える経路がない。訂正の記憶に書けるのは、ホストが確かめた利用者の操作（§5.2）だけ。

### 3.6 Ruri の意図判定の扱い

| 段階 | Ruri | 根拠 |
| --- | --- | --- |
| R1〜R2 | 今のまま（会話の回へ分ける）。Router は依頼の回だけで採点。統合の会話の点数は shadow で記録 | Router の会話の採点は、学習前は信頼できない |
| R3 | Router の会話の候補の点数に、Ruri の `chat` の確率を特徴として足す（判断は Router の1回） | 判断の場所を1つにしつつ、強い信号を残す |
| R4 | 学習済みの Router だけで、評価データの雑談の誤起動率・依頼の見逃し率が Ruri を使う形に劣らないと確かめたら、意図判定の呼出し（`openIntentGate`）と設定（`intent`）を消す | 劣らない＝誤起動率・見逃し率とも +1 ポイント以内（評価データ 95% 信頼区間で） |

Ruri を消しても、LARM の `system-one` は表情・声色の判定（delivery）で使い続けるので、LARM のモデルは減らない。消えるのは Eumenes の意図判定の口・設定・記録の書込みと、閾値の保守。Ruri の 30 ms の節約は理由にしない。

### 3.7 この作りが崩れる条件

| 条件 | 起きること | 対処 |
| --- | --- | --- |
| 評価データが集まらない（人手の正解が 300件未満） | 会話の候補を学習できず、R4 に進めない | R3 で止める（Ruri を残す）。それでも段2の 45 秒は解消する |
| 担当が百件を超え、全件の採点の P95 が 1 秒を超える | 体感の遅れ | 同じ口に Embedding の絞込み（上位30件＋会話・仕事・使った担当）を足す（B） |
| 担当の説明文が似ている（作曲と再生のように文が近い） | Reranker も区別できない | 登録時の到達性の確認（§3.8）で登録を止め、文を直す |
| 訂正の記憶が古い担当に固定される | 新しい担当が選ばれない | 担当の追加時の再評価（§5.6） |
| パイプラインが公開され、単独の担当と競う | 「依頼の全体をこなすなら先に」の規則を Reranker は知らない | パイプラインを公開する前に、複数工程の依頼を評価データに入れて学習する |
| LARM の Router が落ちる | 依頼が振り分けられない | #9 の今の経路 |

### 3.8 到達できない担当を作らない

| 仕組み | 中身 |
| --- | --- |
| 全件の採点 | 有効な担当はすべて採点される。検索の枠で切られて候補に出ないことがない |
| 登録時の到達性の確認 | `toolchain:bundle check` と検索の確認 API に Router の確認を足す。担当ごとに、登録の `examples` と評価データの正例がその担当を1位か予測集合に入れる割合（Recall@1・Recall@集合）を出す。新しい担当の登録で、ほかの担当の Recall@1 が評価データで 2 ポイント以上下がれば登録を断る |
| 汎用の担当への集中 | 種類ごとの偏り（校正の `b汎用`）で汎用を下げる。担当ごとの選ばれた割合を、評価データの正解の割合と比べて記録する |
| 新しい担当（正解例 0件） | 説明文と `examples` だけで採点する（学習は id ではなく文で行う）。leave-one-out（§7.4）で、学習に入っていない担当の Recall@1 を測る |
| 繰り返す誤選択 | 同じ（誤った担当、正しい担当）の組が2回を超えたら、確認の一覧に出す（担当の文の直し・再学習の材料） |
| fallback へ送る条件 | 決定表 #8（どれも低い）だけ。上位の並び（#3）は fallback に送らない |

## 4 モデル選定

### 4.1 候補（一次情報、2026-11-01 時点）

ベンチマークは一般のもので、Eumenes の担当の振り分けの精度ではない。出典は §10。

| モデル（公開） | 形 | 日本語 | 重み | ライセンス | 実行の口 | 追加学習 | 公開ベンチ（一般） | 速さ（公開値） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LiquidAI/d1-2B（2026-10-27） | 生成しない判断モデル（LFM3-VL-2B ベース）。choice・score・yes/no を1回の forward で確率付きで返す。128K（64K 超で信頼性が下がる） | 16言語に日本語を明記 | 1.92B。GGUF Q4_K_M 1.1 GB / Q8_0 1.85 GB | LFM Open License v1.0（年商1千万ドル以上の法人の商用利用を除く） | llama.cpp（GGUF のカードに `/v1/systemone`。choice・score・yes/no のみ、build b11960 以上）、transformers（CPU は FP32） | 手順は非公開（提供元に問合せ） | DecisionBench 77.1 ほか。すべて提供元の自社測定 | 1問: H100 5.7 ms、M5 Pro 18.6 ms。CPU は非公開 |
| cl-nagoya/ruri-v3-reranker-310m（2025-04） | CrossEncoder（ModernBERT-Ja）。8192 | 日本語専用 | 315M（埋め込みを除き 236M）。fp32 で約 1.26 GB | Apache-2.0 | sentence-transformers。公式の ONNX なし（コミュニティの int8 あり） | 手順は非公開。学習データは公開 | hotchpotch の比較表の平均 0.9171。作者の表で JQaRA nDCG@10 86.9 | GPU（RTX5090）で xsmall-v2 の約12.5倍の時間。CPU は非公開 |
| hotchpotch/japanese-reranker-xsmall-v2（2025-05） | CrossEncoder（ruri-v3-pt-30m の全10層） | 日本語専用 | 36.8M | MIT | ONNX と int8 を公式に同梱 | 学習データは公開 | 同じ表の平均 0.8699 | M4 Max の CPU で約 15.3 ms／組（公開値からの割り算） |
| hotchpotch/japanese-reranker-tiny-v2（2025-05） | CrossEncoder（3層） | 日本語専用 | 29.4M | MIT | ONNX と int8 を公式に同梱 | 同上 | 同じ表の平均 0.8138 | 約 4.7 ms／組（同上） |
| hotchpotch small-v2 / base-v2（2025-07） | CrossEncoder | 日本語専用 | 70M / 約0.1B | MIT | sentence-transformers（ONNX の記載なし） | 同上 | 同じ表の平均 0.8856 / 0.8930 | CPU は非公開 |
| Qwen/Qwen3-Reranker-0.6B（2025-06） | decoder LLM 型（yes/no の logit で採点） | 100以上の言語（日本語の明記なし） | 0.6B。GGUF Q8_0 639 MB | Apache-2.0 | llama.cpp（`--rerank`、公式対応）、vLLM | 手順は非公開 | MMTEB-R 66.36。日本語の値なし | 非公開 |
| convaiinnovations/laya-multilingual | mmBERT-base ＋判断ヘッド | 100以上の言語。日本語の値なし | 322M | Apache-2.0 | laya パッケージ（ONNX あり） | 手順あり（RLCD と温度校正） | 学習なしの MASSIVE intent 0.342〜0.366（ほぼチャンス）。20択未満を推奨 | Intel CPU 28スレッドで 48 ms／問 |
| LiquidAI/LFM2.5-Encoder-350M-Prompt-Router | 説明文の「lane」へ1回で振り分ける | 日本語の明記なし | 0.4B | lfm1.0 | transformers | 記載なし | 精度値なし | 記載なし |
| cl-nagoya/ruri-v3-30m / 70m（embedding） | bi-encoder | 日本語専用 | 37M / 70M | Apache-2.0 | sentence-transformers | 学習データは公開 | JMTEB 平均 74.51 / 75.48 | 非公開 |
| BAAI/bge-reranker-v2-m3 | CrossEncoder | 多言語 | 0.6B | Apache-2.0 | llama.cpp（`--rerank` の例） | 手順あり | JQaRA 0.6730（hotchpotch の表） | 非公開 |
| jinaai/jina-reranker-v2 / v3 | CrossEncoder / listwise | 日本語の例あり | 278M / 0.6B | CC-BY-NC-4.0 | ONNX・GGUF | — | — | — |

### 4.2 優先順位（PoC で測る順）

| 順 | モデル | 役 | 実行 | 理由 | 次へ進む条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | d1-2B | 統合 Router（学習なしで、会話・担当・仕事・確認を1回で選ぶ） | LARM の llama.cpp（GGUF Q8_0、`/v1/systemone`）。CPU から測る | 今の意図判定と同じ口。全候補を同じ入力の中で比べ、会話を候補の1つにできる。候補を足しても学習し直さない | 評価データで、Top-1 と雑談の誤起動率が「順2の学習なし＋Ruri」より良く、P95 ≤ 1.5 s（CPU、または会話の速さを5%以上落とさない iGPU） |
| 2 | japanese-reranker-xsmall-v2 | CrossEncoder（担当の採点）。学習して会話の候補も採点する | LARM、ONNX Runtime の CPU EP（公式同梱の int8） | 公式の ONNX int8、MIT、CPU の公開値 15 ms／組。sentence-transformers の CrossEncoder で学習できる | 順1が条件を満たさないとき、または順1と同等以上の精度で軽いとき |
| 3 | ruri-v3-reranker-310m | CrossEncoder（精度重視） | LARM、ONNX（int8 は自前で変換。LARM の Ruri と同じ形）。CPU で遅ければ iGPU | 公開の日本語の表で最上位（平均 0.9171） | 順2の精度が足りないとき |
| 4 | Qwen3-Reranker-0.6B | 比べるためだけ | llama.cpp `--rerank` | llama.cpp の公式対応 | 日本語の公開値がないので、上位と同じ評価データで比べるだけ |
| — | laya-multilingual | 外す | — | 学習なしでチャンス水準、20択未満の推奨。今の候補数（33〜44）に合わない | — |
| — | LFM2.5-Encoder-350M-Prompt-Router | 外す | — | 精度値も日本語の明記もない | — |
| — | jina-reranker-v2 / v3 | 外す | — | CC-BY-NC | — |
| — | bge-reranker-v2-m3 | 外す | — | 0.6B で、日本語の表で Ruri・hotchpotch に劣る | — |
| — | d1-3B / d1-omni-600M | 外す | — | 日本語の明記がない | — |

訂正の記憶の近傍（§5.4）の embedding は、今の LARM の embedding をそのまま使う。評価データで線 θ を決められない（無関係な組と区別できない）ときだけ、ruri-v3-30m／70m を LARM の catalog に足して空間を替える（索引は空間の鍵ごとに作り直す、今の仕組み）。

### 4.3 実行の場所

| 場所 | 判断 | 理由 |
| --- | --- | --- |
| LARM の CPU（AI MAX+ 395、Zen 5 16コア、AVX-512） | 第一 | 会話 LLM（iGPU）と計算を分ける。LARM の Ruri（`system-one`）は CPU・int8 でモデル内 3〜5 ms（10-09 の記録）で、同じ形が既にある。llama.cpp の CPU と ONNX Runtime の CPU EP は公式に使える |
| LARM の iGPU | CPU で P95 が 1.5 s を超えるときだけ | 会話 LLM と同じ iGPU・同じメモリ帯域を使う。ONNX Runtime の ROCm EP は 1.23 で削除され、MIGraphX EP の gfx1151 対応は 2026-10-05（ROCm 10.1）に入ったばかりで、gfx1151 でのセグフォルトの報告がある。llama.cpp の Vulkan・HIP で reranking を動かした一次の報告は見つからない |
| NPU（XDNA2） | 使わない | Linux では NPU 単独・BF16 の BERT 型だけで、モデルは Windows で作る。Node・Bun からの口がない |
| Eumenes の backend（Bun）に onnxruntime-node | 使わない | backend は利用者の Mac で動き、AI MAX+ 395 の CPU を使わない。onnxruntime-node は対応先に Bun を挙げておらず、Bun で終了時に panic する不具合があった（修正は 2026-07 に main へ入ったが、安定版への収録の明記は見つからない）。モデルは LARM の catalog で見つける決まりで、LAN の往復は Ruri の記録で 11〜20 ms と小さい |
| Python の常駐 process | LARM の判断 | d1-2B は llama.cpp の server で動く。CrossEncoder は LARM の `system-one` の実行（ONNX Runtime）に載せれば増やさずに済む。LARM の実装はこのリポジトリの外 |

### 4.4 速さとメモリの見積もり（理論推定。AI MAX+ 395 では測っていない）

候補数 N は、担当の数＋10（会話1、読む道具5、記憶1、仕事・確認3）とする。担当10件で N=20、30件で N=40、100件で N=110。CPU の速さは M4 Max の公開値と同程度と仮定した。

| モデル | N=20 | N=40 | N=110 | 重み | 見積もりの根拠 |
| --- | --- | --- | --- | --- | --- |
| tiny-v2（CPU） | 0.09 s | 0.19 s | 0.52 s | 約 30 MB（int8） | 4.7 ms／組 × N |
| xsmall-v2（CPU） | 0.31 s | 0.61 s | 1.7 s | 約 40 MB（int8） | 15.3 ms／組 × N |
| ruri-v3-reranker-310m（CPU） | 3.8 s | 7.6 s | 21 s | 約 320 MB（int8）〜1.26 GB | xsmall-v2 との GPU の時間比 12.5倍を CPU に当てた。組の長さ（今回は192 token 以内）と int8 で数分の一になりうる。LARM の Ruri の記録（短い入力でモデル内 3〜5 ms）からは組あたり数十 ms の可能性もあり、幅が大きい |
| ruri-v3-reranker-310m（iGPU） | 0.05〜0.1 s | 0.1〜0.2 s | 0.3〜0.6 s | 同上 | RTX5090 の 0.54 ms／組を、iGPU で5〜10倍遅いと仮定 |
| d1-2B（CPU、前置きの再利用なし） | 1.4〜3.8 s | 2.7〜7.2 s | 7〜19 s | 1.1 GB（Q4_K_M）〜1.85 GB（Q8_0）＋KV | 入力 ≈ 150＋50×N token を1回。prefill を 300〜800 token/s と仮定 |
| d1-2B（CPU、候補の説明の前置きを再利用） | 0.2〜1 s | 0.2〜1 s | 0.2〜1 s | 同上 | 変わる部分（発言・仕事・確認の候補、150〜300 token）だけを計算。`/v1/systemone` の入力の並びで再利用できるかは未確認 |
| d1-2B（iGPU） | 0.2〜0.6 s | 0.4〜1.1 s | 1.1〜2.8 s | 同上 | prefill を 2,000〜5,000 token/s と仮定 |

どの方式でも、今の LARM の選ぶ呼出し（中央値 45.3 s）より1桁以上短い見込み。担当100件で CPU の P95 が 1.5 s を超える方式には、Embedding の絞込み（上位30件＋会話・仕事・確認・使った担当）を同じ口の前に足す。

## 5 即時の訂正と継続の学習

### 5.1 方式の比較

| 方式 | 1件の訂正が次回に効くか | 無関係な依頼への悪影響 | 重みの逐次更新 | 撤回・忘却 | 判断 |
| --- | --- | --- | --- | --- | --- |
| A 訂正の記憶（近傍の補正） | 効く（近い発言だけ） | 線より遠い発言には効かない | 不要 | 行を消せば即時に戻る | 採る（即時の口） |
| B 軽量なオンライン学習器（点数を入力にした補正モデルを逐次学習） | 効く | 1件で全体の重みが動き、無関係な依頼の振り分けも変わる | 要 | 学習済みの重みから1件を外せない（学習し直し） | 採らない。校正（温度・偏り）はまとめて学習する |
| C Reranker の追加学習 | 次の版から（まとめて） | 評価で確かめてから出す | 要（まとめて） | 版を戻す | 採る（持続の口）。d1-2B を選んだ場合は学習の手順が非公開なので、持続の改善は候補の説明文（担当の新しい版）と校正で行う |
| D1 近傍の事例による順位付け（kNN） | 効く | A と同じ | 不要 | 可 | A の実装そのもの |
| D2 担当ごとの典型（prototype） | 正例が数件たまってから | 小 | 不要 | 可 | 正解例の少ない担当の補助に、評価で効けば足す |
| D3 Contextual Bandit | 探索で効く | 探索のために、迷った依頼をわざと別の担当へ渡す | 要 | 難 | 採らない（副作用のある担当で探索できない） |
| D4 選好学習（DPO 等） | 次の版から | — | 要 | 難 | 採らない（CrossEncoder には C で足りる） |

即時の振る舞いの改善（A）と、モデルの重みの学習（C）を分ける。A は次の発言から効き、C は評価を通った版から効く。

### 5.2 訂正として残す信号

| 信号 | ホストが確かめること | 意味 | 使い方 |
| --- | --- | --- | --- |
| `t<n>.redirect:<担当>` が実行された | 直前の回の引き渡し・同じ会話・5分以内 | 誤選択 | 訂正の記憶（誤り・正解）＋学習の正例・負例 |
| `t<n>.cancel` の後、次の回で別の担当に渡った | 同じ会話・取消から2分以内・元の依頼文を引き継いだ | 誤選択の見込み | 学習の候補（人の確認の後に正例）。訂正の記憶には入れない |
| 聞き返し（決定表 #4・#6・fallback の `ask`）への答えで担当が決まった | 聞き返しの記録 | 曖昧さの解消 | 訂正の記憶（正解だけ）＋学習の正例 |
| 画面の「担当を変える」（予測集合の2・3位から選ぶ） | 利用者の操作 | 誤選択 | 訂正の記憶＋学習 |
| 人のレビュー（`router-review`） | レビューの記録 | 正解 | 学習（評価データ） |
| `outcome: failed` | — | 担当の実行の失敗。選択の誤りではない | 使わない。担当の失敗率として別に数える |
| `outcome: completed` で訂正なし | — | 弱い正例 | 再学習の補助（重み小）。訂正の記憶には入れない |
| Router 自身の選択 | — | — | 正解として使わない（自己学習をしない） |

「違う、作曲してほしい」の流れ:

| 順 | 起きること |
| --- | --- |
| 1 | 前の回: 「コーヒータイムにぴったりな音楽をつくって」→ Router の1位 `music.library`（p1 0.48）、2位 `music.create`（0.41）→ 決定表 #3 で再生に頼む。予測集合 {再生, 作曲} を選択の記録に残す。仕事 t3 |
| 2 | 今の回: 「違う、作曲してほしい」。候補に `t3.redirect:music.create` が出る（直前の引き渡し・予測集合の2位） |
| 3 | Router の1位が `t3.redirect:music.create`（p1 ≥ τ採用）→ ホストは t3 を取り消し（再生を止める）、元の発言と今の発言をつないで作曲へ渡す（1つの transaction。取消と引き渡しの dedupe は今の `actionKey`） |
| 4 | 訂正の記憶に1行: 元の発言・誤り `music.library`・正解 `music.create`・出所 `redirect` |
| 5 | 次に「夕方に合うBGMをつくって」（元の発言と近い）→ 訂正の記憶が `music.create` に補正をかけ、作曲が1位になる |
| 6 | 「お気に入りの曲を流して」（元の発言と遠い）→ 線より遠いので補正なし。再生が1位のまま |

### 5.3 訂正の記憶のデータ

toolchain-history domain に置く（選択の記録と同じ持ち主）。

```sql
CREATE TABLE router_feedback(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL,              -- 訂正の対象になった発言。発言の忘却でこの行も消す
 selection_id TEXT NOT NULL,            -- 誤った（または迷った）回の toolchain_selections.id
 source TEXT NOT NULL CHECK(source IN ('redirect','ask_answer','ui_pick','review')),
 query_text TEXT NOT NULL,              -- Router に渡した query（§3.2 の形）
 query_space TEXT NOT NULL,             -- 近傍探しの embedding の空間
 query_vector BLOB NOT NULL,
 wrong_id TEXT,                         -- 誤った行き先。見逃し・聞き返しの答えでは null
 wrong_revision_id TEXT,
 right_id TEXT NOT NULL,                -- 正しい行き先（担当の id または conversation.respond）
 right_revision_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('active','retracted','stale','conflict')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL);
CREATE INDEX router_feedback_space ON router_feedback(query_space, state);
```

選択の記録（`toolchain_selections`）に足す欄: `router_json`（候補ごとの生の点数・校正後の確率・補正・予測集合・決定表の行・Router の版）。発言の本文は足さない（`utterance_id` から会話の記録を読む）。保存期間は今の30日のままでよいが、評価データの元は失効の前に書き出す（§7.1）。

### 5.4 補正の計算

```text
z_i      : Router の生の点数（候補 i。CrossEncoder なら logit、判断モデルなら確率の log）
k(q, f)  : 今の query q と、訂正 f の query の embedding の内積
θ        : 近いとみなす線。評価データで「意図の違う発言の組が θ を超える割合 ≤ 1%」になる値
w(f)     = (k(q,f) − θ) / (1 − θ)        （k ≥ θ の訂正だけ。0〜1）
m_i      = β × Σ_f [ w(f)·1(i = right_f) − w(f)·1(i = wrong_f) ]，ただし |m_i| ≤ β
p_i      = softmax_i( (z_i + b_kind(i) + m_i) / T )
```

| 値 | 決め方 |
| --- | --- |
| θ | embedding の空間ごとに評価データで決める。今の e5 small の空間では、無関係の担当でも 0.85〜0.89 になる記録がある（迷ったら1位の設計 §5）ので、0.8 の線は使わない |
| β | 「近い発言1件の訂正で、Router の差 β 以内の順位を逆転できる」大きさ。評価データの副作用（§7.3）で決める |
| 衝突 | 近傍の訂正どうしで正解が違う → 補正をかけず、その発言は決定表 #8 へ。訂正の行を `conflict` にして確認の一覧へ |
| 撤回 | 利用者が訂正を取り消す・会話の記録から発言を忘れる → 行を `retracted` にするか消す。次の採点から効かない |

### 5.5 誤った一般化を防ぐ

| 危険 | 防ぎ方 |
| --- | --- |
| 1件の訂正が広く効く | 線 θ と上限 β。重みを動かさない |
| モデルが自分の選択で学ぶ | 正解はホストが確かめた利用者の操作とレビューだけ（§5.2） |
| 利用者の言い間違いを一般化 | 近傍の補正だけで、学習の版へは人の確認（`router-review`）を通った行だけを入れる |
| 実行の失敗を誤選択と取り違える | `outcome` を学習に使わない |
| 担当の改訂で意味が変わる | 訂正は担当の id で持ち、作った時の revision も残す。確認の一覧で古い revision の訂正を見られる |

### 5.6 担当の追加・改訂・削除

| 出来事 | 訂正の記憶 | 学習済みの版 |
| --- | --- | --- |
| 担当を足す | 訂正の各 query を新しい担当込みで採点し直し、新しい担当が正解より上なら `stale` 候補として確認の一覧へ（自動で書き換えない） | 再学習まで、新しい担当は説明文だけで採点される（cold start）。§3.8 の確認を通す |
| 担当を改訂（文の変更） | そのまま使う | そのまま。到達性の確認を通す |
| 担当を無効・削除 | `right_id` がその担当の行は `stale`（補正しない） | 次の学習で負例・正例から外す |

### 5.7 重みの学習・評価・反映・戻し

| 段 | 中身 |
| --- | --- |
| 材料 | 評価データの train、確認済みの訂正、`outcome: completed` の弱い正例（重み 0.3）。負例は同じ発言の予測集合の他の候補（hard negative）と、無作為の担当 |
| 学習 | (query, 候補の文) の組の二値の交差エントロピー。会話の候補も同じ組として学ぶ。担当の id は入力に入れない（文で学ぶ） |
| 評価 | 固定の test split（学習・校正に使わない、会話の単位で分けた集合）。§7.2 の指標のすべて。leave-one-toolchain-out を毎回 |
| 採用 | 今の版より Top-1 と担当ごとの最小 Recall が下がらない、誤起動率・見逃し率が上がらない |
| 反映 | LARM の版（head・calibration の revision。今の `system-one` と同じ扱い）として配備し、Eumenes は応答の版を選択の記録に残す。校正（T・b・τ）は版ごとに Eumenes の設定へ |
| 戻し | LARM で前の版に戻す。Eumenes は版を記録しているので、どの版の決定かを後から追える |
| 判断モデル（d1-2B）の場合 | 重みの学習は提供元の手順が出るまで行わない。持続の改善は、確認の一覧に出た誤りの組から担当の説明文を直す（新しい版、到達性の確認つき）ことと、校正（T・b・τ・δ）の学習し直し |

## 6 実装の構造

### 6.1 部品と責務

| 部品 | domain・ファイル | 責務 |
| --- | --- | --- |
| Router の候補 | dialogue `service/routed-candidates.ts`（新） | 有効な担当・読む道具・ホストの操作・会話から候補の集合と文を作る（今の `requestTurn` の候補作りと `choiceSchema` の枝の材料をまとめる） |
| Router の文 | capabilities（担当の文）、dialogue `contexts/local/router-*.context.toml`（会話・仕事・確認の文） | 候補の文。語句をコードに書かない |
| 採点の口 | inference（`route`）、larm（`system-one` の client） | 保存済みの Router の profile の `system-one` を claim し、今の意図判定と同じ `larm.system-one.v1` の choice で、候補ごとの criteria を送って確率を受け取る。今の client の「決まったラベルだけを受ける」検査（`larm/service/context.ts`）は、Router の口では送った criteria の集合と照合する。profile・model の名前を持たない |
| 決定 | dialogue `service/routed-route.ts`（新） | 校正、訂正の補正、決定表、記録 |
| 訂正の記憶 | toolchain-history `service/feedback.ts`（新）、`repository`（表） | 書込み（ホストの操作から）、近傍の読み、撤回、確認の一覧 |
| 欄を埋める呼出し | dialogue `routed-choice.ts`（今の `choiceSchema` を1候補に絞る） | 即答・パイプライン・読む道具・記憶・作品のある担当の欄 |
| 確認の道具 | `scripts/router-bench/`（新）、`GET /api/toolchains/search-check` の拡張 | 評価・到達性・回帰 |

### 6.2 型

```ts
/** One thing the router may send the turn to (spec toolchain-router-redesign 2026-11-01 §3.2). */
type RouteCandidate =
	| { kind: "conversation"; id: "conversation.respond"; passage: string }
	| { kind: "toolchain"; id: string; revisionId: string; passage: string;
			execution: ToolchainExecution; general: boolean; minImpact?: Impact }
	| { kind: "read"; id: string; passage: string }
	| { kind: "memory"; id: "memory.request"; passage: string }
	| { kind: "work"; id: `t${number}.${"check" | "amend" | "cancel"}`; passage: string }
	| { kind: "redirect"; id: `t${number}.redirect:${string}`; toolchainId: string; passage: string }
	| { kind: "pending"; id: `c${number}.${"approve" | "decline"}` | `t${number}.answer`; passage: string };

/** The LARM router's answer (a system-one choice): a probability for every criterion sent, by its name. */
type RouteAnswer = {
	choice: string;
	probabilities: Record<string, number>;
	revision: string; // routing.head_revision
	model: string;
};

type RouteDecision =
	| { row: 1 | 7; to: "conversation" }
	| { row: 2 | 3 | 4 | 5 | 6; to: RouteCandidate; announce: "fixed" | "confirm" }
	| { row: 8; to: "choice"; shortlist: RouteCandidate[] }
	| { row: 9; to: "legacy" };

/** What the selection record keeps of the router (no utterance text). */
type RouterTrace = {
	revision: string;
	candidates: Array<{ id: string; raw: number; bias: number; correction: number; p: number }>;
	set: string[];        // the prediction set (alternatives offered for correction)
	row: RouteDecision["row"];
	durationMs: number;
};
```

### 6.3 疑似コード

```ts
async function routeTurn(turn: Turn): Promise<Step> {
	if (turn.session || turn.pinned) return "direct"; // the host knows where it goes
	const candidates = routeCandidates(turn);          // §3.2
	const state = routerState(turn);                   // §3.2 literal form
	const [answer, near] = await Promise.all([
		turn.deps.inference.route(
			state,
			Object.fromEntries(candidates.map((c) => [c.id, c.passage])),
			turn.signal,
		),
		turn.deps.feedback.near(state.text, turn.signal), // embedding k-NN, θ cut
	]).catch(() => [undefined, []]);
	if (!answer) return legacyRequestTurn(turn);        // row 9
	const p = calibrate(answer.probabilities, candidates, correction(near, candidates)); // §5.4
	const decision = decide(p, candidates, turn.settings.router);                       // §3.3
	recordTrace(turn, decision, p, answer.revision);
	switch (decision.to) {
		case "conversation": return "talk";
		case "choice": return requestTurn(turn, decision.shortlist); // today's choice call, 3 candidates
		case "legacy": return legacyRequestTurn(turn);
		default: return carryOutRouted(turn, decision);  // fill call if the candidate needs inputs
	}
}
```

### 6.4 今のコードの変更・削除

| ファイル | 変更 | 段階 |
| --- | --- | --- |
| `dialogue/service/routed-turn.ts` | `runRoutedTurn` の振り分けを `routeTurn` に替える。Ruri の判定は R4 で消す | R2・R4 |
| `dialogue/service/routed-steps.ts` | `requestTurn` は fallback（上位3件）と欄を埋める呼出しの入口にする。`pendingTurn` は Router の候補（確認・質問）に吸収 | R2・R3 |
| `dialogue/service/routed-choice.ts` | `choiceSchema` に候補の絞込み（1件・3件）。多候補の枝は fallback だけで使う | R2 |
| `dialogue/contexts/local/choice.context.toml` | 優先順位の決まり（パイプラインを先に、汎用は最後に、1位を選ぶ）を消す。校正の偏りと学習へ移す | R4 |
| `dialogue/service/executor-search.ts` | `find` は Router の候補作りと記録に置き換える（担当探しの段として残る） | R2 |
| `capabilities/service/toolchains.ts` | `slotted`・`CANDIDATE_SLOTS` を消す。担当の Router の文（`routerPassage`）を足す。Embedding の索引は残す | R4 |
| `toolchain-history/service/selections.ts` | `similarSelectionsInTransaction`（0.8 の線）と `fromHistory` を、訂正の記憶の近傍に替える。`router_json` の欄 | R3 |
| `dialogue/service/intent-gate.ts`、`settings` の `intent`、`dialogue_intent_judgments` の書込み | 消す（R4 の条件を満たしたとき）。表の行を消すかは利用者が決める | R4 |
| `inference`・`larm` | `route` の口（`system-one` の choice、呼出しごとの criteria）。Router の profile を設定（SQLite）に保存 | R1 |
| `docs/toolchain.md` | 候補の提示の RRF の記述を実装に合わせる（今すぐ直せる食い違い） | R0 |

## 7 実用性を確かめる PoC

製品の経路に入れず、評価専用の script（[判断モデルのベンチマーク](decision-model-benchmark-design.md) と同じ作り）で測る。LARM での測定は利用者の合図の後。

### 7.1 評価データ

| 区分 | 例（評価データの書き方の例。学習・prompt に入れる例文ではない） | 件数 |
| --- | --- | --- |
| 雑談（担当の話題を含む） | 「音楽っていいよね」「昨日の雨すごかったね」「その絵、好きだな」 | 80 |
| 単独の依頼（担当ごとに6件以上） | 「明日の横浜の天気は？」「3分のタイマー」 | 190 |
| 紛らわしい組 | 作曲／再生、画像／3D、Web検索／天気・株価、UI制作／画像、手順づくり／タイマー | 60 |
| 指示語・前の仕事の続き | 「じゃあこれにぴったりな画像も作って」「さっきのをもう少し明るく」 | 40 |
| 仕事への返答 | 「さっきのどうなった？」「やっぱりやめて」「もっと短くして」 | 40 |
| 訂正 | 「違う、作曲してほしい」「そっちじゃなくて検索して」 | 30 |
| 複数工程 | 「茹で時間を調べてタイマーをかけて」 | 30 |
| 確認・質問への答え | 「はい」「いいえ、新しく作って」「3番目のやつ」 | 30 |
| 担当のない依頼 | 「部屋の電気を消して」 | 20 |

出所: 選択の記録・意図判定の記録の発言（233件に発言の id がある）を、会話の記録から読み、利用者が正解を付ける（モデルの選択を正解にしない）。足りない区分は人が書く。担当の `examples` の写しは入れない。発言の本文は Git 管理外（`verification-reports/` の外の `data/`）に置く。選択の記録は30日で消えるので、R0 の最初に書き出す。

1件の形（JSONL）:

```json
{"id":"music-03","group":"conv-7f2a","split":"test","previous_agent":"曲を流しますね。","previous_user":"コーヒータイムにぴったりな音楽をつくって","utterance":"違う、作曲してほしい","state":{"todos":[{"ref":3,"title":"コーヒータイムの曲","toolchain":"music.library","open":true,"minutesAgo":1}],"pending":[]},"gold":{"primary":"t3.redirect:music.create","acceptable":["music.create"]},"tags":["correction","confusable:music"]}
```

split は会話（`group`）の単位で train・calibration・test に分け、test は固定する。

### 7.2 指標

| 指標 | 定義 |
| --- | --- |
| Recall@K | 正解が上位K件（K=1,3,5）に入る割合。検索で絞る方式は「絞込みの Recall@K」と「絞込みに入ったときの選択の正しさ」を分けて出す（正解が候補に出なかった誤りと、誤った候補を選んだ誤りを分ける） |
| Top-1 Accuracy | 決定が `primary` か `acceptable` に入る割合 |
| 担当ごとの Recall | 担当ごとの Top-1。最小値を必ず出す |
| False Dispatch Rate | 正解が会話の発言のうち、担当・操作に渡した割合 |
| 見逃し率 | 正解が担当・操作の発言のうち、会話の回にした割合 |
| 不要な fallback 率 | fallback（#8）に送った回のうち、Router の1位が正解だった割合 |
| 選択の時間 | Router の往復と採点の P50・P95（warmup 10回の後）。段2を含む回の合計も |
| 訂正からの回復率 | 訂正を1件入れた後、同じ・言い換えの発言（評価データの対の片方）が正しく振り分けられる割合 |
| 訂正の副作用 | 訂正を入れる前後で、test の無関係な発言の決定が変わった割合 |
| 担当の追加の回帰 | leave-one-toolchain-out: 1担当を学習から外して登録し直したときの、その担当の Recall@1（cold start）と、ほかの担当の Recall@1 の変化 |
| 資源 | ロード時間、RSS、CPU 時間、同時に会話 LLM を動かしたときの会話の token/s の変化 |

### 7.3 比べる方式

| 記号 | 方式 | モデル |
| --- | --- | --- |
| 基準0 | モデルなし: FTS（trigram、今の `capability_search`）の1位 | なし |
| 基準1 | 今の検索の1位（Embedding の最大内積） | 今の embedding |
| A | 今の選ぶ呼出し（今の候補で再現） | 会話の LLM（利用者の合図の後。クラウドの会話モデルと LARM を分けて記録） |
| B | Embedding 上位12件 → Reranker | §4 の候補 |
| C／U | 全候補 Reranker（追加学習なし／あり）、会話の候補あり・なし、訂正の補正あり・なし | §4 の候補 |
| R | Ruri の2択の振り分け（今）と U の会話の判定 | 今の Ruri |
| D | 判断モデルの統合（学習なし。会話・担当・仕事・確認を1回で選ぶ） | d1-2B |

### 7.4 手順

| # | すること | 合否の基準 |
| --- | --- | --- |
| 1 | 評価データ 400件以上を作り、利用者が正解を確認する | 区分ごとの件数を満たす |
| 2 | 基準0・基準1・学習なしの C（xsmall-v2・ruri-v3-reranker-310m）・D（d1-2B）の精度を、評価専用の process で測る（製品の LARM を呼ばない） | C か D の Top-1 が基準1 より 10 ポイント以上高ければ次へ。D は雑談の誤起動率・見逃し率も R と比べる |
| 3 | AI MAX+ 395 の CPU（評価専用の process）で、残った方式の速度と資源を測る。会話 LLM を動かしたまま測る。D は前置きの再利用の有無を分ける | 全件の採点の P95 ≤ 1.5 s、会話の token/s の低下 ≤ 5% |
| 4 | C なら train で学習し、どちらも calibration で T・b・τ・δ を決め、test で測る | 誤起動率・見逃し率が R 以下、Top-1 が A 以上（A は測れた場合） |
| 5 | 訂正の回復率・副作用・leave-one-out を測る | 回復率 ≥ 90%、副作用 ≤ 1%、cold start の Recall@1 ≥ 70% |

## 8 移行の段階

| 段 | 中身 | 受入の条件 | 戻す条件 |
| --- | --- | --- | --- |
| R0 | 評価データの書き出しと正解付け。`docs/toolchain.md` の食い違いを直す。PoC（§7.4 の1〜3） | §7.4 の2・3 | C が基準1 より良くならない → この設計を止め、A の最適化に戻る |
| R1 | LARM に Router の profile（`system-one`、呼出しごとの criteria。中は §7 で選んだモデル）を足し、Eumenes の `route` の口を作る。今の経路のまま shadow で採点し、`router_json` に記録する | shadow の失敗率 < 1%、P95 ≤ 1 s、回の時間が増えない | 回の時間が増える・失敗が多い → shadow を切る（設定） |
| R2 | 依頼の回で Router が決める（決定表 #2〜#9）。Ruri はそのまま。頼み方の欄を担当側へ（§3.4）。fallback は上位3件の選ぶ呼出し | 評価データで Top-1 が A 以上、依頼の回の時間の中央値 ≤ 3 s（欄を埋める呼出しのない担当）、fallback 率 ≤ 15% | 実会話で誤選択の訂正が週あたり R1 の shadow の予測より多い → 依頼の回を今の選ぶ呼出しへ戻す（設定） |
| R3 | 訂正の記憶、`t<n>.redirect`、画面の「担当を変える」、確認・質問を Router の候補へ。Ruri の `chat` を特徴に | 訂正の回復率 ≥ 90%、副作用 ≤ 1% | 副作用が出る → 補正を切る（β=0）。記憶の行は残す |
| R4 | 会話の候補を学習した版で、Ruri なしの判定を測る。劣らなければ意図判定の口・設定・枠・`similarSelections`・選ぶ呼出しの system の優先順位を消す | §3.6 の「劣らない」 | 劣る → Ruri を特徴として残す（R3 の形で止める） |
| R5 | 再学習の流れ（§5.7）を回す。担当の登録に到達性の確認 | 版ごとの評価が採用の条件を満たす | 版を戻す |

各段で、設定で戻せる切替（`router.mode`: `off`・`shadow`・`request`・`unified`）を SQLite に置き、R4 の後に `off`・`shadow` の分岐を消す。

## 9 測っていないこと・確かめていないこと

| こと | 状態 |
| --- | --- |
| Reranker の Eumenes の担当での精度 | 未測定。§7 で測る |
| AI MAX+ 395 の CPU での Reranker の速度・メモリ | 未測定。§4 は公開値と理論推定 |
| 欄を埋める呼出し（1候補）の LARM での時間 | 未測定。考える分が短くなるかは分からない |
| 今の catalog の embedding モデル | 10-12 の記録（多言語 e5 small、384次元）から変わっていないかを確認していない |
| LARM の Router の profile | LARM 側の実装が要る（このリポジトリの外）。今の `system-one` が呼出しごとに変わる criteria（33〜44件）を受けるかは未確認 |
| d1-2B | 選択肢の数の上限、日本語の振り分けの精度、CPU の速さ、`/v1/systemone` の入力の並び（候補の説明の前置きを再利用できるか）、学習の手順は、どれも公開情報にない。公開から5日 |
| ruri-v3-reranker-310m の CPU の速さ | 推定の幅が 10倍以上ある（§4.4） |
| 選ぶ呼出しの時間 | ログの、`dialogue.choice_made` の直前の推論の試行の時間から取った概算。考える分と出力の内訳は見ていない |

## 10 出典（モデル・実行環境、2026-11-01 に参照）

| 対象 | URL |
| --- | --- |
| d1-2B | https://huggingface.co/LiquidAI/d1-2B 、https://huggingface.co/LiquidAI/d1-2B-GGUF 、https://huggingface.co/LiquidAI/d1-2B/blob/main/LICENSE 、https://github.com/ggml-org/llama.cpp/pull/31275 、https://www.liquid.ai/blog/open-d1 |
| ruri-v3-reranker-310m | https://huggingface.co/cl-nagoya/ruri-v3-reranker-310m |
| hotchpotch v2 | https://huggingface.co/hotchpotch/japanese-reranker-xsmall-v2 、https://huggingface.co/hotchpotch/japanese-reranker-tiny-v2 、https://secon.dev/entry/2025/05/08/100000-japanese-reranker-v2/ |
| Qwen3-Reranker-0.6B | https://huggingface.co/Qwen/Qwen3-Reranker-0.6B 、https://github.com/ggml-org/llama.cpp/pull/15824 |
| laya-multilingual | https://huggingface.co/convaiinnovations/laya-multilingual 、https://github.com/NandhaKishorM/laya |
| LFM2.5 Encoder・Prompt-Router | https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M 、https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Prompt-Router |
| ruri-v3 embedding | https://huggingface.co/cl-nagoya/ruri-v3-310m |
| bge-reranker-v2-m3・jina | https://huggingface.co/BAAI/bge-reranker-v2-m3 、https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual 、https://huggingface.co/jinaai/jina-reranker-v3 |
| llama.cpp の reranking | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md 、https://github.com/ggml-org/llama.cpp/pull/18330 |
| onnxruntime-node と Bun | https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md 、https://github.com/oven-sh/bun/issues/30286 、https://github.com/oven-sh/bun/pull/30291 |
| ONNX Runtime の ROCm・MIGraphX・Vitis AI | https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html 、https://rocm.docs.amd.com/en/latest/about/release-notes.html 、https://github.com/blakeblackshear/frigate/discussions/24245 、https://ryzenai.docs.amd.com/en/latest/linux.html |
| CrossEncoder の CPU の値 | https://qdrant.tech/blog/oxidizing-cross-encoders/ 、https://sbert.net/docs/cross_encoder/usage/efficiency.html |
