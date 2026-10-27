# ブラウザ履歴のリプレイ 設計

状態: **合意済み（2026-10-27）・実装済み・固定試験済み。実際の Brave でのリプレイ（§7 の実機）は未実施。** 検証: `bun run verify -- --domain browser --domain capabilities` pass、application の結合試験（`api/application/browser/` ほか）107 pass、web のブラウザ 52 pass、DesignSystem 53 pass、typecheck・bundle check 通過。独立レビューの指摘（中止で止まらない・代入のすり抜け・確認と実行のコードの食い違い・伏せ字の入力・正規表現・生成コードの拒否）は修正済み。 前提: [browser-run-history-design-2026-10-27.md](browser-run-history-design-2026-10-27.md)（§11 で後続とした「リプレイ」を、ツールチェーン登録なしで画面のボタンから行う）。安全境界は [browser-tabs-toolchain-design-2026-10-18.md](browser-tabs-toolchain-design-2026-10-18.md) §4.4 に一つ例外を足す（§3）。

## 1. 目的と範囲

| 項目 | 内容 |
| --- | --- |
| 目的 | 「履歴」タブの詳細モーダルの「リプレイ」ボタンで、その履歴の Playwright コードを利用者の Brave の実際のタブで実行する。LLM を介さない |
| 対象 | 保存済みのすべての履歴（自動で保存したもの、手で登録したもの） |
| 変数 | 変数がある履歴は、モーダルで値を入れてから実行する |
| 範囲外 | 会話・ブラウザ担当からのリプレイ（LLM には出さない）、ツールチェーン・pipeline への登録、定期実行 |

## 2. 実行方式

host が履歴のコード（詳細モーダルに出している Playwright ソースと同じもの）を検査し（§3.2）、Playwright MCP の `browser_run_code_unsafe` で一回の呼出しとして実行する。

| 案 | 結果 | 採否 |
| --- | --- | --- |
| A. 保存済みコードを `browser_run_code_unsafe` で実行 | LLM 不要。「結果からランダムに1つ選ぶ」のような処理を含むコードもそのまま動く | **採る** |
| B. 操作を1手ずつ MCP の道具（`browser_click` 等）で再生 | 要素の ref は観測ごとに変わるため、ref を選ぶ LLM が要る。ランダムな選択を表せない | 採らない |
| C. ブラウザ担当（LLM）に履歴をなぞらせる | 既にある仕組みだが LLM の判断に依存し、安定しない | 採らない |

自動で保存した履歴のコードは、記録した回にクリックした要素そのもの（例 `getByRole('link', { name: '<動画名>' })`）を指す。そのためリプレイでは毎回同じ項目を選ぶ。毎回違う項目を選ばせたい履歴は、選び方をコードに書く（手で登録した「YouTubeでAI関連動画を再生する」がその例）。

実行で組み立てるコード（変数がある場合の例）:

