# Agency 配布物の再現

`manifest.json` の `adoptionSource.baseCommit` を一時ディレクトリに取り出し、`adoptionSource.patchFile` を `git apply --binary` で適用する。`sourceFiles` は適用後のファイルの SHA-256。`sourceHash` は `sourceFiles` の順序で、空白を加えずに JSON 化した文字列の SHA-256。

Agency と同じ依存関係を用意し、同じ TypeScript 版で `bun scripts/pack.ts --out <out>` を実行する。生成された tgz に `python3 normalize-pack.py <built.tgz> <normalized.tgz>` を実行し、正規化後の SHA-256 を `manifest.json` と `.sha256` に照合する。

0.1.10 は 0.1.9 の上に、記憶系の作り直し（`spec/memory-architecture-redesign-2026-11-22.md` §5.3・§5.4・§9.1）のパッケージ側だけを加えた。「予定と関心」の Markdown（`profile.ts`、`updateProfile`・`emptyProfile`・`profileLines`・`PROFILE_TITLE`）を廃止し、構造化出力の書き出し（`extract.ts`、`extractRecords`）、ホストの記録（`AgendaDeps.records`・`known(call)`）と印（`AgendaDeps.marks`、`marks.ts`）、質問の台帳、返事の規則行の変更（`reply.ts`）を入れた。差分は `memory-redesign-adoption-source.patch`（`baseCommit` からの全差分）。0.1.11 の `derivedFrom` の照合用に 0.1.10 の tgz とこのパッチを保持し、元でなくなった 0.1.9 の tgz と `prompt-cache-adoption-source.patch` は削除した。

0.1.11 は 0.1.10 の上に、背景の書き出しの指示文（`extractSystem`）へ「記憶の操作（覚えて・忘れて・訂正して・話題にしないで・取り消して）を頼んだ発言そのものは記録しない」の 1 行を足しただけである。差分は `memory-review-adoption-source.patch`（`baseCommit` からの全差分）で、`derivedFrom` は 0.1.10 の tgz。

0.1.12 の土台は `2262088`（記録係の出力を予定と質問の台帳だけにした。事実・候補・食い違いの出力と、入力の記憶・候補の一覧を廃止）。その上に、登録目標の判断契約、進行台帳と許可・観測の書き込み、会話からの登録・許可ツールを追加した。`registered-goal-autonomy-adoption-source.patch` から再現できる。直接の採用元は 0.1.11 の tgz。この tgz を照合用に保持し、直接の採用元でなくなった 0.1.10 の tgz と SHA-256 ファイルは削除した。

同じ採用差分に、質問待ちの受付を保ったまま独立した条件を進める遷移、複数の読取ポリシー、構成変更の観測と質問の解消を含めた。既存台帳への追加は `agency-goals/0006-read-policies` が担う。

0.1.13 は 0.1.12 の上に、担当への依頼を調べもの項目（`delegatedTo`）として持つ変更（`spec/toolchain-assignment-as-research-2026-11-25.md` §7）を加えた。担当項目は調べもの担当の一枠を使わず並行に発行し、担当の質問と進捗（`assignmentObserved`）、取消（`assignmentEnded`）、返事の状態の `assignments` 欄を持つ。`assignments-adoption-source.patch` は `baseCommit` からの全差分で、0.1.12 の採用差分を含む。直接の採用元は 0.1.12 の tgz。直接の採用元でなくなった 0.1.11 の tgz と SHA-256 ファイルは削除した。

0.1.14 の土台は `3873882`（0.1.13 をコミットしたもの）。その上に、画面に出ていない会話の段取りで、計画せず約束した報告（頼まれた仕事の完成報告・担当の質問）だけを話す `StepHost.promisedOnly` と、計画が進行中の依頼（`inProgress`）を終わったものとして話題にしない規則を加えた。`promised-only-adoption-source.patch` は `baseCommit` からの全差分。直接の採用元は 0.1.13 の tgz。直接の採用元でなくなった 0.1.12 の tgz と SHA-256 ファイルは削除した。

0.1.15 は 0.1.14 の上に、通常の Claude Code 作業先を目標に結び付ける scope 版2を加える。従来のファイル指定は版1として読み、本人による取消と明示的な限定を継承する。差分は `workspace-goal-adoption-source.patch` に含まれる。
