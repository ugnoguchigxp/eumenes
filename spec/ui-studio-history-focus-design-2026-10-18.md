# UI自由制作 履歴の閲覧中の操作（削除と編集対象）設計 2026-10-18

## 1 現状

- 作品履歴で保存作品を選ぶ（`ui-select`）と、タブの `targetRef` が変わり、その作品を閲覧表示するだけになる（`web/src/domains/ui-compositions/toolchain-adapter.tsx`）。
- 専門担当がアクティブな間の発言は、セッション開始時に作った作業（編集中の案または空の案）へ届く（`api/domains/dialogue/service/intake.ts`）。保存作品から作業を作るのは `openWorkInTransaction` だけで、セッション開始時に一度だけ呼ばれる。送信に付く `viewing` は通常担当の文脈（`viewingBlock`）にしか使われない。
  - 専門担当なし・保留中: 履歴を選んで修正を頼むと、通常担当がその作品を対象に専門担当へ引き継ぐ（[専門担当との対話編集計画](.archived/toolchain-specialist-dialogue-implementation-plan-2026-10-17.md) §1）。
  - 専門担当がアクティブ: 画面に出ている保存作品ではなく、裏の作業が編集される。
- 「破棄」は未保存の案を捨てる操作で、作業が無いと押せない。保存作品を消す操作はどこにも無い。

## 2 閲覧中のツールバーと削除（合意済み 2026-10-18）

利用者の指示: 「履歴をフォーカスしているときは意味が変わる。破棄ではなく削除にする。Disabledのボタンは無くていいので削除ボタンにする」。

- 保存作品の閲覧中は、元に戻す・やり直す・保存・破棄を表示しない（閲覧中はいずれも押せないため）。代わりに「削除」を表示する。「作品履歴」と「会話に戻る」はそのまま。
- 「削除」は確認を出してから実行する（保存作品は取り戻せない）。成功したら閲覧を解除し、編集中の案、無ければ空の状態へ戻す。
- 編集中の案の表示中は今と同じ（破棄は確認なしで未保存の案を捨てる）。
- 操作: `ui-compositions.delete`（write、画面 origin 限定）。入力は `{projectId, expectedSavedRevision}`。
  - 対象が無い・別scope → `target_not_found`。保存版が画面の版と違う → `revision_conflict`（画面を読み直す）。
  - その作品を元にした作業が残っている（専門担当で編集中・保留中、保存後の作業を含む）→ `composition_in_use`。保存して会話に戻る、または破棄して作業を終えてから削除する。
  - 作品の行と回答（`ui_composition_responses`）を消す。receipt は再送の照合のため残す。
- 登録: schema `ui-compositions-delete@1`、artifact `ui.studio@3`（`ui-delete` を追加）、binding `ui.studio@3`・toolchain `ui.compose@9`（artifact・bindingの参照だけを更新）。入力adapter `input:ui-compositions.delete@1`、validator `builtin:uiCompositionDelete`。

## 3 履歴で選んだ作品を編集対象にする（合意済み 2026-10-18）

利用者の要望: 履歴をフォーカスしたら、その作品をベースに編集する。H1〜H3 の案に合意。

- 専門担当がアクティブな間に作品履歴で保存作品を選ぶと、その作品が編集対象になる（H3: 選んだ時点で切り替える）。
  - 今の作業がその作品から作ったもの（`savedRef` が同じ）なら、編集中の案を表示するだけ。
  - H1: 未保存の変更が無ければ、今のセッションを `closed` で終え、選んだ作品から作業を開いた新しいセッションに移る。専門担当の履歴も新しくなる。
  - H2: 未保存の変更があれば、画面が「破棄して切り替える／編集を続ける」を確認する。破棄を選んだときだけ `discarded` で終えて切り替える。「編集を続ける」は何も変えない。
  - 生成中は切り替えず、表示だけを切り替えて、その旨を伝える。
- 専門担当が無い・保留中のときは今と同じ（表示だけ。修正の依頼は通常担当が `viewing` を見て引き継ぐ）。
- 操作: `POST /api/specialist-sessions/:id/retarget` `{requestId, expectedRevision, targetRef, discardUnsaved}`。active以外は `session_not_active`、期限切れは `session_expired`、対象外は `target_not_found`、生成中は `work_busy`、未保存で `discardUnsaved:false` は `work_unsaved`。作業の終了に失敗したら全体を戻す。同じ `requestId` は最初の結果を返す。
- 画面: 確認後の切替は local action `ui-retarget`（入力は `ui-select` と同じ `{id}`、artifact `ui.studio@3` に追加）。同じ専門担当の別作品への切替では、通知を「編集する作品を切り替えました」にする。

## 4 実施記録

- 2026-10-18 §2: 実装・固定試験済み。domain（`ui-compositions.test.ts` 削除の正常・使用中・版違い・origin・replay・回答の削除）、adapter（`ui-compositions-actions.test.ts`）、画面（`ui-studio.test.tsx` 閲覧中のボタンと確認、`toolchain-adapter.test.tsx` 削除後の閲覧解除）がpass。`toolchain:bundle check` 登録可能。ブラウザE2E・実機は未実施。binding `ui.studio@3`・toolchain `ui.compose@9` は[打ち切り時間の設計](toolchain-time-limits-design-2026-10-18.md)の作業（`timeLimits` の追加）と同じrevisionを共有する。
- 2026-10-18 §3: 実装・固定試験済み。`specialist-dialogue.test.ts`（clean は即切替・未保存は拒否・破棄を選べば切替・同じ作品は同じセッション・対象外404）、`toolchain-adapter.test.tsx`（active での切替、破棄の選択、拒否時は表示を変えない、生成中・保留中・同じ作品は表示だけ）、`ui-studio.test.tsx`（未保存時の確認）、`useSpecialistWorkspace.test.tsx`（通知）がpass。ブラウザE2E・live・実機器は未実施。
- 2026-10-18 レビュー後の修正: 受付済みで未着手の発言があるときも切り替えない（`work_busy`）。retarget の receipt は選んだ作品と破棄の選択も照合する（別の選択は `request_conflict`）。削除の確定は、表示中の作品が削除した作品のときだけ閲覧を解除する。`verify --domain dialogue --domain ui-compositions` pass。
