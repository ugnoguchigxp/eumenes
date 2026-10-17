# 会話の初動を2ラウンドに固定する（R1 要求分析→R2 回答または委譲）

作成日: 2026-10-17

状態: 設計案。利用者の合意待ち。未実装。

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

会話エージェントの初動を必ず2ラウンドにする。R1はユーザーの依頼を分析し、何を求めているかと問い合わせの種類を判断する非公開ラウンドで、回答文を作らない。ツールチェーン検索はR1の分析結果で行う。R2は、R1の判断に従って回答するか委譲する。履歴が必要な依頼は、Web調査と同じく担当（`history.research`）として扱う。

### R1 要求分析（毎ターン必須・非公開）

- **入力:** 役割、現在の依頼、直前の1往復（H1決着）。長期記憶・逐語履歴・要約・短期記憶・想起・現在日時は渡さない（H2決着）。
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
- `clarify` は必須情報が欠けて進められないとき。
- **既存のものを変える依頼は、実行前に確認する。** Claude Code・Codexへのコード改修、新機能の追加で既存機能を改修する依頼などが該当する。git resetなどで戻せる場合も確認する。削除・外部送信・公開など取り消せない操作も同じ。

R1の `analyze_request` に次の引数を加える。

| 引数 | 内容 |
| --- | --- |
| `impact` | `none`（答える・調べる・参照するだけ）/ `create`（新しい成果物を作るだけで既存を変えない。画像生成など）/ `modify_existing`（既存の機能・コード・データ・設定・保存物を変える）/ `irreversible`（削除・外部送信・公開など取り消せない） |
| `approved` | 直前のアシスタント発言が同じ内容の実行確認で、現在の発言がそれへの承認か（`true` / `false`） |

確認の流れ:

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
| `dialogue/service/conversation-tools.ts` | R2の候補に `report_unavailable` を加える。関数引数に `announcement` と排他の `confirmation` を加える |
| `dialogue/service/interaction-runs.ts` ほか | 確認待ちの選定を未回答の確認として保存し、承認時に `questionRef` で照合する |
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
| 「この画面に機能を追加して」（Claude Code・Codex） | `impact=modify_existing`。選定後、変更内容を述べて確認。承認後に宣言→実行。承認前に担当を起動しない |
| 確認への「やめて」「こう変えて」 | 実行せず、新しい依頼として分析し直す |
| 必須情報の不足 | R1が `missing` を挙げ `clarify`。R2で確認を一つ返す |
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
