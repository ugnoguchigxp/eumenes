# 発言・終端の観測契約：計画レビュー記録

2026-10-10 JST。[対象計画](06-agent-observation-contract.md)。コードの実装は行っていない。レビューは計画の実装可能性と判断境界を確認するものであり、fixture/live受入の代わりにはしない。

## レビュー対象と版

- 調査HEAD: `bc8cc6c24e9b9fe327bc545fa1bfe4ab1b6bf8fc`。作業ツリーを含む。
- 初回レビュー対象計画SHA-256: `38bb230301018d6cd610217222d00689dac6b3f7ab458a2afc9f5287210773e9`。
- 自己レビューとAstra初回指摘の反映版SHA-256: `3436a7f36515fc395035272eba23233753b72ee58e192c63c09cb194dfb622fd`。
- 最終レビュー済み計画SHA-256: `40609a628879547dc41f18d52e1e211ff55077fd6318179703e3ba542ac7be5d`。

| コード | 調査時SHA-256 |
| --- | --- |
| packages/coding-runner/src/decoder.ts | 8d71a1452d9f1072cbb098d599339cecc2024958b62ff69c66b1aecbd65b3699 |
| packages/coding-runner/src/contracts.ts | e8f8a0b1d566cee0375273a564469a8e0aac5a4666074ad0548fe7dd3582c74e |
| packages/coding-runner/src/worker.ts | 53677e3a400834be606fdbae9e3c6bbed4e97a21db8cd112c29a085de3279378 |
| packages/coding-runner/src/core.ts | f7c5d3d8fa947a3874caefc88d75975ff56b711be0db479cf27794539b3c47cd |
| api/application/coding-supervision.ts | 9097142d374ca05d6555a38a7650090fdbabdc7a37204674d3438597474e4cc1 |
| api/domains/coding-supervision/service/index.ts | bfb5ea1167a6ed3ec2717f001d2ed2d2919bd0adc5fafccde4e2077c38997ed9 |
| api/domains/coding-supervision/service/policy.ts | 6b4b676bc23b3c14d3b62b953250b37c282c41c041c0d86847cfa4a4100e2f03 |
| api/domains/coding-supervision/contracts/index.ts | bafee3d7db72bb83bb35487beebcb7d2bd840375f381ae425de0da89e0766439 |

復旧回答の再レビューでは以下も追加照合した。

| コード | 調査時SHA-256 |
| --- | --- |
| api/domains/tasks/service/index.ts | 4a58b0e8ccec023ab341657c75b12be9681c62cd561a7bd2253e601347234b31 |
| api/domains/tasks/types.ts | c8f8529bbf92416a1c5b4fdd0fdea53952a642cd8ed7ae50f9d09d1a2e129adf |
| api/application/delegated-tasks.ts | bbe1a96949586931d618fe113922cd63311c7b78b22371a8878299993ea011fe |
| api/application/coding-tasks.ts | 19c6bd8025c47c47cd6d05633c59baf448e9f3cb05a390fdffa2730d44bb85c9 |

実装前に再採取する。レビュー中の別作業の変更は本レビューの成果に含めない。

## 自己レビュー

| ID | 確認した改善点 | 処置 |
| --- | --- | --- |
| SELF-1 | 意味fingerprintだけ変えてもdecision/stepの全observation digest比較でheartbeatが判断を失効させる | 7.2でsemanticObservationDigestの共通利用と順序fenceの維持を明記。A21追加 |
| SELF-2 | 既存receiptだけでは未起動停止と起動後停止の両方がstopped/exitCode=nullになり得る | processStartedを確認事実として追加し、spawn intentだけはunknown。A20追加 |
| SELF-3 | 32,768文字とUTF-8 bytesの上限が曖昧。surrogateの途中切断を見落とす | 5.1でUTF-16上限維持・Unicode境界・byte計測を分離 |
| SELF-4 | 診断上限を結果時だけ消費するとcrash/retryで無制限になる | 7.3でintent時予約、maxAttempts=1、restartで回数を戻さない条件を追加 |
| SELF-5 | factsの上限で失敗・不足情報が途中報告に押し出される | 7.2で投影時の優先順とlimitations/非公開参照を指定 |

