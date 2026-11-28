# 完了TODOの報告と音声配信の確定

**2026-10-29、廃止。** 利用者の明示依頼により、完了したTODOは読み上げず、完了の取引でアーカイブして画面の通知で知らせる形に置き換えた（[todo-completion-notice-design-2026-10-29.md](todo-completion-notice-design-2026-10-29.md)）。報告枠・音声再生完了によるアーカイブ確定・replay の played 通知は削除済み。以下は廃止前の設計と記録。

2026-10-27。利用者の明示依頼（完了報告を自発発話上限で止めない、実際の読み上げ完了でアーカイブ）に基づく実装設計。

## 変更範囲と契約

- agencyホストの完了報告、dialogueの報告台帳と配信確定、voice-dialogueの再生結果通知、Webの既存replayプレーヤーを対象にする。依頼の意味判断・報告内容・報告対象の選択は既存LLMに任せる。
- 雑談の未応答上限は維持する。doneのTODOを引用する報告は上限を消費しない。すでに雑談が上限に達していても未報告doneがあれば報告の機会を用意する。この機会では完了TODOへの引用を持つ発話だけを配信する。
- 既存のidle plannerとschedulerを再利用する。雑談と報告のタイミングを同じライフサイクルで管理し、busy・非アクティブ会話・設定変更・取消・終了の制約は維持する。報告判断が待機・不採用となった場合の既存backoffは残す。
- 自発報告も通常の返答も、文字の表示・保存と音声の配信を区別する。TODOのarchive_requestedと既存のcontinuityイベントを再利用し、音声のfullだけでアーカイブを確定する。新しいDB表・migrationは不要。
- 保存した報告は対応するmessage/runに紐づける。音声の結果が未確定の報告はagencyの次の自発報告候補から除き、同じ報告を再生待ち中に重ねない。TODO画面と通常の会話文脈には未アーカイブとして残す。
- Webのreplayは全区間の実際の再生終了を確認してfullを送る。中断・合成失敗・再生前の破棄・音量0はfullにしない。再生IDによる重複排除とmessageの存在・内容の検査を行う。遅れた旧メッセージの結果は別メッセージへ紐づいたTODOを確定しない。
- 音声結果のpartial/noneではTODOを残し、次の報告機会へ戻す。自動読み上げが無効なら読み上げ完了がないためアーカイブしない。再度有効にした際の履歴全件自動再生は追加しない。
- 通常のライブ音声は既存のplayed通知を使い、replayも同じdialogueの音声配信確定へ接続する。文字による実行前確認の既存配信扱いは維持する。

## 非目標

LLM・音声Provider、認証・設定、ツール実行、TODOの完了条件、前回の直近20件表示は変えない。サーバー操作と実機器の受入は行わない。発話語句への専用分岐は追加しない。

## 実装・検証順

1. planner補助と報告時の上限消費を修正する。複数doneと雑談上限到達後の報告、雑談抑制の維持を固定試験で確認。
2. 保存時archiveをやめ、messageに紐づく音声配信の確定へ接続。full・partial・none・重複・古い通知・別会話・更新後の結果をdomain試験で確認。
3. voice APIとWebreplayを接続。全区間終了前にfullが届かないこと、取消・失敗・無音・破棄・再試行を試験する。
4. 部分→結合→通しの順で検証。対象はagencyの結合試験、dialogueのgeneration-work、voice-dialogueのAPI・playback試験、Webのreplay・automatic試験。`bun run verify -- --domain dialogue --domain voice-dialogue`を実行する。既存違反や並行変更による無効化は担当外を直さず別記し、同じ失敗を根拠なく繰り返さない。
5. 設計の正本へ今回の変更を反映し、個別例への依存と無関係差分を点検する。実装・fixture・実機器を区別して完了報告する。

## 実装と検証結果

2026-10-27、実装・fixture検証済み。

