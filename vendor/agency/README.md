# Agency 配布物の再現

`manifest.json` の `adoptionSource.baseCommit` を一時ディレクトリに取り出し、`adoptionSource.patchFile` を `git apply --binary` で適用する。`sourceFiles` は適用後のファイルの SHA-256。`sourceHash` は `sourceFiles` の順序で、空白を加えずに JSON 化した文字列の SHA-256。

Agency と同じ依存関係を用意し、同じ TypeScript 版で `bun scripts/pack.ts --out <out>` を実行する。生成された tgz に `python3 normalize-pack.py <built.tgz> <normalized.tgz>` を実行し、正規化後の SHA-256 を `manifest.json` と `.sha256` に照合する。

0.1.8 の展開結果は、`derivedFrom` の 0.1.7 と比較してパッケージの版と設計生成に関係する六つの出力ファイルだけが異なる。`goal-runtime-adoption-source.patch` は 0.1.7 の照合用として保持する。
