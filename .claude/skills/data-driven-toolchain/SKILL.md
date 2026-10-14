---
name: data-driven-toolchain
description: Add, revise, or migrate an Eumenes toolchain in the data-driven form (capability bundle + versioned binding/artifact + registered DomainAdapter and Web adapter). Use when asked to add a new toolchain/専門担当/ツールチェーン, add an operation or screen variant to an existing one, change a toolchain's profile/SKILL/tools, or migrate a legacy toolchain (Web検索・会話履歴・音楽・画像・Excalidraw・物体認識・dots) off the fixed runtime map.
---

# データドリブン形式のツールチェーン追加・移行

正本は `docs/toolchain-extension.md`（手順）と `docs/toolchain-extension-verification.md`（検証）。この skill は作業順と判断の要点だけを持つ。細部は必ず正本を読む。実在の完成例は `api/domains/capabilities/bundles/timers.bundle.json`、`api/application/timer-adapter.ts`、`web/src/domains/timers/toolchain-adapter.tsx`。

## 0. 着手前に決める

1. 何を入力し何が返れば完了か、どの経路を再利用するか、今回どこまで確認するか（実装のみ／固定試験／ブラウザ／自然言語受入）を一文ずつ記録する。
2. 種類を選ぶ（正本 §2）:
   - 既存adapterで足りる（担当・SKILL・tool構成・表示variantの追加・改訂）→ **bundleだけ**（§3）。コードを書かない。
   - 既存adapterに操作が要る → adapter操作＋入力schema＋bundle（§4）。
   - 新しいdomain → DomainAdapter＋Web adapter＋登録各1行＋bundle（§5）。
   - 旧形式の移行 → §6（§5に加え旧経路を削除）。
   - 単純HTTP APIだけで済ませたい → 現状は未対応（http-json実行器はhost未接続）。adapterで実装する。
3. `git status` で対象ファイルが他作業で未commitになっていないか確認する。他人の変更には触れない。

## 1. bundle を書く（全種類で必要）

1. `api/domains/capabilities/bundles/<名前>.bundle.json` を作る（`formatVersion:1`, `bundleId`, `pins`, `definitions`, `bindings`, `artifacts`, `schemas`）。
2. bundle外の既存revisionを使うなら pin を取る:
   ```sh
   bun run toolchain:bundle -- pins package:<id>@<n> tool:<id>@<n>
   ```
3. definitions: 新しい profile/skill/package/toolchain を**新revision**で書く。既存revisionの本文・schemaは絶対に変えない（hash衝突 `capability_revision_conflict`）。toolchainは `functionName`（全体で一意）、`useWhen` 1件以上、`examples` 3件以上、`dependencies`＝`packageRevisionId` の一件、`bindingRevisionId`、`artifactRevisionId`。旧形式の `artifact` 項目は不要（使われないので書かない）。
4. binding: package の tool を adapter の操作名へ。`inputSchemaRef` は tool の `schemaKey` と同じ `builtin:<key>`、かつ adapter の操作schemaと一致。確認質問に domain 固有の回答schemaを使うなら `questions` に宣言する（自由文 `builtin:answerText` は宣言不要。対象選択は `choiceField` と adapter の `choicesInTransaction`）。
5. artifact: `title`（入口・タブ名、入口は一件）、`variants`（OpenUI JSON と質問表示用 `questionDefinition`）、`sourceBindings`（adapterの登録query、target none/required/optional）、`actionBindings`（既存 eventAction → `operationId` か `answer:true`、`effect` write/read/local）。
6. 検査（何も保存しない dry-run）。issue が無くなるまで直す:
   ```sh
   bun run toolchain:bundle -- check api/domains/capabilities/bundles/<名前>.bundle.json
   ```
   issue と直す場所の対応は正本 §3 の表。

## 2. adapter が要る場合

- backend: `DomainAdapter`（`api/domains/tool-runtime/contracts/adapters.ts`）を `api/application/<domain>-adapter.ts` に実装。操作は domain の**既存の公開 transaction 操作**を呼ぶだけにし、業務判断・時計・保存は domain に残す。拒否は `/^[a-z_]+$/` の code で投げる。会話 origin では `snapshotInTransaction` で見せた対象だけを許す。
- 登録: `api/application/toolchain.ts` の `createAdapterRegistry([...])` と `api/application/toolchain-adapters.ts` の `hostAdapterDescriptions`（結果schemaがあれば `domainSchemas`）に各1件。
- 入力schemaを足すなら `api/domains/capabilities/contracts/` に**新しい**キーを追加（既存キーは変えない）。bundle内 `schemas[]` の有限subsetで済むならコード不要。
- Web: `WebArtifactAdapter` を `web/src/domains/<domain>/toolchain-adapter.tsx` に実装し、`web/src/workspace/toolchain-adapters.ts` に1行。`WorkspaceArtifacts` に分岐を足さない。`settled` で確定receiptを画面へ、`refresh` で競合時に読み直す（自動再送しない）。

## 3. 旧形式を移行する場合の削除対象

移行後に残さない（`no-legacy`）: `api/domains/capabilities/builtin/toolchains.ts` の旧toolchain定義、`api/domains/capabilities/contracts/runtime-meta.ts` の該当固定runtime、dialogue の専用分岐、Web の専用 host と `WorkspaceArtifacts` の分岐、それらの試験。DB上の旧revisionはデータとして残る。binding の無い旧revisionへ公開を戻すと能力が消える（停止スイッチ）ことを報告に書く。

## 4. 守ること

- 依頼の解釈・担当選択・不足情報はLLMに任せる。発話の語句・企業名・地域で振り分けるコードを書かない。
- Web と CLI は API を使い DB を開かない。秘密は backend に留める。ログに会話本文・秘密・Provider生応答を出さない（`docs/logging.md`）。
- migration は名前付き・`after` 明示・適用済みSQLは不変（`docs/domains.md`）。
- 関数 300 行・ファイル 800 行の予算（`bun scripts/size-budget.ts <paths>`）。
- 利用者が「実装のみ」「検証は別担当」と指示したら試験を実行しない。

## 5. 確認（正本の検証手順を選んで使う）

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/<名前>.bundle.json
bun run verify -- --domain capabilities      # 変更した domain と利用側
bun test api/application/<関係する結合試験>.test.ts
bunx playwright test tests/browser/<domain>.spec.ts
bun run nl-acceptance -- --dry-run --case <caseId>   # 自然言語受入を用意した場合
```

起動後に入口が出ない・会話に出ないときは `bun run logs -- --level warn` で `capability.bundle_skipped` を確認し、`GET /api/toolchain-artifacts` を見る。

## 6. 完了報告

bundle の revision ID 一覧、接続（公開関数 → package → binding → adapter → domain → artifact）、変更・削除したファイル、固定試験の結果、未実施（live・実機器・自然言語受入）を書き、「登録済み」「固定試験済み」「実LLM・自然言語受入済み」を区別する。
