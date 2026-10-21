# 会話の初動を2ラウンドに固定する（R1 要求分析→R2 回答または委譲）

> 2026-10-21追記: 使用済み関数の会話単位の保持と検索開始時点は、合意・実装済みの[保持設計](conversation-toolchain-context-retention-design-2026-10-21.md)で更新した。通常入力では保持関数を先に提示し、必要な場合だけ一度検索する。以下のR1/R2の委譲・採用契約は再利用する。


作成日: 2026-10-17

状態: 2026-10-17、§8の改訂（一時回答までの短縮）は実装・fixture済み、liveは未実施（§9）。H1〜H5は本文の表で決着。R1 `analyze_request` から R2 の回答または選定までの本体は実装し、fixture で確認した（§7）。日時の依頼、`past_conversation` から `history.research` を選ぶ受入、`impact=modify_existing` の記録受入、実モデルの live は未。確認の流れ（questionRef）は対象外のまま。

関連: [委譲前の一時回答](conversation-pre-delegation-response-design-2026-10-17.md)（§3・§5・§9）、[LLM経路リファクタリング](conversation-subagent-llm-refactoring-plan-2026-10-17.md)（§3.2・D8・D9）。

## 1. 背景（実利用で確認した事実）

- 2026-10-17、会話 `main` で「今日の鎌倉の天気を教えて」「明日の鎌倉の天気を教えて」に対し、担当探索をせず、10/13（JST）の回答本文を写して返した。runId `fbdfb455-0589-4dcd-ba67-88f8ab841475`、`6a2f238f-835b-4b6c-bd58-e0fda5da9ca7`。後者は17日に「明日（2026年10月14日）」と回答した。
- 両runともLLM呼び出しは1回。`toolchain.selection_recorded` は `decision:"answer"`、`candidateCount:0`、`retrieval:"none"`。
- 現行の初段（`generation-handler.ts` の `initial` 経路）は、`find_toolchain` だけを提示し、直接回答も同じ推論で生成する（[委譲前の一時回答 §3-1](conversation-pre-delegation-response-design-2026-10-17.md)）。初段の入力には、逐語履歴・要約・短期記憶・想起（prefetch）がすべて入る。
- 今回の初段の入力には、過去の天気回答が要約・短期記憶・想起に日付なしで入っていた。現在日時はない（`promptTime` は調査結果・専門担当・agent-runtime・toolchainコマンドのみ）。モデルは旧回答の古さを判断できず、それを写した。
- 同設計書 §9 は「担当探索の省略は未解決（18回中5回省略）」と記録している。`find_toolchain` の説明文の拡張でも今回改善しなかった。
- 依頼がライブ情報を要するかを判定する仕組みは製品経路にない。
- 保存済み会話を調べる担当 `history.research`（`capabilities/builtin/history.ts`、`history.search`・`history.read`）は既にある。

## 2. 方針

> 注: R1 の関数・引数・候補検索の時期は §8 の改訂で置き換えた（R1 前に候補検索、R1 は候補関数・`answer`・`report_unavailable` を共通引数 kind/freshness/impact/approved で呼ぶ）。§2〜§5 は改訂前の設計として残す。現行の正本は §8。

会話エージェントの初動を必ず2ラウンドにする。R1はユーザーの依頼を分析し、何を求めているかと問い合わせの種類を判断する非公開ラウンドで、回答文を作らない。ツールチェーン検索はR1の分析結果で行う。R2は、R1の判断に従って回答するか委譲する。履歴が必要な依頼は、Web調査と同じく担当（`history.research`）として扱う。

### R1 要求分析（毎ターン必須・非公開）

- **入力:** 役割（口調・音声の規則を含む会話用systemではなく役割文だけ）、現在の依頼、直前の1往復（H1決着。逐語のまま1つの参考データとして渡し、assistantターンとしては並べない）。長期記憶・逐語履歴・要約・短期記憶・想起・現在日時は渡さない（H2決着）。
- **出力:** 必須の関数 `analyze_request` を1回呼ぶ。自然文は採用しない。

