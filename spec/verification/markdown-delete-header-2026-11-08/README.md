# Markdownヘッダーの削除アイコン

2026-11-08。利用者指定「追加、取込と同列に削除ボタン」に対応。[表示設計](../../markdown-file-browser-ui-design-2026-11-07.md)、[利用方法](../../../docs/markdown.md)。

既存DeleteButtonのiconOnlyとLibraryActionDialogを再利用し、ヘッダーに集約した。一覧では既存チェック選択を共有し、編集では現在文書の保存済みmetadataを使う。単件は文書ETag、複数選択はlibrary ETagを使い、後者が無ければ要求を作らない。namespace/path/一覧ETagの変更と作業用文書の表示で古い選択を消す。確認を開いた対象は固定し、未保存入力の保護、明示破棄、キャンセル、結果不明の確認を維持した。

API・DB・認証・LLM指示・toolchain登録の変更はない。削除対象の意味解釈を固定語句やモデル外の分類へ移していない。追加した条件は画面の選択・保存状態・公開機能の制約だけである。今回以外のダウンロード、調査文書、Agency等の差分も維持した。実文書の変更・削除、サーバー操作、LARM配備、別チャットへの送信は行っていない。

## 固定試験

| 確認 | 結果 |
| --- | --- |
| 変更前 | 既存MarkdownWorkspace 7件・ManagedLibrary 8件成功 |
| 文書画面全体 | 34件成功（うち削除アイコン10件） |
| Web接続 | 15件成功 |
| 型 | DesignSystem 547 files成功（tests/storiesを含む）、build用325 files成功 |
| build | DesignSystem・Web成功 |
| 対象lint・format・size | 8ファイルlint/format、7 source filesのサイズ、対象diff空白成功 |

削除アイコンの試験は、未対応の無効表示、確認前・キャンセル時の要求なし、一覧の外の文書を正しいID/ETagで削除、チェックした項目の一括削除とlibrary ETag、一覧変更での選択無効化、未保存入力の保持と既存破棄処理、保存中・結果不明・未保存文書の無効化、batch未対応とlibrary ETag必須を確認した。

初回のタブ切替試験はclickイベントだけでRadixの選択が変わらず、実際のポインター操作を再現するuserEventへ変更し、選択状態も明示確認した。選択リセットのeffectはlintに従い、scope変更時にだけstateを更新する形へ修正した。試験側のByRoleOptionsの型指定も修正した。期待値・製品側の安全要件は弱めていない。最終の型修正後も追加10件を再実行して成功した。製品コードを最後に変更した後の画面全体34件とWeb15件の結果を上表に記載する。

根拠: [画面全体](ui.txt)、[追加試験の最終結果](header-final.txt)、[Web](web.txt)、[型](types.txt)、[build](build.txt)、[lint](lint.txt)。

`bun run verify -- --domain markdown --domain artifact`は従来と同じ`artifacts/pursuit-integration-20261106`内の保管試験の実行経路未登録によりinventoryで停止した。[report](../../../verification-reports/runs/2026-11-08T02-49-57-168Z-3915904b-96c8-4f10-b4f9-7afe5bb7b4af/report.json)。除外や検査ルールは変更していない。一括verifyの成功とは扱わない。

全体の`git diff --check`には担当外の`vendor/agency/adoption-source.patch`の空白指摘が残っている。対象差分は個別に成功し、担当外のpatchは変更していない。

## liveと残る確認

[公開APIの読取り結果](live-api.json): 2026-11-08 11:44 JST、Eumenes ready、文書一覧7件、管理状態とArtifact @4はHTTP 200。features.deleteを含む追加機能はすべてfalse。未対応の変更要求は試送していない。

稼働中の画面は自動更新が無効のため、今回の追加アイコンの実画面確認は利用者の再起動後となる。LARMが削除対応を公開するまではボタンを無効にする。実接続での削除は未検証であり、fixtureの成功で代替しない。

ContextStill累計: context_compile 11回 / compile_eval 11回（今回partial）。