- `api/application/agency/report-idle.ts` は既存plannerを雑談・完了報告で使い分け、ライフサイクルを共有する。報告は雑談上限を消費せず、雑談が上限に達した機会ではdoneの引用を持つ発話だけを許す。意味判断はLLMのまま、引用と実際のTODO状態をホストが検査する。
- `dialogue/service/speech-delivery.ts` が音声の配信結果を扱う。自発発話の保存はアーカイブ要求の紐づけまでとし、通常返答の文字によるfull配信もアーカイブには使わない。音声結果は `channel: speech` で区別する。
- `POST /api/voice/replay/played` は既存の認証下で、message ID・再生ID・本文・full/partial/noneを受け付ける。本文の不一致、存在しない発話、利用者の発話を拒否し、再送を重複排除する。TODOが更新されると古いアーカイブ要求を失効させ、新しい報告と異なるキーの遅れた通知は確定に使わない。
- Webの既存replayは、開始されていない再生や中断を完了と混同せず、全区間の実際の終了を待ってfullを送る。通常のlive音声も音量0をaudible=falseとして区別し、一部の区間だけ音量0だった場合も全体のfullにはしない。
- 前回変更したアーカイブ一覧の直近20件表示は維持した。

検証結果:

- `bun run test:domain -- --domain dialogue --domain voice-dialogue`: Bun **475件通過**、Web **70件通過**（最終差分）。
- agencyホスト・plannerと配信境界の部分／結合試験: **64件通過**。既存の雑談上限、複数TODO、上限後の報告、無関係な雑談の拒否、full/partial/none、遅延・重複・更新後の通知を確認。
- `bunx playwright test tests/browser/spoken-report.spec.ts`: **3件通過**。アプリ／fixtureサーバーを起動せず、route fixtureと実際のAudioBufferの終了イベントで、全区間終了前の完了通知なし、全区間終了後のfull、停止・音量0でのnoneを確認。最初は録音workerの組立て、続いてlibrary出力の環境定数が不足したため初期化に失敗。アプリと同じViteで組み立て、環境定数を指定した条件で通過した。
- `bun check --no-pretty --all`: **2,708ファイル、型エラーなし**。途中で見つかった別機能fixtureの型エラーは別作業で解消され、本作業では修正していない。
- 変更対象のformat・lint・diffチェック: **通過**。
- `bun run verify -- --domain dialogue --domain voice-dialogue`: 初回は追加窓口による関数サイズ増加と、既存の `voice-dialogue/test/settings-integration.test.ts` の1,001行違反で停止。追加窓口を `replay-playback.ts` に分けて本変更によるサイズ増加を解消した。
- `bun run verify -- --domain dialogue`: 既存のrepository/index.tsのformat違反と、実行中の別作業による入力変更で **invalidated**。その後の対象formatチェックは通過したが、まとめたverifyの合格とはしていない。音声側の既存試験ファイルのサイズ違反は未解消。必要な試験・型・変更対象静的検査を個別に通して区別した。

記録: `/tmp/eumenes-todo-spoken-domains-final.log`、`/tmp/eumenes-todo-spoken-integration.log`、`/tmp/eumenes-todo-spoken-browser.log`、`/tmp/eumenes-todo-spoken-typecheck-final.log`。verifyの機械記録は `spec/verification/reports/runs/2026-10-26T23-46-47-762Z-ac0d4d70-7f8e-443d-bfe3-138bba2babdc/report.json` と `spec/verification/reports/runs/2026-10-26T23-47-54-651Z-75421ccd-5989-4a0e-b414-31c8262cd38f/report.json`。

差分点検では、並行修正されたlive再生処理に音量0区間の累積が必要なことを再確認し、現行のコミット成功後の更新方式を保って追加した。「途中だけ音量0→最後だけ有音」の回帰試験も通過している。個別の発話語句・特定依頼向けの製品分岐は追加していない。既存の無関係な差分は維持した。

実LLMの判断品質、実機器から可聴であることの受入は未実施。サーバーの停止・起動・再起動、既存の別Codexチャットへの送信は行っていない。実装の反映に必要なサーバー操作も未実施。
