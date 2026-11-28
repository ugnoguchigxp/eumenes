# 会話の入力と記憶ツール（dialogue）

会話の入力の仕様は [conversation-input-spec](../spec/conversation-input-spec-2026-10-26.md)、記憶系の作り直しは [memory-architecture-redesign](../spec/.todo/memory-architecture-redesign-2026-11-22.md)。本書は、記憶系の作り直しで dialogue に入った即時の層の配線だけを書く。記憶側の公開操作は [memory.md](memory.md#即時の層明示の依頼の反映)、Agency 側は [agency.md](agency.md)。

## `memory` ツール

説明の正本は `api/domains/dialogue/contexts/local/memory-request.context.toml`（同じ規則は 1 か所だけ）。ツールの定義は常に同じ形で送る。

| 引数 | 内容 |
| --- | --- |
| `operation` | `request` |
| `kind` | `remember`・`correct`・`forget`・`suppress`（話題にしない）・`withdraw`・`goal` |
| `what` / `detail` | 対象や内容を書く |
| `ref` | `## Memory`・`read_memory` の短い参照（`m1`…）。訂正・忘却・抑制・取り下げの対象 |
| `quote` | 今回の本人の発言の原文の一部（`remember`・`correct` は必須）。空白・句読点・全半角の違いだけは許す |
| `memory` | 記録の中身。`text`（必須）、`polarity`、`validFrom`・`validUntil`（`YYYY`・`YYYY-MM`・`YYYY-MM-DD`）。`remember` は `kind`（preference・personal_fact・constraint・habit）と `semanticKey` も必須 |

必須の欠落はフィールドごとの拒否（`invalid_tool_arguments`）で返る。

### 適用と結果

会話の run の中、ツールを呼んだ時の writer transaction で記憶の公開操作に渡し、結果を同じ返事の中で返す（拒否のあとに引数を直して呼び直せる。1 返事で `memory` は 3 回まで）。全操作に run の ID を付けるので、自分の変更で自分の返事は失効しない。同じ依頼の再呼出し（再生成で言い換えたものを含む）は 2 回適用しない。依頼の同一性は、同じ run の中で、`remember` は（kind、`memory.kind`、`semanticKey`）、`ref` ありの `correct`・`forget`・`suppress`・`withdraw` は（kind、`ref`）、`ref` なしは（kind、`what` の正規化）。

| `status` | 意味 |
| --- | --- |
| `applied` | 反映済み。次の発言から読まれる。`remember`・`correct` は新しい版の参照 `ref` も返る |
| `resolving` | `ref` が無い訂正・忘却・抑制。対象を Agency が決めている途中で、まだ反映されていない |
| `rejected` | `reason` のとおり。`quote_mismatch`（引用が発言と一致しない）、`unknown_ref`（参照が古い）、`target_changed`（参照の記録が更新された。`read_memory` で読み直す）、`target_missing`、`target_excluded`、`forget_pending`、`limit_reached`、`invalid_*`、`memory_unavailable`、`target_resolution_unavailable` など |

- `remember`・`correct` の引用は、今回の run の本人の発言を新しい順に探す。
- `forget`（`ref` あり）は、記録を除外し、根拠の発言を履歴から隠し、steward の inbox の依頼を「除外済み・確定待ち」にする（閉包削除は記憶担当）。`ref` が無ければ依頼は pending のまま inbox に積み、同じ `requestId` で対象の解決のポートへ渡す。
- `goal` は従来どおり steward の inbox に積む。

### 対象の解決のポートと待ち

`ref` が無い訂正・忘却・抑制は、次の順で扱う。

1. steward が永続に保持する（`steward.targetRequestInTransaction`。忘却は inbox の依頼と同じ id）。
2. Agency に `MemoryTargetPort.requestInTransaction(db, request)` で知らせる（`api/domains/dialogue/contracts/index.ts`）。Agency は run の終了後に対象を決め、記憶の即時の操作を呼ぶ（[agency.md](agency.md#対象の解決自由文の訂正忘却抑制)）。
3. モデルには `resolving` を返す。ポートが無ければ `target_resolution_unavailable` で拒否する。

**忘却だけは、決まるまで次の生成を始めない。** 除外前の生成は、除外する記録をまだ prompt に持つためである。

- 依頼と同じ transaction で、会話の他の job の後ろに「待ちの job」（`dialogue.targets_hold`）を積む。
- 待ちの間に claim された生成は、`steward.hasPendingForgetInTransaction` が真なら始めず、待ちの job の後ろに積み直す（run はそのまま。固定の待ちは置かない）。
- Agency が決定を確定したら、transaction の外で `dialogue.targetsSettled(conversationId)` を呼ぶ。待ちの job が終わり、生成が続く。決定が `hasPending…` を偽にしていなくても、待ちの job は 2 分で終わる（Agency の呼出しより十分長い安全の上限）。
- Agency が忘却の対象を除外した transaction で `dialogue.hideExcludedInTransaction(db, { messageIds, itemIds? })` を呼ぶと、根拠の発言が履歴から隠れる（次節）。
- 決められなかった依頼は、次の生成の prepare が `steward.takeUnresolvedTargetsInTransaction` で一度だけ取り、`## Host notice` に「『…』の対象を決められず、何も変えていません。」と出す。

`ref` ありの忘却は、除外した記録・発言を `AgencyLayerPort.memoryExcludedInTransaction`（任意）で同じ transaction のうちに Agency に伝える。

### 忘却で隠す履歴

除外した記録の根拠の発言は、閉包削除を待たずに次のものから外す。

- 最近の会話の写し（取り消して、区切りを `due='forget'` にする）と、それを根拠にした要約・状態。
- `read_history` などの読む道具の対象。表 `dialogue_forget_hidden`（`dialogue/0046-forget-hidden`）に message ID を持ち、閉包削除（forget の purge）で解放する。発言は、**その発言が属する会話**で隠す（忘却を頼んだ会話ではない）。
- 記憶が持つ「除外済みで閉包削除前」（`memory.withheldMessagesInTransaction`）。読む道具はこれも見る。最近の会話は、これから別の理由（専門担当の対話・予定の発話）で記憶が止めた発言を除いたものだけを外す（ホスト自身の言葉は最近の会話に残す）。

発言が自分の prompt に入っていても、自分の忘却では返事は失効しない（入力の版を進める）。閉包削除が走り終わって発言が除外台帳に載ると、まだ生成中の返事は失効し、作り直される。

## 短い参照

- `## Memory` の項目は `- m3 本文（本人の発言、10-20から）` の形。参照は記憶が会話ごとに番号を進めて振る（同じ番号は二度と別の記録に振られない）。参照を含めて記憶の設定の `alwaysTokens`（既定 2,000 tokens）まで。載せる種類は `alwaysScope`（既定は本人の事実まで）で、機微・ほかの人の印の記録は載せない（長さの判定は桁数によらず固定幅で行うので、番号が変わっても同じ項目が残る）。その回の発言に関係する記録を差し込む `## Recall` の区画は無い（読むのは常時の区画と `read_memory` で、[記憶](memory.md#会話から記憶を確かめる)）。
- generation の prepare が、`## Memory` に出す項目の参照を記憶から受けて、表 `dialogue_memory_refs`（`dialogue/0047-memory-refs`。会話ごとに窓の key と項目→参照）に保存する。同じ文面を引く読み（背景の呼出しの prefix）はこの表から読む。
- 窓（出ている項目と版の並び）が変わると、古い参照は記憶側で消え、`unknown_ref` になる。履歴に残る古い参照で忘却しても、別の記録には当たらない。
- `read_memory` の結果は同じ窓の番号を続ける。傾向（L4）は「推定」、抑制された項目は「話題にしない」と付け、どちらにも参照は付かない。参照は run が現行のときだけ振る（取り消された run は窓を戻さない）。記憶の `revision` はモデルに渡さない。

## `## State` の予定・目標の欄

`## State` の末尾（既存の欄のあと）に足す。予定と目標を合わせて 150 tokens まで（`## State` 全体の上限の内側）。予定を先に詰め、入らない分は切る。

```text
予定:
- p1 水曜に歯医者（2026-11-25）
目標:
- 枠1 毎朝ストレッチを続ける（進行中）
```

- 予定は continuity の期限付きの計画（L3。open と確認待ち、種類は plan・intent）で、期限の近い順。全会話のものを出す。忘却・除外された根拠を持つ計画は continuity が外す。
- 目標は agenda の枠に入ったもの（Agency の `goalSlotsInTransaction`）。
- 抑制された話題の語を含む予定・目標は出さない。抑制の一覧を読めないときは、予定・目標の欄を出さない（読めないものは出さない側に倒す）。
- 予定が 150 tokens を使い切っても、目標の最初の 1 行の分は残す。

## 採用の検査

返事の採用の検査（`memory_stale`）は、記憶の窓の版と、除外台帳に載った発言が基準。自分の run の `memory` 操作による即時の変更は、検査から除く。追加では失効しない。生成の途中で他の変更（他の run の訂正・忘却・抑制）があれば、作り直す（`retryNotAdopted`）。
