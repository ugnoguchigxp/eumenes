# ツールチェーンごとの打ち切り時間 設計

作成日: 2026-10-18

状態: 合意済み（2026-10-18、T1〜T6とも推奨どおり）・実装済み。fixture試験済み、live・実機の受入は未了。実装の記録は§7。

関連: [一回推論の下書きと定義の補正](ui-studio-one-shot-draft-design-2026-10-18.md)、[表現力拡張](ui-studio-expressive-parts-implementation-plan-2026-10-17.md)

## 1 背景と目的

UI自由制作の専門担当は、1回の推論に33〜38秒かかり、作り直しが重なると1ターンの上限120秒で打ち切られた（`specialist_turn_timeout`）。出力上限を24kトークンに広げた（2026-10-18）が、実測の生成速度（毎秒約64トークン）では24kトークンに約6分かかり、時間の上限が先に効く。

利用者の方針（2026-10-18）:

- 120秒で打ち切らなくてよい。
- UI自由制作に限らず、長い思考や長いトークン生成に時間のかかるタスクはある。
- 打ち切り時間をタスクごとに設定できる仕様にする。

## 2 現行の時間制限

どの値も、ツールチェーンやbundleのデータからは決まらない。

| 名前 | 値 | 場所 | 対象 |
| --- | --- | --- | --- |
| run全体（`DEFAULT_DEADLINE_MS`） | 180秒 | `dialogue/service/context.ts`、`intake.ts` | 受付から完了まで。queueのjobの期限、会話側の推論要求の期限、音声の待ち時間がここから決まる。専門担当や後続のjobも同じ`run.deadlineAt`を引き継ぎ、新しい持ち時間は得ない |
| 専門担当の1ターン（`TURN_BUDGET_MS`） | 120秒 | `dialogue/service/specialist-core.ts` | 専門担当の1ターン（最大6回のモデル呼出しと操作）。`min(120秒, run期限までの残り, sessionの期限までの残り)`。超えると`specialist_turn_timeout` |
| 推論1回（`attemptDuration`） | LARM 120秒、クラウド60秒 | `inference/service/attempt-work.ts` | 1回の推論の試行。サブエージェント用のリソースを保存していれば専門担当はクラウド経路で、60秒が先に効く |
| 推論要求の期限 | `min(呼出し側の期限, 会話側の推論要求の期限)` | `inference/service/index.ts`の`captureControlInTransaction` | 専門担当の各推論 |
| 音声の待ち | run期限までの残り＋10秒 | `voice-dialogue/service/respond.ts` | 音声のターンがrunの返答を待つ時間。超えるとrunを取り消し`dialogue_wait_timeout` |
| ツールチェーンの指示の推論 | `run期限−15秒` | `dialogue/service/toolchain-command.ts` | 通常担当がツールチェーンを操作する1回の推論。2026-10-31の改修で45秒の上限を外した。LARMの準備上限60秒より先に打ち切らないため（[改修記録](model3d-command-readiness-fix-2026-10-31.md)）。会話全体の期限は延ばさない |
| 調査の作業 | 作業150秒、1手45秒 | `agent-runtime/service/exploration.ts` | 調査系。根はrunの180秒 |

変えないもの: queueのlease（30秒、10秒ごとに更新する生存確認で、長さの上限ではない）、LARMの通信の見張り（300秒）。ただし§3の推論の上限が300秒を超える場合、見張りもその値に合わせる（§3.4）。

## 3 新しい仕様

### 3.1 ツールチェーンの定義に時間の設定を持つ

bundleの`toolchain`定義（`ToolchainRuntimeMeta`）に、任意の`timeLimits`を加える。

```json
"timeLimits": { "runMs": 1200000, "turnMs": 900000, "inferenceMs": 600000 }
```

| 項目 | 意味 | 無いとき |
| --- | --- | --- |
| `runMs` | このツールチェーンに渡ってからrunが終わるまで | 180秒（現行） |
| `turnMs` | 専門担当の1ターン | 120秒（現行） |
| `inferenceMs` | 1回の推論の試行（LARM・クラウドとも） | LARM 120秒・クラウド60秒（現行） |

- 契約で範囲を検証する。各値は10秒以上、上限はT2で決める。`inferenceMs ≤ turnMs ≤ runMs`。
- `timeLimits`の無いツールチェーンは、すべて現行どおり。
- 時間の値はデータ（bundle）にだけ書き、コードに個別のツールチェーンの値を書かない。

### 3.2 runの期限を延ばす時点

- 通常担当がツールチェーン（専門担当の開始を含む）を選んでrunを渡した時点で、`run.deadlineAt`を`max(現在の期限, 現在＋runMs)`に延ばす。延ばすだけで、縮めない。
- 同じトランザクションで、queueのjobの期限と会話側の推論要求の期限を同じ値に延ばす。推論要求の期限を延ばす公開操作をinference domainに加える（`extendDeadlineInTransaction`。保留中・実行中の要求だけ、延長だけ）。
- 宛先が専門担当のまま次の依頼が来た場合（会話側を通らない）は、受付の時点で同じ規則を適用する。

### 3.3 専門担当の1ターン

- `TURN_BUDGET_MS`の代わりに、そのツールチェーンの`turnMs`（無ければ120秒）を使う。残りがrunの期限やsessionの期限で短ければ、短い方。
- 各推論要求に`inferenceMs`を持たせる（§3.4）。

### 3.4 推論の試行時間

