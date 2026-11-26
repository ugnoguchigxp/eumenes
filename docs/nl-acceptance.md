# 自然言語UI受入

更新日: 2026年11月26日。設計は[タイマー設計書 §10](../spec/.archived/timer-data-driven-ui-acceptance-design-2026-10-13.md)。固定のPlaywright回帰（`tests/browser/*.spec.ts`）は残し、この受入はその上に足す層である。

## 構成

| 役割 | 置き場所 | 持つもの・持たないもの |
| --- | --- | --- |
| テスト所有者 | `tests/acceptance/nl/{cases,criteria,fixtures,pilot.json}` と `frozen.lock.json` | 目的・許可範囲・初期fixture・評価基準・予算。selector・クリック順・wait秒は書かない。lockのsha256と一致しないファイルがあればrunnerは起動しない |
| テスターAI | `scripts/nl-acceptance/tester.ts`（共通の入出力）、`tester-larm.ts`（LARMの画像入力対応モデル） | スクリーンショットとアクセシビリティsnapshotから `click/fill/press/wait/done/give_up` を一つ選ぶ。evaluate・URL移動・API呼出し・評価基準の変更はできない |
| 判定host | `scripts/nl-acceptance/{host,judge,checks}.ts` | 許可リストのreadonly GET（timer、会話 `main` のメッセージ、タスクボードの board source）とreceipt観測・画面証拠だけでcriteriaを判定する。AIの自己申告では成功にしない |
| 未凍結ケース | `tests/acceptance/nl/drafts/<group>/{cases,criteria,fixtures}` と `scripts/nl-acceptance/drafts.ts` | 実行できるが lock の対象外。凍結ケースと同じ schema・check を使い、`--case` で指定できる。parse できない、または criteria が未登録の check を使うケースは `--list` に「実行不可」と理由を出し、実行しない。実行記録の digest には `drafts/...` のパスで入る |
| driver | `scripts/nl-acceptance/driver.ts`（`@playwright/test` の chromium） | 画面操作の実行と観測だけ。障害注入は凍結fixtureで宣言したものに限る |

テスターモデルは保存済みのLARM接続（SQLiteの設定）を使い、資格情報はプロセス外へ出さない。別モデルへ替える場合は `TesterAdapter` を実装し、結果は別群として扱う。

## 使い方

```sh
bun run nl-acceptance -- --list                     # 凍結ケースと未凍結（drafts）ケースの一覧
bun run nl-acceptance -- --dry-run --case timer-ui-purpose-01
bun run nl-acceptance -- --dry-run --pilot          # 4群×3試行の計画と予算
bun run nl-acceptance -- --run --case timer-ui-purpose-01 --group standard --runs 1
bun run nl-acceptance -- --run --pilot --baseline-url <移行前UIのorigin>
bun run nl-acceptance -- --rejudge <runDir>         # 保存済み証拠の再判定（criteriaは凍結版）
```

- 群: `baseline`（移行前UI。`--baseline-url` で外部から与える）、`standard`・`variant-a`・`variant-b`（共通hostの登録variant。`?artifactVariant=` で選ぶ）。`standard` 以降は run ごとに隔離DB・隔離サーバ（`scripts/toolchain-fixture-server.ts`＋Vite）を起動する。
- 会話LLMを使うケース（会話開始・会話取消。未凍結の質問継続・カード選択も）は `--with-product-llm` が必要。隔離DBへ保存済みLARM設定を設定APIで保存する。UIだけのケースと結果を混ぜない。
- 予算（wallSeconds・maxActions・maxModelCalls・maxCostUSD）のいずれかに達したら停止する。合格するまで自動反復しない。pilotの形（群・試行数・総上限）はコマンドラインから変えられない。
- 担当への質問は、状態の `assignments[].question` をエージェントが会話で利用者に尋ね、利用者の答えが返事の `assignment(answer)` で担当へ届く流れである。受入は新しいAPIを足さず、会話 `main` のメッセージ（質問は `？` で終わる等のエージェントの発言、答えはその後の利用者の発言）と結果（timer、タスクボードのrun）の出現順で見る。`assignee-question` は質問の件数（上限あり）、質問への答え、結果が答えより後に出たこと、`question-mentions` は質問が選べる形で対象を示すこと、`kanban-cards`・`kanban-no-extra-changes` はカードの列とrun・カード数の増減を判定する。「二つ目の担当」は専用の読みがないため、余計なtimer・run・質問件数で検出する。
- 質問継続（`timer-question-continuation-01`）と対象が曖昧なカード実行（`kanban-conversation-ambiguous-target-01`）は凍結しない（`drafts/`）。`kanban` のseed（`fixture.seedCards`）は、ボードの登録済み操作 `POST /api/toolchain-actions` で、起動前にharnessが入れる。
- 凍結ケースの評価基準を変える場合は新versionのファイルを作り `--freeze` でlockを更新する。結果を見た後に同じrunのcriteria・閾値を緩めない。

## 結果と証拠

`verification-reports/nl-acceptance/<runId>/`（ローカルの検証記録。リポジトリには含めない）に `manifest.json`（基準commit、凍結digest、browser/viewport/locale/timezone、driver版、tester・製品モデル、開始終了、token・呼出し数・action数・費用、停止理由）、`steps.jsonl`、スクリーンショットを保存する。

- `verdict`: `success`（必須criteriaを証拠で全て満たし、禁止副作用なし）、`failure`（具体的な違反を観測）、`inconclusive`（証拠不足・tester/driver故障・予算到達・環境不安定）。
- `failureClass`: `product`・`tester`・`environment`・`criteria`・`undetermined`。testerの見誤りや予算到達を製品故障にしない。
- 判定器が二重開始・180分誤変換・偽成功表示・別timer変更を検出することは `tests/acceptance/nl/judge.test.ts` が合成証拠で確認する（製品コードに故障を混入しない）。

## 検証の区別

`bun test tests/acceptance` は判定器・lock・parser・runnerの単体と、偽製品ページでのdriver結合である。実画面・実LLMでのrun結果とは別に記録する。