| 引数 | 内容 |
| --- | --- |
| `goal` | 依頼の分析結果。利用者が何を知りたい・してほしいかを、対象と目的が分かる一文で書く。直前の1往復を受けた続きの依頼（「お願い」「それの明日は？」）は、補って完結した依頼にする。相対日時は解決せず原文の表現を残す |
| `deliverable` | 期待される成果の形（例：口頭の答え、根拠付きの調査結果、画像、操作の完了、過去発言の引用）。自由記述 |
| `kind` | 問い合わせの種類。`knowledge`（一般知識・説明）/ `live_info`（現在時点の外部情報。日付・時刻そのものを含む）/ `past_conversation`（保存済み会話の確認）/ `action`（操作）/ `creation`（制作）/ `chat`（雑談・相づち） |
| `freshness` | 答えが時間とともに変わり、現在時点の情報が必要か（`live` / `not_live`） |
| `conditions` | 依頼にある対象・場所・日時・数値を原文のまま列挙（相対日時は解決しない） |
| `missing` | 進めるために欠けている必須情報。なければ空 |
| `next` | `answer` / `clarify` / `find_toolchain` |

- **hostの整合検査（構造のみ）:**
  - `kind` が `live_info`・`past_conversation`・`action`・`creation`、または `freshness=live` のとき、`next` は `find_toolchain`。
  - `next=clarify` は `missing` が空でないときだけ。
  - 関数呼び出しなし・引数不正・上記違反は契約違反として既存の上限付き構造修復へ返す。語句による判定はhostに置かない。
- R1の結果はselection traceに記録する。記憶（Memory・World）には保存しない。ログには `kind`・`freshness`・`next` だけを出し、`goal`・`conditions` など依頼の内容は出さない。
- **分析結果の使い道:**
  - 候補検索の検索文は、現在の発言の原文（`delegate-conversation.ts:101` の `routing.query`）からR1の `goal` に変える。続きの依頼でも対象が検索に乗る。
  - R2には `goal`・`deliverable`・`conditions`・`missing` をhost記録として渡す。担当へ渡す依頼はこれと現在の発言から作る。命令の正本は現在の発言のまま（リファクタリング計画 §3.5）。

### 確認と提案（利用者方針）

- 実行できる依頼は、提案して返事を待たない（「画像を作りましょうか？」で止めない）。R2で担当を選び、一時回答で宣言し、そのまま実行する。
- `clarify` は必須情報が欠けて進められないとき。ただし委譲が必要な依頼（`live_info`・`past_conversation`・`action`・`creation`、または `live`）は `find_toolchain` に限られるため、その不足はR2の選定（担当の質問、または `report_unavailable`）で扱う。
- **既存のものを変える依頼は、実行前に確認する。** Claude Code・Codexへのコード改修、新機能の追加で既存機能を改修する依頼などが該当する。git resetなどで戻せる場合も確認する。削除・外部送信・公開など取り消せない操作も同じ。

R1の `analyze_request` のschemaに次の引数を定義する。**今回はschemaの定義とselection traceへの記録までとし、下記「確認の流れ」は実装しない（利用者指示）。** 今回の実装では `impact` による実行の停止・確認は行わず、既存の挙動のまま実行する。

| 引数 | 内容 |
| --- | --- |
| `impact` | `none`（答える・調べる・参照するだけ）/ `create`（新しい成果物を作るだけで既存を変えない。画像生成など）/ `modify_existing`（既存の機能・コード・データ・設定・保存物を変える）/ `irreversible`（削除・外部送信・公開など取り消せない） |
| `approved` | 直前のアシスタント発言が同じ内容の実行確認で、現在の発言がそれへの承認か（`true` / `false`） |

確認の流れ（将来の実装。今回は対象外）:

1. R1が `impact` を `modify_existing` または `irreversible`、`approved=false` と判断した場合も、候補検索とR2の選定は通常どおり行う。何をどの担当で変えるかを具体的に示すため。
2. R2は選んだ関数を呼ぶが、`announcement` ではなく確認文 `confirmation`（変更する対象と内容、戻せるかを短く述べ、実行してよいか尋ねる一文）を持たせる。hostは担当を起動せず、確認文を返答として配信し、選定した関数・版・依頼を未回答の確認として保存する。保存は既存の未回答質問（`OpenQuestion` の `questionRef`・`functionName`、`interaction-runs.ts`）の再利用を実装の最初に検討する。
3. 次のターン、R1は直前の1往復から承認かどうかを判断する（`approved`）。承認なら、R2は保存済みの確認を `questionRef` で参照して同じ関数を呼び、`announcement` で宣言して実行する。取消・内容の変更なら、新しい依頼として分析し直す。
4. hostの整合検査：`impact` が `modify_existing`・`irreversible` で、承認済みの `questionRef` がない関数呼び出しは実行しない（構造の検査。語句では判定しない）。確認の版・権限・期限が失効していれば実行せず、確認からやり直す。