## Astra初回レビュー

モデル: `gpt-6-astra`。独立したサブエージェントに対象計画と現行コード、参考wire/test、LARM公開契約を提示した。読取りのみ。結果: 重大0件、中1件、軽微1件。

| ID・重要度 | 指摘と根拠 | 処置・受入 |
| --- | --- | --- |
| ASTRA-1 中 | inspect_moreはvalidateReceipt以外にもavailable/policy/stepCurrent/execute、判断開始時のstopped/holdで阻まれる。base.observeがthrowするとWorkflow.observeへ到達しない | 6.3で取込み失敗の固定code経路、7.1でObservationReadPortとhost/モデルの入口を具体化。変更StepReceiptから分離し、A17/A18を追加 |
| ASTRA-2 軽微 | readEvidence.truncatedはoffset非0なら最終chunkでもtrue。「次offsetで解消」の記述が不正確 | 6.2で同一digestの取得区間によるcoverage判定へ訂正。A19追加 |

両指摘を採用した。LARMの対応・正式terminal処理をEumenesへ再実装する提案はしていない。

## Astra再レビュー

モデル: `gpt-6-astra`。上記指摘と自己レビュー修正を含めて再確認した。対象計画SHA-256: `21fe40cb2d62e4f5f35f351fdd281d84f54505137f6f6fd24741e647620234d2`。

結果: **重大0件・中0件・軽微0件**。初回の中1件・軽微1件が計画上解消していること、追加した意味digest・予算予約・Queue再試行制限・processStarted・Unicode境界・報告の情報優先順に新しい指摘がないことを確認した。fixture/liveは実行していない。

## Opus 5.5レビュー

ローカルClaude Code 2.1.296から`claude-opus-5-5`を明示して実行した。toolsなし・safe-mode・session persistenceなしで、選択したコードと計画を入力として渡した。Providerの内部思考・生応答はレビュー記録へ保存しない。公開レビュー結果と実行モデル名・成否だけを記録する。

初回は121,541文字の資料を入力し、360秒でtimeout。正式なレビュー回答を得ていないため、レビュー完了や指摘0件として扱わない。

2回目は48,914文字、effort=medium、240秒上限で実行。124.3秒で正常終了し、利用モデル名`claude-opus-5-5`、isError=falseを確認した。対象計画SHA-256: `21fe40cb2d62e4f5f35f351fdd281d84f54505137f6f6fd24741e647620234d2`。結果: 重大0件・中2件・軽微3件。

| ID・重要度 | 指摘 | 処置・受入 |
| --- | --- | --- |
| OPUS-1 中 | v1正常実行の投影とprevious receiptのreaderが未定義で、移行後に工程を進められない | 6.1で正常終端の根拠照合とrun_checksを許可。v1 continueは専用readerから固定codeで拒否し、停止後の復旧質問へ。A22追加 |
| OPUS-2 中 | source切詰めと保存整合性・evidenceCompleteの関係が曖昧で、長文や旧正常実行が不適格になり得る | 5.2でcaptureIssuesとreportLimitationsを分離。計画的切詰め/legacy元文章不明は既存gateを変えず、真の保存障害は失効。A23追加 |
| OPUS-3 軽微 | 診断打切り後に質問を出す契機が条件付きで、無言のholdが続く | 7.3で停止確認と上限/回復不能をhostの決定的契機にし、blockerと質問を一回。A24追加 |
| OPUS-4 軽微 | 約96 KiB本文のcoverageを64 KiB観測枠でどう保持するか不明 | 6.2でcoverageは一観測内のみ、観測間で合算しないと確定。A19拡張 |
| OPUS-5 軽微 | 異常code別予算だけではcode交代で診断数が増える | 7.3で実行/世代/権限ごと合計4回もintent時予約。A25追加 |

5件すべて採用した。修正版SHA-256 `9990f966912f55f74f39ef688928acb8791bf93eca61769127e8faff1bb6fed5`への最終確認は80.5秒で非0終了・isError=trueとなり、正式な公開レビューを得られなかった。モデル名は`claude-opus-5-5`だったが、これをレビュー完了と数えない。

## Astra最終候補への再レビュー

