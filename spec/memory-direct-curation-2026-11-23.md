# 記憶: 睡眠の層を外し、steward の直接の書き込みに戻す

- 日付: 2026-11-23
- 状態: 方針は利用者と合意（2026-11-23）。実装済み・fixture 検証済み。本番は再起動後に実行記録を数える
- 前の設計: [記憶系の作り直し](memory-architecture-redesign-2026-11-22.md)（睡眠の層の部分を取り消す）、[記憶の想起の改善](memory-recall-implementation-2026-11-23.md)（`## Recall`・似た記録・冪等の鍵の部分を取り消す）

## 1. なぜ

作り直しで、推し量った事実を候補（L1）に置き、深い整理が上げる形にした。深い整理は直近 1 週間で適用 3・失敗 6・古くなって捨てた 155 で、推し量った記憶がほぼ入っていない。作り直し前の curate-memory（会話から長期の記憶へ直接書く）は 11-08〜11-22 で適用 419・失敗 6・捨てた 70 だった。

## 2. 形

| 経路 | 方式 |
| --- | --- |
| 書く（頼まれたとき） | 今のまま。会話の run の中で即時に反映（`memory` ツール → 記憶の公開操作） |
| 書く（推し量り） | steward の curate-memory が会話の出来事を読み、本人の発言で裏付けのある好み・事実・制約・習慣を、根拠の発言付きで長期の記憶へ直接書く（`remember`・`update`。引用は求めるが必須にしない。作り直し前と同じ）。作り直し前（`081da993` の直前）の形を今の steward に移す |
| 読む | 常時の区画（本人の事実、枠は記憶の設定で既定 2,000 token）と `read_memory`（関係の強い順） |
| 守る | 忘却の即時の除外と後始末（`forget-closure`）、機微・ほかの人の印 |

## 3. 消すもの

| 場所 | 消すもの |
| --- | --- |
| steward | 浅い整理・深い整理（`service/sleep/` の `forget-closure` 以外、睡眠の起動・休み・質問・方針）、`repository/sleep.ts`・`sleep-pressure.ts` の使用、その試験。`forget-closure` と忘却の後始末は残す |
| vendor | `vendor/eumenes-consolidation/` と依存 `eumenes-consolidation` |
| memory | 候補を書く口（`recordCandidateInTransaction` ほか L1 の書き込み）、傾向の書き込み口（`writeTendencyInTransaction`）、件数の圧力（`consolidationPressureInTransaction`）、似た記録の検出（`similar`）、`## Recall` の設定（`recallEnabled`・`recallTokens`・`recallItems`） |
| dialogue | `## Recall` の区画、`memory` ツールの結果の `similar` |
| agency（eumenes 側） | 背景の記録係の事実の書き込み（候補・長期の記憶）。予定（L3）は残す |
| 別リポジトリ | `/Users/y.noguchi/Code/eumenes_consolidation` |

残すもの: 既存の候補・傾向のデータの読み取りと、忘却での削除（`candidate-closure`）。表は消さない（適用済み migration は変えない）。

## 4. 冪等

`memory` ツールの冪等の鍵は、run の ID と依頼の中身（種類と、記憶の key・参照・対象の語）にする。同じ run の中の同じ依頼（呼び出しの繰り返し、世代のやり直し）は 1 回だけ適用する。別の run の依頼や、同じ run の別の依頼を「済んだ依頼」とみなして拒むことはない（以前は会話の ID も run も入らず、別の会話の同じ依頼と衝突していた）。

## 5. curate-memory の推し量り

- 対象は会話の出来事（本人と会話エージェントの発言）。依頼（`memory.request` の行為を持つ発言）は即時の層が反映済みなので、参照として見せるだけで、そこから書かない。
- 書くのは長期の記憶（State）だけ。短期メモは書かない（予定は agency の記録係の L3）。
- 指示文は作り直し前の「記憶の反映」から、依頼の扱いと短期メモを除いたもの。例文は入れない。
- 起動は作り直し前と同じく、会話の新しい出来事で起こす。ただし記録の根拠になるのは本人の発言だけなので、会話エージェントの発言だけが溜まっているときは推論を呼ばず、本人の次の発言を待つ。本人の発言の直前の会話エージェントの発言は 2 件まで文脈として一緒に読む。

## 6. 検証

- fixture: `bun run verify -- --domain steward`・`memory`・`dialogue`・`continuity`、agency の記録係の試験。
- 本番: 利用者の再起動 1 回の後、普段の会話のまま `steward_unit` の curate-memory の適用・失敗・捨てたの数、記憶の件数、警告のログを読む（DB は読むだけ）。目安は適用 8 割以上。評価の仕組み・live 評価は使わない。