bindingの `effect`（write/local/navigate/draft）は不可逆性や既存への影響を表さないため、今回は判定に使わない。担当ごとに確認の要否を登録定義で宣言する方式は、必要になった時点で別途相談する。

### ラウンドとLLM呼び出し

| 段階 | LLM | 内容 |
| --- | --- | --- |
| R1 | 1回目 | `analyze_request` の関数呼び出し（上記） |
| R1→R2の間 | なし | `next=find_toolchain` のとき、hostがR1の `goal` を検索文として候補検索（`routeInTransaction`）を行い、登録済みツールチェーンから候補を得る |
| R2 | 2回目 | `answer`/`clarify` は回答生成。`find_toolchain` は**ツールコール**（担当の関数呼び出し） |
| R2の後 | なし | 一時回答の配信→担当の起動 |

### R2

- `answer` / `clarify`: 既存の回答生成で回答する。入力は現行の会話コンテキスト（履歴を含む）に、R1の `goal`・`deliverable`・`kind`・`conditions`・`missing` をhost記録として加える。R1で非ライブと判断済みの依頼だけがここに来るので、履歴の旧回答を現在の外部状態として写す経路はない。
- `find_toolchain`: R2は候補を関数として提示した**ツールコール**のラウンドとする。
  1. LLMは候補の関数を一つ呼ぶ。同じ呼び出しで、担当へ渡す依頼と一時回答（必須 `announcement`、`conversation-tools.ts` の `announcementSchema`）を作る。一時回答は選んだ担当の作業を表す短い一文（例：Web調査なら「お調べします」、画像生成なら「画像生成の準備をします」）。固定文の対応表は作らない。
  2. 依頼を満たせる候補がない場合は、関数 `report_unavailable`（不足の短い説明）を呼ぶ。候補が0件のときも、`report_unavailable` だけを提示してR2を呼ぶ（固定文は作らない）。
  3. R2の自然文は採用しない。関数呼び出しなし・未知の関数・引数不正は既存の上限付き構造修復へ返し、連続違反は失敗とする。
  4. hostが選定と一時回答を検査し、一時回答を保存・配信する。音声の自動読み上げ時は再生完了を待つ（`operation-announcement.ts`）。その後に担当を起動し、結果を伝える回答または完全切替へ進む。予告から起動までLLM呼び出しは追加しない。
  - 担当が決まる前に一時回答を出さない。過去の発言の確認では `history.research` が候補になる。
  - 現行の「選定で関数が呼ばれなければ、履歴付きで改めて回答を生成する」経路（`generation-handler.ts` の `selectionMessages && answerMessages`）は、委譲の省略になるため削除する。

### 現在日時

会話エージェント（R1・R2）には渡さない。現在日時が要るのはライブ情報を取得する段階からで、そこでは既存どおり渡っている。

| 段階 | 現在日時の受け取り（既存） |
| --- | --- |
| Web調査のサブエージェント（agent-runtime） | 各ステップの状態データ `now`（`agent-runtime/service/context.ts:117`） |
| 調査結果を伝える回答 | `dialogue/service/research-result-context.ts:45` |
| 専門担当 | `dialogue/service/specialist-prompt.ts:227` |
| toolchainコマンド | `dialogue/service/toolchain-command.ts:104` |

これでD9は(b)（通常会話に渡さない）で決着とする。日付・時刻そのものを聞く依頼は `live_info` としてWeb調査へ委譲し、サブエージェントが受け取っている現在日時で答える（§6 H3）。

## 3. 変更範囲

| 対象 | 変更 |
| --- | --- |
| `dialogue/service/initial-decision.ts` | `find_toolchain` を `analyze_request` に置き換え、引数schemaと整合検査を持つ |
| `dialogue/service/conversation-generation.ts` | R1で `analyze_request` を必須にし、自然文を採用しない |
| `dialogue/service/delegate-conversation.ts`・`selection-trace.ts` | 候補検索の検索文（`routing.query`）をR1の `goal` にする。R1の入力を組み立てる（履歴層・現在日時を除き、§6の範囲だけ）。R2の回答入力にR1の結果を加える。traceに記録 |
| `dialogue/service/generation-handler.ts` | R1の結果で回答生成または `generateSelection` へ分岐。選定後に関数呼び出しがない場合の回答生成を削除 |
| `dialogue/service/conversation-tools.ts` | R2の候補に `report_unavailable` を加える。|
| （今回対象外）`conversation-tools.ts`・`interaction-runs.ts` | `confirmation` 引数と確認待ちの保存・照合 |
| 試験 | `find_toolchain` 前提のfixtureを移す。§5の受入場面を追加 |