Opus指摘反映版への再レビューで、Astraは重大0件・中1件・軽微0件と回答した。

| ID・重要度 | 指摘と根拠 | 処置・受入 |
| --- | --- | --- |
| ASTRA-3 中 | tasks.answerは世代を増やさず、applicationがanswer transaction内でprepareを行うため、復旧質問も通常continueへ流れる。v1拒否から脱出できず、available=falseだと中止回答も阻まれる | 7.4でpurposeとfenceの永続対応、通常gate/prepare前の公開回答分類port、tasks所有の取消/新世代遷移、rollbackと再送を定義。A24に実際の回答・v1/v2・取消競合・実行不可を追加し、D4とtasks/application回帰試験を拡張 |

修正版SHA-256 `f8c15838525cd20118958a7c8f82784b0abe863eaf66a40c31384df73853ac44`を再確認し、**重大0件・中0件・軽微0件**。ASTRA-3の解消、取消/再開/rollback/競合/依存方向と受入条件に残る具体的指摘がないことを確認した。

## Opus最終候補への再レビューと処置

計画SHA-256 `f8c15838525cd20118958a7c8f82784b0abe863eaf66a40c31384df73853ac44`を37,108文字で再確認。105.4秒で正常終了し、実行モデル名`claude-opus-5-5`、isError=falseを確認。前回5件とASTRA-3は処置済みと回答し、重大0件・中0件・軽微3件を報告した。

| ID・重要度 | 指摘 | 処置・受入 |
| --- | --- | --- |
| OPUS-6 軽微 | 既存startTaskはregistered/paused専用でepochを増やさず、そのまま呼ぶ復旧では状態競合か失効漏れとなる | 7.4でwaiting_user/recovery/停止済みを復旧入口にし、epoch+1後に開始本体を共通化。A24詳細でepoch/gen各+1・deadline維持・通常start制約を確認 |
| OPUS-7 軽微 | cancelの保存順が未指定で、既存stopTaskがopen質問をsupersededにし得る | answered/answer/answeredFrom保存後にstopTaskを呼ぶ順を確定。A24詳細で回答記録とstopping→cancelledを確認 |
| OPUS-8 軽微 | 引継ぎ成果物参照をprepareへ運ぶ契約がなく、選択肢の意味が曖昧 | 同じgrant workspace現状の使用とtask-reportsの確認範囲表示へ限定。prepare契約を増やさずt.request/implement/previousなし、再検証と予約gateを維持。A24詳細を追加 |

3件すべて採用した。公開レビュー文章にファイル保存を示す文章が含まれたが、toolsなしの呼出しであり、本記録はその保存・追加ファイルの実読取りを事実として採用しない。提示したsourceと本エージェントの現行コード照合を根拠に指摘を検証した。

修正版SHA-256 `9adeb147e8011ee119b9c5dd2bedb72e05a3cecf9ea2ef1cc59eacd17bd988e7`へのAstra再確認は**重大0件・中0件・軽微0件**。7.4とA24の変更が現行コードと整合し、回帰や新しい具体的欠陥がないことを確認した。

Opusの同版全体再確認は36,380文字、48.3秒で正常終了（`claude-opus-5-5`、isError=false）。OPUS-6〜8は解消と回答し、重大0件・中0件・軽微2件を報告した。

| ID・重要度 | 指摘 | 処置・受入 |
| --- | --- | --- |
| OPUS-9 軽微 | choices文言が6.1/7.3で異なり、「確認済み」が未検証の変更を含むworkspace現状を過大に示す | 7.3を定数の正本にし6.1は参照。「作業領域の現状から、新しい世代で実装・検証をやり直す」と未検証範囲の説明へ。A24で完全一致と説明を確認 |
| OPUS-10 軽微 | restartの質問最終状態と旧phaseの扱いが未固定 | answered/answer/answeredFrom・旧質問fenceの保持、新世代task.phase=preparingを明記。通常start/resumeは維持。A24で確認 |

2件とも採用。修正版SHA-256 `40609a628879547dc41f18d52e1e211ff55077fd6318179703e3ba542ac7be5d`へのAstra差分確認は**重大0件・中0件・軽微0件**。指摘への回帰なく、追加assertとも整合すると回答した。

