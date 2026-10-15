# World の照会を sub-agent の調査にする（2026-10-15）

## 目的

会話の AI に World の中身を直接読ませない。World の照会は Web 検索・履歴調査と同じく、会話とは別の LARM セッション（auxiliary）で動く sub-agent（agent-runtime の worker）が行い、根拠つきの報告（Report）を返す。会話の AI はその報告を引用して答える。

## 利用者の決定

- 会話の AI が `world_query` の生の結果を読む方式（command 実行、`actionPayload`）は廃止。
- sub-agent は LARM の別セッションで動く（worker の推論は `captureControlInTransaction`＝control mode＝auxiliary session。新しい仕組みは不要）。
- 目標（G8 の①）は今まで通り L1 の直後に入れる。
- 話題の対象の World の状況を自動で入れる仕組み（G8 の②、topic slice と既定の slice）は廃止。代わりに、話題に出た既知の対象の **名前だけ** を1行の手がかりとして渡す（主張の中身は渡さない）。
- World の記録（steward の curate-world）は変えない。

## 設計

### A. 調査の経路（route `world`）

- `api/domains/capabilities/contracts/runtime-meta.ts`
  - toolchains: `"world.query": { execution: "research", route: "world", requires: "world" }`（World が使えないときは提示しない。`requires` の解決は既存の `luna` などと同じ仕組みに足す）。
  - packages: `"world.query": { report: "search", context: "set" }`。
  - tools: `"world.find": { operation: "world" }`、`"world.query": { operation: "world" }`。
- `ToolchainRuntimeMeta.route` に `"world"`、`ToolRuntimeMeta.operation` に `"world"` を足す。
- agent-runtime
  - `start-task.ts`: `kind: "world"`。既定の package は request の `packageRevisionId`（無ければ失敗）。worker 入力は `{question, detail}` と `originalRequest`（URL は渡さない）。
  - `exploration.ts`: `world` は host 内の読み取りとして local-call の予算を使う（history と同じ扱い。上限は history と同程度）。
- tool-runtime `read-invocation.ts`: `operation: "world"` を local とする。
- dialogue `delegate-conversation.ts` / `generation-operation.ts`: route union に `"world"`。

### B. 道具（local read、application 層）

新ファイル `api/application/world-research-ports.ts`（`research-history-ports.ts` と同じ形の ports。toolchain adapter に合成する）。

- `world.find`（引数: `names: string[]` 1〜5件、各 1〜80 文字）: Scope の生きている対象を名前・別名で照合し、`notes` に `{entities: [{id, name, aliases}]}`（最大20件）を返す。readings は無し。照合は `normalizeTopicText`（NFKC・小文字）での部分一致。
- `world.query`（引数: 既存の `worldQueryToolSchema`。ID は `world.find` で得たものだけ）: `createWorldQuery().queryInTransaction` を実行し、
  - `readings`: `basis` の主張1件ごとに Source 1件（最大24件）。
    - `kind: "world_claim"`、`sourceId`（新しい UUID）、`sourceRef: claimId`、`sourceRevision: String(revision)`、`scopeRef: scopeKey`、`basis: "world"`、`title`（例: 「Worldの記録（本人の報告）」「Worldの記録（仮説）」）、`fetchedAt`（照会時刻 ISO）、`truncated: false`、`origin`（`user_report` / `model_hypothesis` など）。
    - `body`: 人が読める1〜数行（対象名、述語、値または関係先の対象名、由来、条件、反証の有無、鮮度）。excerpt で引用できる文にする。
  - `notes`: `{mode, completeness, reasons, summary}`。summary は result を対象名と sourceId で表した短い構造（経路・影響・依存・不足）。生の ID 以外の内部語（`not_computed` など）は、意味の分かる語に直すか、`completeness`/`reasons` として機械可読のまま残し、SKILL で扱いを指示する。
  - 失敗（disabled/blocked/rejected）は `failures` に機械コードで返す。