旧 `find_toolchain` と、初段で自然文の直接回答を採用する経路は削除する。互換経路は残さない。担当選び・委譲後の回答の入力は今回変えない。

## 4. 影響

- 直接回答のLLM呼び出しは1回から2回へ増え、音声の初回応答は遅くなる。委譲時は予告まで2回（R1と選定）で、リファクタリング計画 §3.2 の目標「2回以内」と同じ。
- R1は履歴層と毎ターン変わる値を持たないため短く、現在の依頼より前は会話を通して同じに保てる。
- 候補検索の検索文がR1の言い換えになるため、R1が依頼を誤って言い換えると、誤った候補が出る。リファクタリング計画 §3.2 は「検索は現在の発言だけを使う」分離を意図していた。今回は利用者の指示で、分析結果を検索に使う方へ変える。
- 過去の会話を前提にした質問（「さっきの店の名前は？」など）は `history.research` への委譲になり、遅くなる。
- §9に記録した「初段を別のJSON判定にする試作」は、不適切な確認質問と省略を残して不採用になった。今回は、履歴を渡さない、種類と鮮度を個別の必須項目にする、`clarify` を `missing` がある場合に限る、hostが整合を検査する、の4点が異なる。それでも省略や不要な確認が残れば、指示の追記を繰り返さず結果を記録して再検討する。

## 5. 受入

| 場面 | 合格条件 |
| --- | --- |
| 今日・明日の天気、株価、ニュース | R1が `live_info`・`live`・`find_toolchain`。予告→調査→根拠付き結果。過去回答を写さない |
| 履歴に同じ質問の旧回答がある会話 | 上と同じ（R1は旧回答を見ない） |
| 「今日何日？」「今何時？」 | R1が `live_info`。Web調査のサブエージェントが状態の `now` で答える |
| 一般知識・雑談 | R1が `knowledge`/`chat`・`answer`。R2で回答。候補検索・予告・担当起動なし |
| 「前に何て言った？」など | R1が `past_conversation`・`find_toolchain`、`history.research` が選ばれる |
| 「鎌倉の天気は？」→「明日は？」 | 直前の1往復から `goal` を「鎌倉の明日の天気」と補い、`live_info` で委譲 |
| 「画像を作って」 | `impact=create`。「作りましょうか？」と提案して待たず、選定→「画像生成の準備をします」→実行 |
| 「この画面に機能を追加して」（Claude Code・Codex） | R1が `impact=modify_existing` を返し、traceに記録される（確認の流れは今回対象外） |
| 必須情報の不足（自分で答える依頼） | R1が `missing` を挙げ `clarify`。R2で確認を一つ返す |
| 必須情報の不足（委譲が必要な依頼） | R1は `find_toolchain`。不足はR2の選定で担当に渡すか `report_unavailable` で説明する |
| R1の契約違反 | 1回の修復。連続違反は失敗として返し、回答を公開しない |
| R2で関数を呼ばず自然文で答えた | 採用せず1回の修復。連続違反は失敗。履歴付きの回答生成へ進まない |
| 依頼を満たす候補がない | `report_unavailable` で不足を説明し、一時回答を出さない |

検証は `bun run verify -- --domain dialogue` と影響する利用側domain。実モデルは会話 `main` 相当の長い履歴で、天気（今日・明日）・株価・日時・一般知識・過去発言の確認・制作・応答の続きを各複数回測り、R1の判断・呼び出し回数・初回応答時間を変更前と比べる。fixture・live・実機器は分けて記録する。

## 6. 要合意事項