```js
async (page) => {
  const vars = {"keyword":"AI関連"};
  await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(vars.keyword)}`);
  await page.getByRole('link', { name: '動画のタイトル' }).click();
}
```

`vars` の値は `JSON.stringify` で埋めるので、コードとしては解釈されない。

## 3. 安全

### 3.1 §4.4 への例外

`browser_run_code_unsafe` は「Playwright サーバーのプロセスで任意の JavaScript を実行する。RCE と同等」の道具である。§4.4 の「LLM へ公開しない」は保ち、次の条件でだけ host 内部から呼ぶ。

| 条件 | 内容 |
| --- | --- |
| 起点 | 利用者が画面の「リプレイ」を押し、確認で「実行する」を押したときだけ。会話・ブラウザ担当・API の他の経路からは呼べない |
| 確認 | 一覧の再生ボタンは、許可が要る操作（送信・購入・公開・削除・保存）を含まない履歴だけを確認なしで実行する（利用者決定、2026-10-27）。含む履歴（`hasCommit`）は一覧では押せず、詳細の確認（実行するコードの全文と「送信などを含みます」）を経て実行する |
| 検査 | 実行の前に §3.2 の検査を通す。通らなければ実行しない |
| 遷移先 | コードの `page.goto` の URL を、実行前に §4.4 の遷移先の規則（http/https だけ、Eumenes の `/api/` 拒否など）で検査する |
| 時間 | 1回 60 秒まで。画面の「中止」で止める |

### 3.2 コードの検査（host、実行前）

コードを字句に分け、次をすべて満たすものだけを実行する。字句に分けられないもの（閉じない文字列など）は拒否する。

| 規則 | 許すもの | 拒むもの（例） |
| --- | --- | --- |
| 名前 | `page`・`vars`・`Math.floor`・`Math.random`・`await`・`const`・`let`・`true`・`false`・`null`、Playwright の Page・Locator・Keyboard・Mouse のメソッド名の固定一覧、コード内で `const`・`let` で宣言した名前 | `require`・`import`・`process`・`globalThis`・`Function`・`eval`・`constructor`・`fetch`・`Bun` |
| 計算した名前で読む | なし | `x['constructor']`（`[` で始まる添字の読み出し全般） |
| ページ内で JS を動かす API | なし | `evaluate`・`evaluateHandle`・`addInitScript`・`exposeFunction`・`exposeBinding`・`route`・`routeFromHAR`・`setInputFiles` |
| 関数 | なし | `=>`・`function` |
| 代入 | `const`・`let` の宣言の初期値だけ | それ以外の代入演算子（`=`・`+=`・`??=` など）と `++`・`--`（例 `vars.site = '127.0.0.1'` で検査した URL と違う所へ行くのを防ぐ） |
| 宣言できる名前 | 上の許可された名前と重ならないもの | `page`・`vars`・`Math`・`encodeURIComponent` など |
| 正規表現リテラル | なし（URL を待つときは glob の文字列 `'**/watch?v=**'`） | `/(a+)+$/` など（MCP のプロセスを固められるため） |

コードを包む関数は `'use strict'` とし、`vars` は `Object.freeze` した値にする。Playwright MCP が自動で生成する決まった形（待ち時間の `await new Promise(f => setTimeout(f, 3 * 1000));` など）は、組み立てるときに許可された同じ意味の形（`await page.waitForTimeout(3000);`）へ置き換えてから検査する。置き換えは決まった形の一致だけで行う。

許可を得て入力した値（`<許可を得て入力した値>`）を含む履歴は実行しない（`replay_incomplete`）。伏せた文字列をそのまま入力してしまうため。

### 3.1.1 確認に出すコード

履歴の詳細（`GET /api/browser/histories/:id`）に `replay: {code, blocked, blockedLabel}` を載せる。`code` は実行する関数の中身そのもの（記録の順、上の置き換え後、省略なし）。確認ではこれを出し、読むためのソース（§7 の Playwright ソースは長いと省略し、手順の順に並べる）は出さない。`blocked` は値によらず実行できない理由（`replay_incomplete`・`replay_code_rejected`）で、あるときはボタンを無効にして理由を出す。開始のときも同じ組立てと検査を通すので、確認したコードと実行するコードは食い違わない。

### 3.1.2 中止と時間切れ

`browser_run_code_unsafe` は中止の合図を受けないため、待ちを切るだけでは MCP 側のコードが動き続ける。中止・時間切れでは、リプレイが開いたタブを閉じて実行を終わらせ、10 秒で終わらなければ MCP の子プロセスを切り直す。実行が終わったと分かるまでリプレイを実行中として扱い（`replay_busy`）、`cancelled`・`replay_timeout` はその後に書く。
| テンプレート文字列の `${}` | `${encodeURIComponent(vars.<name>)}` だけ | その他の式 |
| 遷移 | `page.goto` の URL は文字列か上のテンプレートだけ | 変数を連結した式 |

### 3.3 記録

| 残すもの | 残さないもの |
| --- | --- |
| リプレイの ID・履歴 ID・状態・開始と終了の時刻・失敗の分類コード | 変数の値、MCP の応答本文（ページの文を含む）、実行したコードの写し |

ただし開いたタブの URL は、普段のブラウザ操作と同じく、タブ一覧（`browser_tabs`）と操作の台帳（`browser_operations`）に残る。`place` に変数を含む履歴では、その URL に値が入る。ログには出さない。

## 4. タブ

| 場面 | 動き |
| --- | --- |
| 接続済み | 新しいタブを `https://<履歴の place>` で開き、そのタブでコードを実行する。利用者が今見ているタブは変えない |
| 未接続 | 先に接続（既存の `browser.connect`）してから上と同じ |
| 実行後 | タブは開いたまま残す（再生中の動画を見るため） |

## 5. 記録と表示

新しい表 `browser_replays`（migration `browser/0006-replays`）に1回ずつ記録する。ブラウザ担当の作業（`browser_tasks`）とは分ける（LLM の作業の状態・承認・履歴の自動保存と混ぜないため）。

| 列 | 内容 |
| --- | --- |
| `id`・`owner`・`history_id` | リプレイの ID、所有者、履歴 |
| `state` | `running`・`completed`・`failed`・`cancelled` |
| `error_code` | §5.1 の分類コード（失敗のときだけ） |
| `tab_ref` | 実行したタブ |
| `started_at`・`ended_at` | 時刻 |

終わったら履歴の `run_count`（完了）・`failure_count`（失敗）・`last_outcome`・`last_used_at` を更新する。内容と `revision` は変えない。同じ所有者のリプレイは同時に1件まで。

画面:

| 場所 | 表示 |
| --- | --- |
| 詳細モーダル | 「リプレイ」ボタン。変数があれば各変数の入力欄（ラベルは変数の `label`）。押すと確認（コード全文・「送信などを含みます」）。実行中は「実行中…」と「中止」、終わると「完了しました」または失敗の文 |
| 一覧の行 | 変数の入力欄（ラベルは変数の `label`）と再生のアイコンボタン（読み上げ名「<名称>を再生」）。全部の変数に値が入るまで押せない。実行中は「実行中」の印と中止のアイコンボタン、終わると「完了しました」または失敗の文。実行できない履歴・送信などを含む履歴は押せず、理由を出す（一覧の各行に `replay: {blocked, blockedLabel}` を載せる）。詳細を開かずに実行できる（利用者決定、2026-10-27） |

### 5.1 失敗の分類

開始を断るとき（操作の拒否）:

| コード | 画面の文 |
| --- | --- |
| `replay_busy` | 別のリプレイまたはブラウザ操作を実行中です（同じ所有者のリプレイ・ブラウザ作業・撮影が動いている間は始めない。リプレイ中は作業・撮影もブラウザを動かさない） |
| `replay_values_invalid` | 変数の値を確かめてください（値の名前が履歴の変数とちょうど一致し、どれも空でないこと） |
| `replay_incomplete` | 記録されていない操作や値があるため実行できません（遷移・撮影以外でコードの無い操作がある、または許可を得て入力した値を含む） |
| `replay_code_rejected` | このコードは安全のため実行できません |
| `replay_destination_blocked` | 開けない移動先が含まれています |
| `browser_history_not_found`・`browser_history_conflict` | 履歴の削除と同じ文 |
| `browser_replay_not_found`・`replay_not_running` | 中止の対象が無い・もう終わっている（画面は読み直すだけ） |

終わったリプレイに残すもの:

| コード | 画面の文 |
| --- | --- |
| `replay_timeout` | 時間内に終わりませんでした（要素が見つからない可能性があります） |
| `replay_failed` | 実行中にエラーが起きました |
| `browser_disconnected` | ブラウザに接続されていません |
| `replay_interrupted` | サーバーの再起動で中断しました（起動時に `running` のまま残った行に付ける） |

### 5.2 画面との契約

| 向き | 形 |
| --- | --- |
| backend → 画面 | workspace の source に `replays`（所有者の新しい順10件）: `{replayId, historyId, state, errorCode, errorLabel, startedAt, endedAt}` |
| 画面 → backend | `browser-replay-history`: `{historyId, expectedRevision: "<10進>", "var.<name>": "<値>"…}`（入力 adapter `input:browser.history-replay@1` が `{historyId, expectedRevision, values}` にする）。`browser-cancel-replay`: `{replayId}` |
| 受付 | `{action: "history.replay", replayId}`・`{action: "history.replay.cancel", replayId}` |

## 6. 変更一覧

| 場所 | 変更 |
| --- | --- |
| `api/domains/browser/` | migration `0006-replays`、`service/replay.ts`（開始・終了・中止・同時1件）、`service/replay-code.ts`（§3.2 の検査とコードの組立て）、contracts・試験 |
| `api/domains/browser/adapters/mcp-driver.ts` | `ALLOWED_MCP_TOOLS` に `browser_run_code_unsafe` を足し、driver の `runReplay(code, signal)` だけから呼ぶ。ブラウザ担当の道具の一覧（`PAGE_TOOLS`）には足さない |
| `api/application/browser/browser-adapter.ts` | 操作 `browser.history.replay`（入力 `{historyId, expectedRevision, values}`）と `browser.history.replay.cancel`、入力 adapter（画面の値は文字列で届く） |
| `api/domains/capabilities/bundles/browser.bundle.json` | artifact `browser.workspace@6`（actionBinding `browser-replay-history`・`browser-cancel-replay`、effect write）。artifact を指す binding・toolchain の新 revision（operate@7・capture@6） |
| `packages/design-system/.../BrowserWorkspace/` | 詳細モーダルのボタン・変数の入力・確認・状態、一覧の「実行中」 |
| `packages/artifact-ui`・`web/src/domains/browser/` | イベント `browser-replay-history`・`browser-cancel-replay`、拒否コードの表示 |

## 7. 確認

| 段 | 内容 |
| --- | --- |
| 固定試験 | §3.2 の検査（許す例・拒む例を表のとおり）、コードの組立て（`vars` の埋め込み）、同時1件、状態の遷移と履歴の回数の更新、driver が `browser_run_code_unsafe` を `runReplay` からだけ呼ぶこと |
| 検証 | `bun run verify -- --domain browser --domain capabilities`、DesignSystem・Web の試験 |
| 実機 | 実際の Brave で「YouTubeでAI関連動画を再生する」をリプレイし、新しいタブで動画の再生が始まること（固定試験とは分けて記録する） |

## 8. 決定事項

| 番号 | 事項 | 決定 |
| --- | --- | --- |
| R1 | 実行方式 | 保存済みコードを `browser_run_code_unsafe` で実行（§2 の A）。§4.4 の例外（§3.1）とする — **利用者の合意が要る** |
| R2 | 起点 | 画面のボタンだけ。LLM には出さない |
| R3 | タブ | 新しいタブで実行し、終わっても残す |
| R4 | 記録 | `browser_replays` に分けて記録し、履歴の回数だけ更新する |
| R5 | 許可が要る操作を含む履歴 | 詳細の確認で明示したうえで実行できる（確認で確定することを、その回の許可とする）。一覧からは実行しない |
| R6 | 一覧からの再生 | 送信などを含まない履歴は、一覧の再生アイコンで確認なしに実行する（利用者決定、2026-10-27） |