- 所有者（principal・Scope）は root run の origin から host が決める（`historyOwner` と同じ）。モデルは Scope を選べない。
- `operationFingerprintInTransaction`: 同じ引数の同じ照会は同じ fingerprint（再実行の重複防止）。
- `validateEvidenceInTransaction`（採用時）: 報告が使った `world_claim` の Source それぞれについて、主張が同じ Scope に生きていて revision が同じであること。忘却・取り消し・訂正された主張が1件でもあれば false（報告は採用されない）。
- 根拠の検査（`verifyReport`）: `world_claim` は body からの引用（excerpt）を検査する。親へ渡す quote は空にする（`conversation_source` と同じ）。

### C. 報告と引用

- tool-runtime `Source.kind` に `"world_claim"`、`basis` に `"world"`、`origin?: string` を足す。
- `verify-report.ts` `parentProjection`: `world_claim` は `{sourceId, kind: "world_claim", origin}`（主張の ID と revision は会話の AI に渡さない）。URL は無いので、回答のリンクにはならない（`researchCitations` は変えない）。
- 照会が partial、根拠の件数・大きさの上限で切った、または値を切り詰めたときは、読み取りに切り詰めの印を付け、親へ渡る `coverage` を partial にする。
- 関係の種類・不足の種類は日本語にして本文・summary に書く。理由コードは notes の機械可読の値にだけ残す。
- dialogue `research-result-context.ts`: kind に `"world"`。World の報告の規則を足す:
  - World の記録は本人と会話から作った記録であり、外部の確認済みの事実ではない。
  - `origin` が `model_hypothesis` の主張は「仮説」として伝え、事実と断定しない。
  - `coverage: partial` のとき「影響がない」「依存がない」と言い切らない。
  - 内部の語（ID、mode 名、`not_computed` など）を回答に出さない。

### D. 旧方式の削除（no legacy）

- bundle `world-query`: binding `world.query` を削除。toolchain は revision 3（binding なし、package `world.query@2`）。package @2・SKILL @2・profile @2 を worker の手順に書き直し、tool `world.find@1` を足し、`world.query` tool を @2 に。revision を上げる（同じ revision で内容を変えると `revision_conflict`）。
- `world-query-adapter.ts` の command adapter（`invokeInTransaction`、receipt、projection、`answerContext`、`readInTransaction`、`describeWorldQueryAdapter`、登録）を削除。使い続ける部分（ports）は `world-research-ports.ts` へ移す。
- `api/domains/agent-runtime/service/answer.ts` の `asOf` を比較から外す処理は、World の actionPayload のためだけなら削除。
- `world-query-toolchain.test.ts` / `world-query-adapter.test.ts` は新方式の試験に置き換える。

### E. 会話の文脈（G8 の②の廃止）

- `api/domains/world/service/context-broker.ts` ほか: topic slice と既定の slice を会話へ渡すのをやめる。話題に出た既知の対象（`matchTopicEntities`、最大5件）の名前だけを、L4 の1行の手がかりにする。例: `Worldに記録がある対象: freee、経費精算システム（内容は world_query で調べる）`。対象が無ければ何も入れない。
- 予算（`CONTEXT_TOTAL_BYTES` の World 分 8 KiB、最小 slice 1 KiB、World の blocked）を、手がかり1行の大きさに合わせて縮める・不要なら削除する。
- 使われなくなる slice の描画・選択のコード（`topicAssertions`、`readTopicSnapshot`、`context-render` の slice 部分など）は削除。`worldUsed` など run の記録で不要になるものも削除。
- 目標の layer（goals-layer）は変えない。

## 受入

- fixture: World の質問で `world_query` が選ばれ、worker が `world.find` → `world.query` → 報告を作り、会話の AI は報告（projection）だけを見て答える。会話の AI の入力に World の主張の本文・ID が入らない（isolation 試験）。
- 採用時の検査: 調査中に主張が忘却・訂正されると報告は採用されない。
- 話題の対象の名前の手がかりが L4 に入り、主張の中身は入らない。
- `bun run verify -- --domain` world / dialogue / agent-runtime / tool-runtime / capabilities / steward。
- live: 「freee の移行について誰に聞けばいい？」「freee にすると月末締めはどうなる？」で、報告の引用つきで答える。