| ID | 論点 | 選択肢 |
| --- | --- | --- |
| H1 | R1に直前の1往復を渡すか | 決着：渡す。音声では「明日は？」のような続きの依頼が多く、原文だけでは `goal` を作れないため |
| H2 | R1に長期記憶を渡すか | 決着（利用者指示）：渡さない。R2は既存どおり長期記憶を受ける |
| H3 | 日付・時刻そのものの依頼 | Web調査のサブエージェントへ委譲（利用者指示）。サブエージェントは状態の `now` を持つが、現行SKILLは根拠sourceIdを求めるため、検索なしで日時を答えられるかを受入で確認し、できなければSKILLの改訂を別途相談する |
| H4 | 担当の未回答質問への返事をR1でどう扱うか | 決着：現状維持。R1は直前の1往復で判断する。担当側が既定値で進められる質問はしない方針（例：タイマーは時間がなければ3分で開始。タイマー担当の改訂で対応） |
| H5 | R2の担当選びに口調を渡すか | 決着：渡さない。担当選びに余計な入力を足さない |

## 7. 実施記録（2026-10-17）

コードと固定試験を照合した。live は未実施。

実装済み（fixture）:
- R1 は `api/domains/dialogue/service/request-analysis.ts` と `initial-decision.ts`。入力は役割、直前の1往復、現在の依頼。`analyze_request` の schema は goal、deliverable、kind、freshness、conditions、missing、next に加え、impact と approved を持つ。
- 指示は `api/domains/dialogue/contexts/request-analysis/`。R2 の分岐は `generation-handler.ts`。
- 試験は `api/domains/dialogue/test/request-analysis.test.ts`、`analysis.fixture.ts`、`api/application/toolchain/analysis-round.fixture.ts`。ライブ情報の委譲、履歴の旧回答が R1 に入らないこと、続きの依頼の goal 補完、一般知識の直接回答、missing があるときだけの clarify、契約違反の修復、候補0の `report_unavailable` を見ている。

未了:
- 「今日何日？」が `live_info` になる受入試験はない。
- `past_conversation` が `history.research` を選ぶ試験はない。能力の登録自体は別にある。
- `impact=modify_existing` は schema と指示までで、記録の受入試験はない。
- 実モデルと長い履歴での live は、本書にも検証記録にもない。

## 8. 改訂: 一時回答までの短縮（2026-10-17、利用者合意）

### 2026-10-21 の調整（利用者合意済み）

埋め込み要求の同時実行が固定client名で同じConnectionを取得し、先に終わった要求のDELETEで残る要求が401になることを実接続で再現した。要求ごとに固有のclient名を発行し、それぞれが確保したConnectionだけを解放する。候補検索・和集合・取得失敗時の既存フォールバックは変えない。

R1共通引数 kind/freshness/impact/approved の説明を共通SystemContextへ移す案も比較したが、schemaから説明を除く案と短く残す案の両方で実モデルの分類・承認の退行が見られたため不採用とし、指示とschemaを元に戻した。採用する製品差分は接続識別名の分離だけとする。回答側の記憶・履歴、2ラウンドの構成、判断方式・優先順位は変更しない。

完了条件: 部分試験で並列要求の正常終了・取消後にも他方の認証が有効なことを確認する。利用側を含むverifyと、サーバーを起動しない実接続の接続分離試験を行い、fixtureとliveの結果を分けて記録する。担当外の失敗は修正せず報告する。

- fixture: 修正前は先に終わる要求が正常終了・取消のどちらでも他方が401。修正後は両ケースとも他方が成功し、それぞれの接続を解放する。
- live: 修正前は同じ接続で200/401、要求ごとの識別名では別接続で200/200。修正後の製品経路でも、1件目を解放してから2件目を送って200/200・両接続の解放を確認した。
- 説明削減の比較は通常候補3件、同じ5入力、既存のR1生成・検証を使用。全面共通化では承認のない雑談・新規操作でapproved=true、短い説明を残す案でも新規操作でapproved=true等が発生。サイズだけを根拠に採用しない。比較記録は `verification-reports/conversation-input-2026-10-21/`。
- 稼働中backendの再起動・設定変更はしていない。ソース変更の稼働反映と実機器受入は別途。

### 実測（改訂前）

run `180ade55-9423-40fa-ba74-cb1c4e735136`（明日の鎌倉の天気）で一時回答の配信まで11.2秒。R1 5.6秒（入力1,242トークン・1.4秒、出力158トークン・2.4秒、LARM内の待ち約1.8秒）、候補検索0.08秒、R2 5.1秒（入力1,977トークン・2.4秒、出力62トークン・0.9秒、待ち約1.7秒）。全呼び出しで `providerCachedTokens=0`。主因はR1の自由記述の出力と、一時回答がR2の後に出ること。