## 最終確認

Opus 5.5は最後の2件への対応を、修正版の6.1/7.3/7.4/8節と関連現行コード13,039文字、effort=medium、180秒上限で確認した。42.3秒で正常終了、利用モデル名`claude-opus-5-5`、isError=falseを確認。OPUS-9/10の解消と、今回の変更による具体的な回帰なしを回答した。結果: **重大0件・中0件・軽微0件**。この最終呼出しは提示した差分範囲の確認であり、それ以外は前の全体レビューを引き継ぐ。

Astraも同じ最終digestの差分を確認済みで、重大0件・中0件・軽微0件。自己レビュー・Astra・Opusから得た指摘はすべて反映し、未処置指摘は0件となった。これは計画上の既知の指摘が解消したという意味で、将来の不具合がないことや製品の成功を保証しない。コード実装には着手せず、ユーザーが計画を確認して実装へ進む段階まで待つ。

文書のローカルリンク、fence対応、末尾空白、受入ID A1〜A25の連続・重複なしを確認した。調査コード12ファイルのdigestは記録と一致する。Markdownはformatter対象外だったためformatter成功とは記録しない。コード実装・変更後fixture・live受入は未実施。実装開始の判断には計画10節の条件を使う。

ContextStill利用: 今回compile/eval各1回、会話累計各5回。計画用のinstruction照合であり、製品の回帰検証の代わりにしない。

## 再照合（2026-10-10 午後）と改訂

最終レビュー後、記録した12ファイル中4ファイルのdigestが変わった。

| コード | 再照合時SHA-256 |
| --- | --- |
| packages/coding-runner/src/decoder.ts | 286ada3081851f2ddf96ef8cbdc098b3373920d37d3460d9bff6e976d03ad62c |
| api/application/coding-supervision.ts | 6d34dca30dffab7b46f36f3baa780ee5a9cf58dfe426dc6bd59487f4122669a9 |
| api/domains/coding-supervision/service/index.ts | c99c3cf7b6c751707fe68e5a9102570e2775eaa960ce9fe928563fd65d747761 |
| api/domains/tasks/service/index.ts | 69be33622dd8f83b359137eb1221356e79a178a84970a7cdc262d646cb0771b9 |

主な変更は、監督指示の承認ゲート（改善計画SEC-11）。Opus 5.5の照合指摘と処置は次のとおり。

| ID・重要度 | 指摘 | 処置 |
| --- | --- | --- |
| RB-1 中 | 承認質問は既にapplication層でCLIへの流入を止めている。7.4の復旧質問が別の照合機構を作り、仕組みが二重になる | 復旧質問を計画07へ分離。承認と復旧はpurpose付きの監督質問記録に共通化し、回答分類portは一つにする |
| RB-2 中 | 承認待ちは`digest(s.observation)`で失効判定する。意味digestが抜粋・取得範囲を含むと、host診断/inspect_moreの読取りだけでユーザー承認が失効する | 7.2で置換箇所5件（apply/decisions/approval/monitor/steps）を列挙。抜粋・coverageを意味digestから除外。A21b追加 |
| RB-3 軽微 | 6.3の「catchでWorkflow.observeへ届かない」は現行と不一致。catchは既に`observationFailedInTransaction`を呼ぶが、理由もcursorも残さない | 6.3を、既存カウンタへ固定code・最後の正常cursorを足す差分に書き直し |
| RB-4 軽微 | 直接CLIでは分類が常にunknownで、明示分類のcapability機構とfixtureは価値を生まない | 5.1で値をschemaに予約するだけにし、capability機構と契約fixtureを削除。選択関数の単体試験だけ残す |
| RB-5 軽微 | 本番は未接続でavailable=false。v1正常終端投影の必要性が未実測 | D0でv1件数を実測し、6.1の投影の採否を記録する条件付きに変更 |
| RB-6 軽微 | 打切り時に既存escalateの自由入力質問を出すと、回答がcontinueへ変換され、同じ失敗・拒否を繰り返す | 7.3とA24で、本書の打切りは固定codeのholdとblocker報告まで。質問は計画07 |

改訂版は未レビュー。計画10節の再レビュー条件に従う。
