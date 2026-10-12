# ツールチェーンの登録と拡張

更新日: 2026年10月12日。現行コードの登録先・接続先と、追加の種類ごとの最小例をまとめる。

**登録APIで追加できるのは、現在は要件profileとdotsの担当package。任意のツール・backendを取り込む汎用登録APIはない。** 組込みpackageは定義を登録しただけでは会話に公開されない。会話へ出すには、packageを[ツールチェーン(定形セット)](#0-ツールチェーン定形セットとして会話へ公開する)として登録する。

## 0. ツールチェーン(定形セット)として会話へ公開する

ツールチェーンは「サブエージェント・SystemContext・SKILL・ツールの使い方・ツール詳細・Artifact」を一組にした登録単位である(`kind:"toolchain"`、設計は[spec](../spec/toolchain-set-routing-design-2026-10-12.md))。簡単な処理でも原則この構造で実行し、会話担当のタスクを増やさない。

- 会話担当には、候補検索で選ばれたツールチェーンが一つずつ関数として見える。引数は全ツールチェーン共通の `{ request: string }` だけで、ツールチェーンごとの引数・判別子(`kind`など)・`oneOf`/`anyOf` は作らない。役割が違えば別のツールチェーンにする。
- 関数の説明はツールチェーン定義の `summary`・`useWhen`・`redirects` から生成する。`api/domains/dialogue/service/conversation-tools.ts` に個別の関数や方針文を書き足さない。
- 経路・ツール・引数の判断はツールチェーン内のサブエージェントが行う。実行方式は `runtime-meta.ts` の `toolchainRuntimeOf` で決まる(`research`: agent-runtimeのworker、`command`: 操作担当が型付き操作を一つ作る、`music-create`/`music-playback`: 音楽domainの計画担当)。

| 順序 | 変更先 | 追加・確認する内容 |
| --- | --- | --- |
| 1 | package一式(下のB・C) | profile・SKILL・ツールを持つpackage。ツールの入力schemaは平坦なobject |
| 2 | `api/domains/capabilities/builtin/toolchains.ts` | `kind:"toolchain"`、`functionName`、`summary`、`useWhen`(1件以上)、`examples`(3件以上、候補検索の索引と評価に使う)、`redirects`、`packageRevisionId`(依存はこのpackage一つ)、`artifact`(表示しない場合も`{kind:"none"}`を明示) |
| 3 | `api/domains/capabilities/contracts/runtime-meta.ts` の toolchains | 実行方式、必要なruntime(`luna`・`timers`・`music`・`dots`)、研究経路なら`route` |
| 4 | 実行方式が既存にない場合だけ | `dialogue/service/generation-operation.ts` と実行先の接続 |

登録時に、必須要素の欠落・関数名の重複・平坦でないツールschemaは拒否される(`invalid_toolchain`、`toolchain_function_conflict`、`invalid_toolchain_tool_schema`)。packageが登録されていないホストではツールチェーンも登録しない。

候補検索は、toolchainの`title`・`summary`・`useWhen`・`examples`に対するFTS(trigram)と、LARMのembedding(`examples`等をpassageとして保存)、似た依頼での過去の選択をRRFで統合する。embeddingを利用できないときは、全ての利用可能なツールチェーンを提示する。選択の記録と保存済みの取得手順は `toolchain-history` domain(`/api/toolchain-history/*`、`bun run cli -- toolchain-history ...`、設定「ツールチェーンの記録」)で確認する。

[作業規則](../AGENTS.md)を守り、意味理解や担当選択はLLMに任せる。コードで追加する分岐は、公開操作・登録IDと実行先の接続に限る。発話の語句・企業名・地域による振り分けを追加しない。A〜Dのコードは登録方法を説明する未登録の例。Eの音楽UI・生成中表示は実装済みの登録例であり、新しい部品への適用手順と区別して示す。

## 1. 最初に追加の種類を選ぶ

| 追加したいもの | 手順 | 製品コードの変更 |
| --- | --- | --- |
| 履歴調査で使う確認基準 | [A1 要件profile](#a1-要件profileを登録する) | 不要。Web検索の要件抽出には使わない |
| dotsに渡す担当・Skill | [A2 dotsの担当package](#a2-dotsの担当packageを登録する) | 不要。登録後にプロジェクトへ担当版を設定する |
| 既存ツールの組合せ・担当指示を変更 | [B packageを追加・改訂する](#3-b-既存ツールを使うpackageを追加改訂する) | 定義・依存・起動先。新IDなら実行方針・会話公開も必要 |
| 既存backendで新しい操作を呼ぶ | [C ツールを追加する](#4-c-既存backendにツールを追加する) | schema・定義・実行分類・adapter・利用package |
| 成果物の画面・操作部品 | [E DesignSystem・OpenUI・Artifact](#10-e-designsystemopenuiartifactを追加する) | 既存viewのJSON合成を優先。必要な場合だけDesignSystem部品とOpenUI登録を追加 |
| 新しいサービス、実行担当、更新操作 | [D backend・実行担当を追加する](#5-d-backend実行担当更新操作を追加する) | 実行・取消・結果採用までの接続実装が必要 |

まず「何を入力して何が返れば完了か」「どの経路を再利用するか」「今回どこまで確認するか」を短く記録する。既存ツールで同じ操作ができるなら、ツールIDやbackendを増やさずBを使う。コード例のIDは例示用なので、実登録時は用途に合うIDへ変更する。

用語は、`profile`が担当の役割、`skill`が担当へ渡す手順、`tool`が一つの操作、`package`がそれらの版を固定した組合せ。`requirement`は履歴調査の追加確認基準であり、担当の`profile`とは別物である。`backend`は実装の利用可否、推論`engine`はモデル実行先を表し、同じ設定ではない。

## 2. A API・設定だけで登録する

既存の認証・Origin検査を使う。以下のJSONはAPIの本文またはCLIの入力ファイルであり、認証なしで呼べるという意味ではない。CLIはAPIを使う。製品DBへ直接書き込まない。

### A1 要件profileを登録する

変更する製品ファイルはない。次を `history-criteria.json` として用意する。これは例であり、本書の編集ではファイル作成・登録を実行しない。

```json
{
  "version": 1,
  "title": "履歴の決定事項",
  "scope": "保存済みの会話から決定事項を確認する依頼",
  "requirements": [{
    "id": "decision",
    "statement": "会話で決まった内容を示す",
    "required": true,
    "applicability": "決定事項を尋ねている場合",
    "allowNotApplicable": false,
    "valueSchema": { "type": "string" }
  }],
  "provenance": { "kind": "user" }
}
```

```sh
bun run cli -- requirements import history-criteria ./history-criteria.json new --json
bun run cli -- requirements show history-criteria --json
```

改訂はshowで取得した`stateToken`を`new`の代わりに渡す。APIでは `PUT /api/capabilities/requirements/history-criteria` に `{"expectedStateToken":null,"data":上記JSON}` を送る。更新時はnullを現行tokenへ置き換える。競合時は最新内容を読んで判断し、無条件に再送しない。

登録後は有効状態とrevisionを確認する。会話には短いrefが提示され、LLMがhistoryに適用するものを選ぶ。登録しただけで常時適用されるわけではなく、webへ渡してはいけない。上限・無効化・再有効化は[要件の登録と改訂](toolchain.md#要件の登録と改訂)を参照する。

### A2 dotsの担当packageを登録する

通常は「設定 → Codexへの委任 → 担当とSkill」で保存する。APIを使う場合は、dotsが有効で標準依存`tool:dots.coordinate@1`がseed済みの環境で `PUT /api/capabilities/dots-packages` へ次を送る。

```json
{
  "id": "dots.user.0123456789abcdef0123456789abcdef",
  "expectedToken": null,
  "title": "文書レビュー担当",
  "summary": "指定された文書の矛盾と不足を報告する",
  "profile": "依頼された文書をレビューし、指摘と根拠を報告します。",
  "skills": [{
    "title": "文書レビュー",
    "body": "対象文書と指定された参照資料を読み、問題箇所、影響、修正案を整理します。編集を依頼されていなければ変更しません。"
  }],
  "enabled": true
}
```

1. 新規IDは`dots.user.`＋小文字16進数32桁で生成する。例の固定IDを繰り返し使わない。
2. 応答の`revisionId`と`stateToken`を保存する。改訂時は同じIDと現行`stateToken`を`expectedToken`へ渡す。
3. 「設定 → Codexへの委任」の対象プロジェクトで、返された担当版を選んで保存する。`capabilityRevisionId`の更新が必要で、packageの保存だけではプロジェクトの担当は切り替わらない。
4. `GET /api/capabilities/dots-packages`とプロジェクト設定で、版・有効状態・担当の接続を確認する。

profile・skill・packageの生成とrevision更新はAPIが行う。skillsは1〜4件、profileとSkill本文の合計には14,000 bytesの枠がある。新規Sessionや成果返却の実受入は別段階であり、登録成功を実行成功と扱わない。接続とプロジェクト設定は[dotsの設定手順](dots.md#設定して使う)を使う。

## 3. B 既存ツールを使うpackageを追加・改訂する

### 変更箇所

以下のパスはリポジトリルートからの相対パス。

| 順序 | 変更先 | 追加・確認する内容 |
| --- | --- | --- |
| 1 | `api/domains/capabilities/builtin/<対象>.ts`とSkill本文 | profile・skill・packageのDefinition。公開済みの版は残す |
| 2 | `api/domains/capabilities/service/builtin-seed.ts` | 新しい定義配列ならimportし、対応backendが有効なとき登録する。既存配列へ追加する場合は追加配線不要 |
| 3 | `api/domains/capabilities/contracts/runtime-meta.ts` | 新package IDの予算・報告方式。既存IDの新revisionは同じ設定を引き継ぐ |
| 4 | `api/domains/agent-runtime/service/start-task.ts` | 新しい実行で起動する正確な`package:<id>@<revision>` |
| 5 | `api/domains/capabilities/builtin/toolchains.ts` | 会話へ出す新経路なら[0章](#0-ツールチェーン定形セットとして会話へ公開する)のツールチェーンを追加し、`packageRevisionId`で版を指す。会話の関数・方針は手で書かない |
| 6 | `api/domains/dialogue/service/delegate-conversation.ts` | 新しいruntime条件が必要な場合だけ`prepareRouting`の利用可否へ追加する。既存経路の版更新なら変更不要 |
| 7 | 所有domainのtest、`api/application/`の該当結合試験 | 登録、選択、起動したpackageの版、報告方式、会話への返却 |

登録順は依存が先、packageが最後。`dependencies`は依存閉包を作る一覧、`profileRevisionId`・`requiredSkillRevisionIds`・`toolRevisionIds`はその中で実際に使う役割指定なので、両方を揃える。profileとskillには空でないbody、toolにはschemaKeyが必要。packageにも入力に合うschemaKeyを指定する。

### 最小例 既存のquick担当を改訂する

新しい公開操作やadapterを作らず、`web.quick@2`のSkillを変える例。`api/domains/capabilities/builtin/web-research.ts`の既存配列の組立て後へ追加する想定である。`Definition`は`../contracts`からimportする。

```ts
const quickV2 = builtins.find(
  d => d.kind === "package" && d.id === "web.quick" && d.revision === 2,
)!;
const briefSkill: Definition = {
  kind: "skill", id: "web.brief", revision: 1,
  title: "短い公開情報の確認", summary: "要点と出典を短く返す",
  aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [],
  body: "依頼に答える資料を取得し、対象・時点・単位を保って要点を短く返します。不足は明示します。",
};
builtins.push(briefSkill, {
  ...quickV2,
  revision: 3,
  dependencies: quickV2.dependencies.map(ref =>
    ref === "skill:web.search@1" ? "skill:web.brief@1" : ref),
  requiredSkillRevisionIds: ["skill:web.brief@1"],
});
```

この例ではツールチェーン`web.search`の`packageRevisionId`を新しい版へ向ける(ツールチェーンも新revisionにする)。`start-task.ts`はツールチェーンが指すpackageを起動するので変更不要。旧`@2`は削除しない。metadataはpackage IDの`web.quick`に紐づくため変更不要。会話ツール、tool schema、外部adapter、inferenceには変更不要。報告契約と共通方針はそのまま使い、Skillで上位の権限・予算を変えない。

### 新しいpackage IDを並行して追加する場合

上の例でpackageを`id: "web.brief", revision: 1`にすれば別IDの定義になる。ただし、次も必要になる。

- `runtime-meta.ts`のpackagesへ `"web.brief": { budget: "quick", report: "search" }` を追加する。
- 既存quickと併存させる場合、`package:web.brief@1`を指す別のツールチェーン(例 `functionName:"web_brief"`)を登録する。`aliases`や`useWhen`だけを追加しても起動先は変わらない。
- 既存経路を置き換える場合は、起動先と説明を更新する。どちらの用途かを先に決め、併存の依頼で既定経路を勝手に置き換えない。

併存の配線例は次の対応を一組として実装する。これは未実装の例である。

| 接続 | 例で追加する内容 |
| --- | --- |
| `builtin/toolchains.ts` | `web.brief`ツールチェーン。`useWhen`・`examples`・既存`web.search`との`redirects`を双方に書く。会話の引数は共通の`{request}`のまま |
| `runtime-meta.ts` | toolchainsへ`"web.brief": { execution: "research", route: "web" }` |
| 結合fixture | 呼出しから開始したpackageRevisionIdまで確認。会話の選択と起動先が一致することを試す |

`web.brief`というIDや上の分岐を共通機構へ追加するのは、利用者がこの独立経路を必要としている場合だけ。単に短く答えたい場合は先の既存package改訂で足りる。

## 4. C 既存backendにツールを追加する

### 変更箇所と順序

| 順序 | 変更先 | 内容 |
| --- | --- | --- |
| 1 | `api/domains/capabilities/contracts/index.ts` | 新しい引数ならZod schemaとvalidatorsのキーを追加。既存と同じなら再利用 |
| 2 | `api/domains/capabilities/builtin/<対象>.ts` | toolのDefinitionを追加し、利用packageの新revisionに依存とtoolRevisionIdsを追加 |
| 3 | `api/domains/capabilities/contracts/runtime-meta.ts` | toolsへ操作分類・URL範囲・保存本文の要否を登録 |
| 4 | 所有domainのadapter/service | tool IDを実際の公開操作へ変換し、入出力を共通契約へ合わせる |
| 5 | `api/application/toolchain.ts`、必要なら`research-history-ports.ts` | 外部・保存本文・履歴の適切な実行先へ接続する |
| 6 | Bの起動先と試験 | 改訂packageを起動し、モデルへ提示されたツールを実行して結果を返す |

会話が既存の担当を選び、workerが新ツールを使うだけなら、会話のツールを増やす必要はない。Provider側のschemaも含め、提示する引数とホストが受理する引数を一致させる。Zodの独自refineがJSON Schemaで表現されない場合は、既存の契約変換とホスト検査の両方を確認する。

### 最小例 URL本文を読むツールの登録接続

登録箇所を示すための例として`web.document`を使う。実際に既存`web.read`と同じ機能でよければ、別名を増やさず既存ツールを使う。

```ts
// builtin/web-research.ts: 利用packageより前に追加
builtins.push({
  kind: "tool", id: "web.document", revision: 1,
  title: "公開文書を読む", summary: "許可された公開URLの本文を取得する",
  aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [],
  backend: "web", schemaKey: "read",
});
```

```ts
// contracts/runtime-meta.ts の tools へ追加
"web.document": { operation: "read", urlScope: "request_or_observed" },
```

`web-research/adapters/toolchain.ts`の`webToolArguments`は現状`web.lookup`と`web.read`だけを許可する。この例を実装する場合は、許可するIDに`web.document`を加え、既存の`operation:"read", retention:"none"`へ接続する。取得、取消、保存本文、根拠検査は既存Web経路を使う。tool定義だけ追加してもこのadapterは呼べない。

利用packageは新revisionとして、`dependencies`と`toolRevisionIds`の両方へ`tool:web.document@1`を含める。既存`web.read`を置き換えるなら両方の参照を置き換え、Bの起動先も更新する。別の引数・別の外部操作を追加する場合は、その操作のschemaと所有domainの公開操作も先に実装する。

### 実行分類を省略しない

| metadata | 現行の意味 | 省略・誤設定の影響 |
| --- | --- | --- |
| toolの`operation:"search"` | 検索予算として計上 | 未登録は検索として計上されず、期待した上限にならない |
| `operation:"read"`と`urlScope` | 外部読取と、依頼・観測URLへの制限 | URL制限を設定しないとこの制限が働かず、ツール別上限も変わる |
| `operation:"saved_read"`、`requiresSavedBody:true` | 保存本文をlocal経路で読む | 未設定では外部adapterへ進み得る |
| `operation:"history"`、必要なら`cursorPaging:true` | 履歴のlocal処理とcursor制御 | 新しいローカル機能を便宜上history扱いにしない |
| packageの`report:"search"` | V2報告を直接返し、要件抽出・意味検証をしない | 未登録は要件付き報告の経路になる |
| packageの`budget:"quick"` | 検索1・本文1・モデル5回の枠 | 名前にquickを含めても自動では適用されない |

metadataはrevision本文に保存されず、ID単位で全revisionへ適用される。既存IDのmetadata変更は、そのIDの旧版にも影響する。報告や権限の意味を変える場合は、revision更新だけでは隔離できない点を計画に記す。

## 5. D backend・実行担当・更新操作を追加する

これは定義だけの登録ではなく、共通機構に新しい実行先を接続する作業。次の三つを区別する。

| 種類 | 主な変更先 | 最小の接続単位 |
| --- | --- | --- |
| 別サービスから資料を取得 | 所有domain、`api/application/toolchain.ts`、capabilitiesのseed/backend有効集合 | 受付・キュー実行・取得結果・取消・根拠の所有者/版検査 |
| 同じツール群を別モデルで実行 | `api/domains/inference/contracts/index.ts`、同service/adapter、agent-runtimeのstart-task/step-handler、会話の公開条件 | engineの保存・capture・execute・receipt採用・stream/非stream・取消 |
| データを書き換える操作 | 所有domainの公開操作、tool-runtimeのActionAdapter/ActionEnvelope、agent-runtime、会話と結果返却 | 現在の人間の依頼による権限・冪等性・transaction・操作receipt・失効 |

`backend:"archive"`を書くだけで外部adapterは追加されない。`engine`も現状は任意のモデル名を登録する欄ではなく、追加の契約が必要。`local_action`とActionEnvelopeも現在はtimer専用なので、更新操作をreadやhistoryに見せかけない。

### 最小例 新しい資料取得backendの定義と接続

`archive.read`が公開URLの文書を別サービスから読む想定。引数は既存の`read`、package入力は`research`を再利用できる場合の例である。実装する外部サービスの仕様・接続設定・結果形式は別途必要で、以下だけでは稼働しない。

```ts
// builtin/archive.ts の定義例。Definitionは ../contracts からimport。
const base = { revision: 1, aliases: [], tags: [], useWhen: [], avoidWhen: [], dependencies: [] };
export const archiveBuiltins: Definition[] = [
  { ...base, kind: "profile", id: "archive.reader", title: "文書担当",
    summary: "文書の情報を返す", body: "依頼された文書から要点と出典を返します。" },
  { ...base, kind: "skill", id: "archive.read", title: "文書参照",
    summary: "許可URLを読む", body: "指定URLを読み、回答に必要な情報と不足を報告します。" },
  { ...base, kind: "tool", id: "archive.read", title: "文書取得",
    summary: "許可された公開URLの文書を取得", backend: "archive", schemaKey: "read" },
  { ...base, kind: "package", id: "archive.read", title: "文書の確認",
    summary: "指定文書から答える", backend: "archive", schemaKey: "research",
    dependencies: ["profile:archive.reader@1", "skill:archive.read@1", "tool:archive.read@1"],
    profileRevisionId: "profile:archive.reader@1",
    requiredSkillRevisionIds: ["skill:archive.read@1"],
    toolRevisionIds: ["tool:archive.read@1"] },
];
```

1. `builtin-seed.ts`で配列をimportし、`backends.has("archive")`のとき依存順に登録する。`api/application/toolchain.ts`の有効backend集合へ、サービスが利用可能な場合だけarchiveを追加する。
2. `runtime-meta.ts`のtoolsへ `"archive.read": {operation:"read",urlScope:"request_or_observed"}`、packagesへ `"archive.read": {budget:"quick",report:"search"}` を追加する。この予算とV2報告が用途に合う場合に限る。
3. 所有domainで以下のToolAdapter契約を実装し、application層で既存adapterと接続する。ネットワーク実行はtransaction内に置かず、キューの実行段階へ渡す。
4. `get`と`cancelInTransaction`はtool IDを受け取らないため、受付時のoperationIdから同じbackendへ戻せるようにする。開始だけを新サービスへ向け、完了照会や取消をWebへ流さない。再起動後の照合も所有domainの保存情報を使う。
5. Bの併存例と同じように、会話の明示操作から`package:archive.read@1`へ接続する。外部URLは依頼で許可された範囲を渡す。資料の意味による担当選択はLLMに任せる。

| ToolAdapterの入口 | 実装する戻り値・役割 |
| --- | --- |
| `startInTransaction(db, request)` | `{operationId, jobId}`。requestId、owner、deadline、parentJobIdを引き継ぐ |
| `get(operationId)` | pending、succeeded、partial、failed、cancelled等の状態と共通ToolResult |
| `cancelInTransaction(db, operationId)` | 所有domainの取消公開操作を呼び、取消対象job IDの配列を返す |
| `prepareSourcesInTransaction` | 取得資料をモデルへ提示できるSourceへ変換。viewId・正確な本文・版・取得時点を保持 |
| `validateEvidenceInTransaction` | 採用時に所有者、版、期限、失効を検査 |
| `releaseTask` / `releaseRoot` | 担当の一時参照・保存本文を解放 |

契約の正本は[ToolAdapterとToolResult](../api/domains/tool-runtime/contracts/index.ts)。現在の`research-history-ports.ts`はWeb保存本文と履歴を扱うため、新backendの資料を無条件に渡さない。受け取る資料に応じた変換と検査をapplication層で接続する。新backend固有のデータを、架空の履歴参照や既存Webの所有者参照に置き換えない。

別モデルの最小参照実装は[Codexアダプタ](../api/domains/inference/adapters/codex-research.ts)、更新操作は[timer-operation](../api/domains/agent-runtime/service/timer-operation.ts)と`api/application/toolchain.ts`のtimerActions。サービス仕様の違う新担当に、そのまま流用して完成と扱わない。接続設定・認証・取消・receiptを満たす最小範囲を実装する。

## 6. revision更新と起動時登録

登録の正本は[registerRevision](../api/domains/capabilities/service/registry.ts)。同じ`kind:id@revision`で内容が変わると`capability_revision_conflict`になる。

1. 公開済みの定義・Skill本文をそのまま残す。変更した定義を新revisionとして追加する。
2. Skillをファイルから読む場合は版別ファイルを使い、旧定義が新しい本文を読むように変更しない。
3. 依存先が変わったpackageも新revisionにし、`dependencies`と各役割のrevision参照を揃える。
4. schema変更はschemaHashにも影響する。同じschemaKeyが旧tool/packageにも使われている場合、そのvalidatorsを上書きすると旧定義まで変わる。旧schemaを残し、新schemaKey・新tool/package版を使う必要があるか確認する。
5. 定義は依存順、同じIDの版は旧→新の順でseedする。Webのseedには既存旧版の保全処理があるが、全backend共通の移行機能だと仮定しない。
6. 新しい実行が選ぶ版を更新する。会話起動はstart-task、dotsはプロジェクト設定。実行中の固定参照を手動で書き換えない。
7. backendを通常の起動経路で起動しseedする。API/CLIの一覧で登録を確認する。任意のpackageを追加する汎用PUT APIや、一覧だけで会話の起動先を更新する機能はない。

新規DBへの登録だけでなく、旧版をseed済みの隔離DBへ新版を追加するケースも用意する。既存DBを削除して競合を隠さない。有効な現行版・旧版の読取り・二度目のseedの冪等性を確認する。

## 7. 実装完了と登録確認

まず必要なコード・回帰試験コード・docsを最後まで揃える。「実装だけ」と依頼された場合は、ここで差分を確認して終了し、試験を実行しない。

検証まで依頼されている場合、登録の確認を先に行う。以下は外部サービスを呼ばず、固定adapter/modelで確認できる。単に一覧に出ることだけを成功条件にしない。

| 確認 | 成功条件 | 参照する既存試験・入口 |
| --- | --- | --- |
| seed・依存・入力 | fresh/upgrade両方で登録でき、必要な依存とschemaが解決する | `api/domains/capabilities/test/capabilities.test.ts` |
| 公開・選択・開始 | 利用可能時だけ関数を提示し、選択したツールチェーンのpackageの正確な版が起動する。関数の引数は平坦な`{request}` | `api/domains/dialogue/test/toolchain-tools.test.ts`、`api/application/toolchain.test.ts` |
| 実行先・予算 | 提示tool IDが正しいadapterへ届き、実行分類と上限が一致する | `api/domains/tool-runtime/test/invoke.test.ts`、`api/domains/agent-runtime/test/context.test.ts` |
| 結果の返却 | 成功・不足・失敗が報告と会話へ戻り、外部結果を命令にしない | `api/application/search-results.test.ts`。新機能のfixtureは同じapplication層へ置く |
| 成果物UI | DesignSystemの操作、JSON契約、認証済みsource、他のUIとの合成が動く | [Eの手順](#10-e-designsystemopenuiartifactを追加する)と[UI検証](toolchain-extension-verification.md#uiを追加変更した場合) |
| 取消・失効・診断 | 取消後の結果を採用せず、拒否分類/path/codeがstreamでも記録される | `api/application/control-logging.test.ts`、関連domainの既存試験 |

上の試験は雛形であり、新しいIDを加えただけで自動的に検査されるわけではない。新しい登録・入力・adapter・返却を実際に通るcaseを追加する。共通機構の全ケースを各ツールで複製せず、変更した契約と再現例を試す。

登録状態の確認は `bun run cli -- capabilities --json` または認証済みの `GET /api/capabilities` を使う。一覧は有効なpackageの発見用であり、内部toolの登録や会話への公開を保証しない。Aのデータ登録はそれぞれの専用GETで確認する。

domain確認は `bun run verify -- --domain <所有domain>`、横断変更は利用側domainと`bun run verify:all`を使う。domain指定はapplicationの結合試験を自動選択しない。実LLM・実機器は別段階とし、回数と停止条件を先に決める。詳細とコマンド例は[検証手順](toolchain-extension-verification.md)を参照する。

## 8. 登録時によく止まる場所

| 症状・code | 最初に確認する場所 | 対応 |
| --- | --- | --- |
| 一覧に出ない | seed配列、backend有効集合、enabled、discoveryMode、一覧ページング | 登録漏れと非公開条件を区別する |
| 一覧にはあるが会話から呼べない | ツールチェーン定義、`toolchain.registration_failed`ログ、`toolchainRuntimeOf`の公開条件、候補検索(`dialogue.candidates_selected`) | ツールチェーンとして登録する。aliasesだけで直そうとしない |
| `capability_revision_conflict` | 旧定義の本文/schemaHash、同一revisionの差分 | 旧版を保存し新版を追加。API更新なら現行tokenも確認 |
| `invalid_capability_bundle` | dependenciesとprofile/skill/toolRevisionIds | 依存を先に登録し、body/schemaKeyと正確な版を揃える |
| `capability_unavailable` | backend有効集合、依存、adapterの許可ID | 定義があることと実行できることを分けて確認 |
| `invalid_conversation_operation` | `dialogue.operation_rejected`の分類・公開ツール名・path/code | 引数・件数・本文混在を切り分ける。モデル互換性と即断しない |
| `invalid_tool_input` | 提示schema、validators、変換後の引数 | 同じ入力契約へ合わせる。制約を弱めて通さない |
| 想定外の要件抽出・意味検証 | packageRuntimeOfとcontextの経路選択 | search報告のmetadata漏れを確認。historyの検証を削除しない |
| `tool_url_out_of_scope` | 元依頼・観測URL・delegateの許可URL受渡し | 許可情報の接続を直す。URL制限を外さない |
| `required_context_overflow` | 指示・schema・依頼・title/URLを含む提示量 | 実サイズで原因を特定。未提示根拠の登録や無制限拡大をしない |
| 報告を作ったのに回答へ届かない | receipt採用、根拠失効、parentProjection、researchResultContext | 子完了と報告採用・親回答を別々に追う |

ログは `bun run logs -- --level warn` から始め、runId・jobId・HTTPのX-Request-Idで絞る。失敗地点、未実行部分、確定原因と推測を分けて報告する。通常ログへ会話本文・秘密・Provider生応答を保存しない。

## 9. 停止条件と完了報告

「通し確認は1回、失敗したら停止」「単体だけ」などの個別指示を優先する。通常の実装・検証まで依頼されている場合、担当範囲内で原因を特定できた不具合は最小限で修正できる。担当外の改修、要件変更、同じ失敗の根拠のない反復は止めて報告する。毎回の単体失敗を一律に追加承認待ちにはしない。

完了報告には、登録したIDとrevision、公開操作→package→tool→adapter→結果の接続、変更したファイル、固定試験結果、未実施のlive/実機器、残作業を記す。「登録済み」「固定試験済み」「実LLM受入済み」を区別する。

2026年10月11日のWeb検索修正の基準結果と、検証時間短縮の未実装案は[検証手順と基準記録](toolchain-extension-verification.md)へ分離した。過去の全体試験成功を、新しい登録の成功や実LLMの受入に転用しない。


## 10. E DesignSystem・OpenUI・Artifactを追加する

UIが必要なツールチェーンは、実行結果から表示までをこの手順で接続する。担当・Skill・SystemContext・実行ツールの追加はA〜Dに従い、表示を追加するだけなら新しい担当やbackendを作らない。

### E1 既存の部品で組めるか決める

| 状況 | 必要な変更 | 次の手順 |
| --- | --- | --- |
| 必要なviewがOpenUIへ登録済み | 表示JSONと、必要ならホストのsource接続 | E4・E5 |
| DesignSystemに部品はあるがOpenUIにはない | viewのschema、描画adapter、必要なsource・操作契約 | E3〜E5 |
| 既存部品の組合せでは必要な操作を満たせない | 再利用できるDesignSystem部品、Storybook、操作試験を追加 | E2〜E5 |

登録済みviewの正本は [viewRegistry](../packages/artifact-ui/src/contracts.ts)、DesignSystemの公開部品は [index.ts](../packages/design-system/src/index.ts)。既存viewの組合せには`layout`を使う。独自部品を作る場合は、既存部品で不足する操作を作業記録に一文で残す。例えば音楽プレイヤーは、音声の再生位置・シーク・前後10秒・曲送りを一体で扱うため、MusicPlayerとして追加した。

### E2 必要なDesignSystemコンポーネントを作る

リポジトリルートからの変更先は次のとおり。`<Name>`だけを新しい部品名へ置き換える。

| 変更先 | 内容 |
| --- | --- |
| `packages/design-system/src/components/<Name>/<Name>.tsx` | props・イベントと描画。業務APIや認証を持たせない |
| 同ディレクトリの`<Name>.css` | 既存のデザイントークンで配色・余白・状態を表現 |
| 同ディレクトリの`index.ts` | コンポーネントとprops型を公開 |
| 同ディレクトリの`<Name>.stories.tsx` | 通常・処理中・失敗・無効状態など、その部品に必要な状態 |
| 同ディレクトリの`<Name>.test.tsx` | 利用者の操作とイベント、キーボード操作、必要な状態遷移 |
| `packages/design-system/src/index.ts` | パッケージの公開exportを追加 |

最小の登録形は、実装済みのGenerationStatusなら次になる。

```ts
// components/GenerationStatus/index.ts
export { GenerationStatus, type GenerationStatusProps } from "./GenerationStatus";
// src/index.ts に追加
export * from "./components/GenerationStatus";
```

```tsx
import { GenerationStatus } from "@eumenes/design-system";

<GenerationStatus status="running" title="生成しています" />
```

[GenerationStatusの実装](../packages/design-system/src/components/GenerationStatus/GenerationStatus.tsx)と[Storybook](../packages/design-system/src/components/GenerationStatus/GenerationStatus.stories.tsx)を最小の参照先とする。生成状況はpropsで渡し、取得できない進捗率を時間から作らない。取消・再試行などの業務操作はcallbackでホストへ返す。MusicPlayerの再生・シークのようなブラウザ内の部品動作は部品が扱う。

### E3 OpenUIへ登録する

DesignSystemからexportしただけでは、OpenUIのJSONから呼べない。次を接続する。

| 変更先 | 必要な内容 |
| --- | --- |
| `packages/artifact-ui/src/contracts.ts` | `viewRegistry`へ名前・label・strict schemaを追加。新しいデータや操作が必要なら`Resource`・`ArtifactEvent`も拡張 |
| `packages/artifact-ui/src/media-contracts.ts` | 音楽・生成状態のsource型。別用途は適切な契約ファイルに定義し`Resource`へ接続 |
| `packages/artifact-ui/src/media-components.tsx`または`components.tsx` | runtimeのsourceをDesignSystemのpropsへ変換する描画adapter。必要な操作だけdispatchする |
| `packages/artifact-ui/src/library.tsx` | `renderers`へviewと描画adapterを追加。SDKのleaf登録は`viewRegistry`から生成される |
| `packages/artifact-ui/src/compiler.ts` | view名とsourceのkindが違う場合、`checkSource`の対応を追加。存在しないsource・種類違いは拒否する |

最小のview登録例は、既存の`source`・`title`バリデータを使うGenerationStatusのエントリー。

```ts
// contracts.ts の viewRegistry 内
"generation-status": {
  name: "GenerationStatus",
  label: "生成の状態",
  schema: z.strictObject({ view: z.literal("generation-status"), source, title }),
},
// library.tsx の renderers 内（GenerationViewをimportする）
"generation-status": GenerationView,
```

このviewが読むsourceのkindは`generation`なので、`checkSource`にもその対応が必要。音楽プレイヤーとPlaylistはいずれも`music`を読む。描画adapterの完成例は[media-components.tsx](../packages/artifact-ui/src/media-components.tsx)。操作を増やす場合は、イベントを受けるホストの権限・revision・重複処理とreceiptまで実装する。ボタン表示だけで接続完了にしない。

### E4 JSONで組み合わせ、ホストへ接続する

登録済み部品を組み合わせる最小例。任意の楽曲IDをJSONへ埋め込むのではなく、ホストが公開したsource名を参照する。

```json
{
  "view": "layout",
  "direction": "grid",
  "title": "楽曲とプレイリスト",
  "children": [
    { "view": "generation-status", "source": "generation-example" },
    { "view": "music-player", "source": "music-example" },
    { "view": "playlist", "source": "music-example" }
  ]
}
```

`direction`は`stack`または`grid`。現在はleafを1〜12件配置でき、layoutの入れ子は非対応。定義全体は16 KiB以内。source名は小文字英字で始まる英小文字・数字・ハイフンの1〜64文字。任意のReact props、JavaScript、取得先URLを追加しても受理されない。

ホスト接続の最小例は、操作のない生成中表示なら次のとおり。

```tsx
import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";

const definition = JSON.stringify({ view: "generation-status", source: "job1" });
const runtime: ArtifactRuntime = {
  snapshot: {
    job1: { kind: "generation", revision: 1, status: "running", title: "生成しています" },
  },
  dispatch: async () => ({ status: "rejected", message: "この表示には操作がありません" }),
};
// ホストコンポーネント内で返す
<ArtifactRenderer definition={definition} runtime={runtime} />
```

これは固定状態の表示例。実際の生成経過は、認証済みAPIの状態からsnapshotを更新する。上の音楽合成例では、同じruntimeに`generation-example`（kind=`generation`）と`music-example`（kind=`music`）を用意する。音楽sourceの最小形は`{kind:"music", revision:1, currentId:"track1", tracks:[{id:"track1", title:"曲名", url:audioUrl}]}`。`audioUrl`はホストが許可済みの音声を取得して用意するHTTPSまたはBlob URLであり、表示JSONには保存しない。

| ホスト側の変更先・参照例 | 役割 |
| --- | --- |
| `web/src/domains/music/artifact-definition.ts` | 結果IDから表示JSONを作る既存例 |
| `web/src/domains/music/use-music-runtime.ts` | 認証済み一覧・音声取得、選曲、revision、取消と遅延応答の破棄、Blob解放の既存例 |
| `web/src/components/domains/music/MusicArtifact.tsx` | runtimeを共通ArtifactRendererへ渡すホスト。部品の見た目はここへ再実装しない |
| `web/src/domains/artifact/store/index.ts`と`web/src/App.tsx` | `{id, kind:"openui", title, definition}`のタブを開き、ホストへ接続する |

新しい用途のsourceは所有domainの公開APIから作り、他用途のmusic hookへ混ぜない。ホストに許可されたsourceだけを公開し、操作時にも権限・版を確認する。音声の取得取消と生成そのものの取消は別であり、後者はAPI接続がある場合だけ有効にする。

Artifactが保持する表示定義はJSONとし、専用の`kind`やReactコードを増やさない。ただし、現行のArtifactタブはインメモリーで、再読込み後のタブ復元は未実装。DBへのJSON保存・復元が要件なら別途範囲に含め、実装前に対応済みと書かない。

LLMに表示の選択・構成を任せる場合は、公開済みview・source・入力schemaをSystemContextとツール契約へ提示する。UI登録だけで会話に新しいツールが公開されるわけではない。既存操作の結果を既定の画面で開く用途では、その返却経路を再利用する。

### E5 完了条件と記録

[UI検証手順](toolchain-extension-verification.md#uiを追加変更した場合)に従い、部品→JSONとホストの結合→画面の順で確認する。他の登録済みUIと組み合わせ、表示だけでなく今回必要な操作まで確認する。保存済み成果物で確認できる変更なら生成APIを再実行しない。

作業記録には、再利用した部品、新設が必要だった理由、登録view、sourceと操作の接続、JSON例、確認した状態・操作、失敗と未確認を残す。音楽UIの実績とfixtureの制約は[OpenUI移行の検証記録](../spec/verification/music-openui-2026-10-11/README.md)を参照する。