### 方針

**利用者に届く結果（一時回答・回答・委譲先・確認の有無）は変えず、内部の手順だけを変える。**

1. **候補検索をR1の前に行う（LLMなし）。** 検索文は現在の発言の原文と、直前の利用者発言の原文を別々に検索し、候補を和集合（重複除去、既存の件数上限をそれぞれに適用）とする。続きの依頼（「明日は？」）でも前の話題の担当が候補に残る。§2のR1→R2間の `goal` による検索は廃止する。
2. **R1は候補を関数として受け、1つを呼ぶ。** 提示する関数は、候補のツールチェーン関数・`answer`・`report_unavailable`。分析は省かず、各関数の共通引数として選択肢の値だけを書かせる。
   - 共通引数: `kind`・`freshness`・`impact`・`approved`（意味は§2の表のとおり）。
   - ツールチェーン関数: 共通引数＋`announcement`（必須、既存の `announcementSchema`）。
   - `answer`: 共通引数のみ（回答文はR2で作る。回答の入力と結果は改訂前と同じにするため）。
   - `report_unavailable`: 共通引数＋`reply`（既存の発話契約）。
   - 自由記述の分析項目（`goal`・`deliverable`・`conditions`・`missing`）と `next` は書かせない。`next` は呼んだ関数で決まる。
   - R1の入力は§2のまま（役割、直前の1往復の参考データ、現在の依頼。履歴・記憶・日時なし）に、候補の関数定義が加わる。
3. **hostの整合検査（構造のみ）。** `kind` が `live_info`・`past_conversation`・`action`・`creation`、または `freshness=live` で `answer` を呼んだら契約違反として既存の上限付き構造修復へ返す。関数呼び出しなし・複数・未知の関数・引数不正も同じ。`clarify` と `missing` の検査は、`missing` を書かせないため廃止する（確認が必要なときはR2の回答生成が既存どおり確認を返す）。
4. **ツールチェーン関数が呼ばれたら、R1の直後に一時回答を検査・保存・配信する**（既存の `operation-announcement` の検査・保存・配信を使う）。音声の読み上げはここで始まる。
5. **R2（ツールチェーン）。** R1で選ばれた関数だけを提示し、必ず呼ばせる。引数は担当へ渡す依頼（既存の `request`・`questionRef`・`target`・`resolveUnsaved`）だけで、`announcement` は持たない。入力は改訂前のR2の選定入力（直近の依頼・想起・未回答質問・過去の選定）と同じ。R2は一時回答の読み上げと並行して走り、既存の「再生完了を待ってから委譲」はそのまま。
6. **R2（answer）。** 改訂前と同じ回答生成（履歴・記憶込み、toolsなし）。R1の記録として渡していた `goal` 等はなくなり、`kind` だけを渡す。
7. **R1で `report_unavailable`。** その `reply` を回答として採用し、R2は呼ばない。

### 失敗時

- R1の契約違反: 既存の1回修復、連続違反で失敗（改訂前と同じ）。
- 一時回答の配信後にR2が契約違反を連続した場合: 委譲せず run を失敗とする。配信済みの一時回答を成功の証拠にしない（[委譲前の一時回答 §5](conversation-pre-delegation-response-design-2026-10-17.md)）。

### 見込み（推定）と受入

- 一時回答の配信はR1の1回分（出力30〜40トークン）。改訂前の11.2秒に対し、5〜7秒を見込む。サブエージェントの起動までの合計は大きく変わらないが、R2は読み上げと重なる。
- 受入: §5の場面で、一時回答・回答・委譲先・確認の有無が改訂前と同じ。天気・タイマー（時間なし・あり）・一般知識・続きの依頼を実機で測り、一時回答までの時間と各呼び出しの入出力トークン・キャッシュを記録する。

## 9. 再開メモ（2026-10-17 終了時点）

LARM が圧縮通信対応の作業中のため、live 受入は 2026-10-18 以降に持ち越す。

### 状態