- 推論要求（control）に任意の試行時間`attemptMs`を記録する。`attemptDuration`は、これがあればLARM・クラウドの既定値の代わりに使う。要求の期限までの残りが短ければ、短い方。
- LARMとクラウドの両方を試す経路では、既存の規則どおり、LARMの試行にはクラウドの分を残す。
- LARMの通信の見張り（300秒）は、`attemptMs`がそれを超える要求ではその値＋余裕に合わせる。

### 3.5 音声

- 音声の待ち時間は、延ばした`run.deadlineAt`にそのまま従う（既存の仕組み）。
- 待つ間に何も聞こえないことへの扱いはT4で決める。

### 3.6 記録

- 延ばしたときに`dialogue.deadline_extended`（`runId`、`toolchainId`、`runMs`）をinfoで記録する。
- `specialist_turn_timeout`と`deadline_exceeded`のログに、効いていた上限（`limitMs`）を添える。

## 4 UI自由制作の値

`ui-compositions.bundle.json`の`ui.compose`に、次を設定する（toolchain@9）。値はT5で決める。

- `runMs` 20分、`turnMs` 15分、`inferenceMs` 10分。
- 根拠: 出力24kトークンは約6分。指示（約9kトークン）の読み込みは11〜15秒。作り直しを1回含めても15分に収まる。

## 5 試験と受入

- 契約: `timeLimits`の範囲、大小関係、無いときの既定値。
- 期限の延長: ツールチェーンに渡した時点で`run.deadlineAt`・jobの期限・推論要求の期限が延びる。縮まない。宛先が専門担当のままの依頼でも延びる。
- 専門担当: `turnMs`で打ち切られ、無ければ120秒。各推論の`attemptMs`がLARM・クラウドの既定値に代わる。
- 音声: 延ばしたrunの返答を、120秒を超えても待って読み上げる（`specialist-voice.test.ts`を拡張、時計は偽装）。
- 文書: `docs/toolchain-extension.md`のtoolchain定義の項目表、`docs/logging.md`。
- 実機: UI自由制作で大きな初稿を依頼し、120秒を超えても打ち切られずに反映されること。

## 6 要合意事項

| ID | 論点 | 推奨 |
| --- | --- | --- |
| T1 | 時間の設定をどこに持つか | toolchain定義（`ToolchainRuntimeMeta`）。タスクの性質はツールチェーンが決めるため。profileやbindingには持たない |
| T2 | 上限 | 各値60分まで。止まった処理を永遠に待たないため、上限なしにはしない |
| T3 | 期限を延ばす時点 | ツールチェーンにrunを渡した時点（§3.2）。受付時点ではまだ行き先が分からないため |
| T4 | 音声で長く待つ間の扱い | 今回は追加しない。引き継ぎの告知（「制作担当に引き継ぎます」）は既にあり、画面に進み具合が出る。長い沈黙が気になれば別途「まだ作っています」の読み上げを検討する |
| T5 | UI自由制作の値 | run 20分・1ターン15分・推論10分（§4） |
| T6 | ほかのツールチェーン | 今回は設定しない（現行の値のまま）。調査系などは実測を見て個別に足す |

## 7 実装の記録（2026-10-18）

設計からの細部の変更（どれも§3の意図の範囲）:

- **置き場所**: data-drivenのツールチェーンでは`ToolchainRuntimeMeta`がbindingから作られるため、`timeLimits`はbindingの文書（bundleの`bindings[]`）に持つ。今回はsession bindingだけが受け付ける（T6のとおり、command toolchainなどは実測を見て足す）。UI自由制作は`binding:ui.studio@3`に書き、`toolchain:ui.compose@9`が参照する（同じrevisionで別作業の削除操作も追加されている）。
- **queueのjob**: 期限を延ばすのは専門担当のターンのjobを入れる直前なので、新しいjobは延ばした期限で入る。引き継ぎ元の会話側のjobは延ばさない（その場で終わるため）。queueに延長の操作は足していない。
- **推論要求**: 会話側の推論要求（`subject=runId`）の期限を、状態に関わらず延ばす（回答を採用した後も、専門担当の推論の期限の上限になるため）。
- **推論の試行時間**: 推論要求に`attempt_ms`の列を足した（`inference/0013-attempt-limit`）。LARMの通信の見張りは`max(300秒, attemptMs＋30秒)`。
- **推論の実行時の上限**: 実行時に要求の期限を「現在＋180秒」に切り詰める既存の上限は、`attemptMs`を持つ要求では`max(180秒, attemptMs)`にする（レビューで判明）。
- **音声の受付**: 音声のターンの推論要求は受付時に270秒の期限で作られ、runに結ばれるときに短い方になる。宛先が専門担当でrunの持ち時間を延ばした受付では、結んだ後に`extendDeadlineInTransaction`で延ばす（レビューで判明）。

実装した場所:

| 項目 | 場所 |
| --- | --- |
| 契約 | `capabilities/contracts/bindings.ts`の`timeLimitsV1`、`SpecialistSet.timeLimits`、`toolchain-routing.ts` |
| runの期限 | `dialogue/service/specialist-core.ts`の`extendRunForToolchain`（引き継ぎ時）、`specialist-intake.ts`の`sessionRunMs`（宛先が専門担当の受付時） |
| 1ターン | `specialist-turn.ts`（`turnMs`、時間切れのログ） |
| 推論 | `inference/service/index.ts`（`attemptMs`の記録、`extendDeadlineInTransaction`）、`attempt-work.ts`、`larm/service/provider-request.ts` |
| 音声 | `voice-dialogue/service/respond.ts`（延びた期限まで待ち直す） |
| 試験 | `capabilities/test/session-binding.test.ts`、`dialogue/test/specialist-turn.test.ts`、`inference/test/inference-control.test.ts`、`voice-dialogue/test/voice.test.ts` |
