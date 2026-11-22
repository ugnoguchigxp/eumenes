# Agency 配布物の再現

`manifest.json` の `adoptionSource.baseCommit` を一時ディレクトリに取り出し、`adoptionSource.patchFile` を `git apply --binary` で適用する。`sourceFiles` は適用後のファイルの SHA-256。`sourceHash` は `sourceFiles` の順序で、空白を加えずに JSON 化した文字列の SHA-256。

Agency と同じ依存関係を用意し、同じ TypeScript 版で `bun scripts/pack.ts --out <out>` を実行する。生成された tgz に `python3 normalize-pack.py <built.tgz> <normalized.tgz>` を実行し、正規化後の SHA-256 を `manifest.json` と `.sha256` に照合する。

0.1.8 の tgz と `supervision-design-adoption-source.patch` は、0.1.9 の `derivedFrom` の照合用として保持する。0.1.7 は照合の元でなくなったため削除した。

0.1.9 は 0.1.8 の上に、背景呼出しのプロンプトの並びと時刻表記（`src/agenda/prompt.ts` ほか）、先書きの開始条件、`checkAsks` の入力の絞り込みだけを加えた。差分は `prompt-cache-adoption-source.patch`（`baseCommit` からの全差分）で、0.1.8 の `supervision-design-adoption-source.patch` と 0.1.8 の tgz は照合用として保持する。

0.1.10 は 0.1.9 の上に、記憶系の作り直し（`spec/memory-architecture-redesign-2026-11-22.md` §5.3・§5.4・§9.1）のパッケージ側だけを加えた。「予定と関心」の Markdown（`profile.ts`、`updateProfile`・`emptyProfile`・`profileLines`・`PROFILE_TITLE`）を廃止し、構造化出力の書き出し（`extract.ts`、`extractRecords`）、ホストの記録（`AgendaDeps.records`・`known(call)`）と印（`AgendaDeps.marks`、`marks.ts`）、質問の台帳、返事の規則行の変更（`reply.ts`）を入れた。差分は `memory-redesign-adoption-source.patch`（`baseCommit` からの全差分）で、0.1.9 の `prompt-cache-adoption-source.patch` と 0.1.9 の tgz は `derivedFrom` の照合用として保持する。