| 項目 | 状態 |
| --- | --- |
| §2〜§6（R1 `analyze_request`→R2） | 実装・fixture 済み。製品サーバーで live 確認済み（下表） |
| R1 の自然文返答の修正（役割文のみの system、直前1往復を参考データ化、指示の明確化） | 実装・fixture 済み。隔離 host の live で「タイマー起動して」の R1 成功率 0/10→9/10。生データは scratchpad（揮発）にあり、本書の数値が正 |
| §8（一時回答までの短縮） | 実装・fixture 済み。`bun test api/domains/dialogue api/domains/toolchain-history api/domains/voice-dialogue` 498件成功、`bun test ./api/application` は既存6件以外成功。live は未実施。live 試行は `bun scripts/first-round-live.ts --run --repeat 3`（隔離 in-process host、ポートなし、保存済み LARM 設定を読み取り専用、逐次。`--fake` で LARM なしの動作確認。出力は `--out`、既定 `verification-reports/first-round-live/<時刻>`）。比較値は天気で一時回答まで11.2秒・R1出力158トークン |
| タイマー既定3分（`skill:timers.manage@2`、`toolchain:timers.manage@6`、binding@4・artifact@3） | 実装・fixture 済み、製品DB登録済み。live で「タイマー起動して」→3分で開始を確認 |
| 調査失敗時の「失敗しました。」と readAhead | [別設計書](research-failure-reply-and-readahead-2026-10-17.md) §5 |

### 製品サーバーでの live 結果（2026-10-17、§8 適用前）

| run | 依頼 | 結果 |
| --- | --- | --- |
| `60c316c6-54fc-4aa0-9193-68cb1f635c94` | 富士山の高さは？ | R1 knowledge/answer → R2 回答。委譲・予告なし |
| `f14d5c63-f6ee-474b-930b-ec8ee3053a57` | 6分タイマー起動して | R1 action → timers.manage → 予告 → 実行 |
| `9d13fc64-1484-47e2-972c-20d145c64d5e` | タイマー起動して | R1 失敗（自然文→enum不一致）。上記修正の前 |
| `8f4d9ce7-8681-4663-b9a8-7b3818050b4e` | タイマー起動して | 修正後。予告「タイマーを起動します。」→3分で開始（試験後に取消） |
| `bc992888-fbeb-42e1-a6f7-1d41e99cb168` | 明日の鎌倉の天気（main） | 予告まで成功。worker が readAhead 形式違反で失敗→失敗説明が長すぎて run 失敗（readAhead 修正・固定返答の前） |
| `180ade55-9423-40fa-ba74-cb1c4e735136` | 明日の鎌倉の天気 | 予告→調査→160字以内の根拠付き回答。予告まで11.2秒（§8 の実測） |

### 再開時の手順

1. `bun scripts/first-round-live.ts --run --repeat 3` で §8 の live 試行（LARM が必要）。
2. 利用者にサーバー再起動を依頼し、起動ログ（`bun run logs -- --level warn`）で bundle のスキップを確認する。
3. live: 「明日の鎌倉の天気を教えて」「タイマー起動して」「6分タイマー起動して」「富士山の高さは？」「（天気の後に）明日は？」で、R1 の選択、一時回答の文面と配信までの時間、各呼び出しの入出力・キャッシュトークンを記録し、§8 の改訂前の値と比べる。タイマーを起動したら、試験で起動した timerId だけを取り消す。
4. 調査失敗時の「失敗しました。」の読み上げを確認する。

### 未決（利用者に相談する）

- R1 で関数呼び出しを強制するか（現状 `tool_choice: "auto"` 固定、`api/infrastructure/chat-stream.ts`。LARM 側の対応確認が必要）。
- `web-guided.bundle.json` が毎起動 `revision_conflict` でスキップされる件（DB 登録済みの `skill:web.guided@1`・`package:web.recipe@2`・`package:web.quick@3` と bundle の本文が不一致）。案A: bundle を DB の内容に戻す、案B: bundle を廃止。
- `ui-compositions.bundle.json` が `skill:ui.studio@4` の衝突でスキップされる件（本作業外の編集による）。
- §8 の残り: answer の判断でも trace に候補が残る（以前は none）。直前の利用者発言が600字を超えると省略表記付きで検索文になる。`contexts/system-prompt/conversation.context.toml` の「担当を選んだら実行前の短い予告をfunctionに含めます」は回答 round では古い文言（共有 prefix と golden に影響するため未変更）。
- 終了予定を過ぎても `active` のまま残るタイマーがあった（10/13〜14 開始の4件、2026-10-17 に監督者が誤って取消済み）。タイマー側の不具合の可能性。
