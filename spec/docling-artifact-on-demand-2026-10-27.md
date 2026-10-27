# 文章ナレッジベース管理のオンデマンド準備

2026-10-27。利用者の依頼: アーティファクト表示時にオンデマンド起動を要求し、準備完了まで開くボタンを無効にする。メニュー名は「文章ナレッジベース管理」。この依頼の範囲で既存gatewayの起動待ちを再利用する。

## 変更範囲と実行経路

- 設定取得後、アーティファクトが `POST /api/docling/ready` を一度要求する。backendは既存のticket要求処理を呼び、gatewayの起動完了を待つ。起動用に発行されたticketはbackend内で破棄し、設定revision・設定有無・公開originだけを返す。独自lease、起動台帳、queue、稼働状態pollは追加しない。
- 準備中は開くボタンを無効にして準備中と示す。成功応答後に有効化する。失敗時は理由と明示的な再試行を表示する。自動再送しない。
- 開くクリックで別タブを確保し、既存のticket APIから新しい一回限りURLを取得して直ちに遷移する。待機中のticketを保持しない。準備完了はその時点の応答確認であり、常時稼働の保証ではない。後に自然停止していてもクリック時の既存gateway要求で再起動する。
- 設定・clientの変更とアンマウントで要求を取り消し、遅い応答を採用しない。同じ設定の再取得では準備要求を増やさない。準備と開く処理は既存の同時要求ガードを共有する。
- メニュー・タブ名と開くボタンを新名称に合わせる。既存revisionを保持し、artifact・binding・toolchainの新revisionを登録する。Skillも起動準備とクリック時の認証を区別する新revisionに更新する。

## 対象外

文書管理機能、上流gateway、認証方式、接続設定、DB構造は変更しない。新規ライブラリや一般化した外部アプリ基盤を追加しない。実サービスの起動・再起動、SSH接続、配備変更は検証として実行しない。

## 作業順と完了条件

1. 変更前のdomain/Web試験で基準を確認する。
2. 準備API、client、Web adapter、既存表示部品の準備中・失敗・再試行を接続する。
3. 新revisionによる名称と説明の改訂、旧revision保持、fresh/既存seedと再seedを確認する。
4. 部分試験で、準備成功まで無効・失敗後も無効・明示再試行・設定/client切替と閉じた後の遅着破棄・重複抑止・ticket非保存を確認する。
5. 認証付きAPI結合をネットワーク待受なしで確認する。docling・artifact・capabilitiesのdomain検証を行う。ブラウザfixtureは対象ファイルを明示し、サーバーを起動しない通信fixtureで確認する。live受入と固定試験は区別する。
6. 差分を点検し、無関係な変更と意味判断の専用分岐がないことを確認する。

進捗・結果は検証終了後に追記する。

## 実装・検証結果

2026-10-27。上記の実装と固定試験を完了。新revisionは `skill:docling.desk@2`、`package:docling.desk@2`、`toolchain:docling.desk@2`、`binding:docling.desk@2`、`artifact:docling.workspace@2`。profile/toolとadapterは既存を再利用した。既存bundle要素が改訂後にも同じ内容で残ることを比較し、fresh/旧revision登録済みの両方で登録・再登録・旧artifactの内容保持を確認した。

- 変更前: domain 6件、Web 9件が成功。
- 部分: 起動完了まで無効、失敗と明示再試行、同一設定再取得時の重複抑止、client/設定変更・閉じた後の遅着破棄を確認。React StrictModeで設定取得済みの再表示でも起動要求が一回であることを確認した。
- API結合: `docling-ready.test.ts` と、`docling-e2e.test.ts` の `authenticated ticket API` が成功。認証・Origin・要求timeout・同時要求ガード・ticketを含まない準備応答を確認。ネットワーク待受を作る既存2件はサーバー起動禁止のため実行しなかった。
- 画面: `bunx playwright test tests/browser/docling-startup.spec.ts` の3件が成功。準備中、準備完了、起動失敗後の明示再試行、popup拒否時の新規ticket発行抑止を確認。HTTP応答はブラウザの通信fixtureで提供し、サーバーは起動していない。画像は `spec/verification/docling-on-demand-2026-10-27/preparing.png` と `ready.png` を目視確認した。
- 最終domain検証: `bun run verify -- --domain docling --domain artifact --domain capabilities` が成功。backend/共有UI 456件、Web 91件、DesignSystem 2件、計549件。型・build・対象内の境界/lint/formatも成功。記録は `spec/verification/reports/runs/2026-10-26T23-33-23-541Z-f8869e29-3f44-4d83-a3fb-e451699c69b3/report.json`。
- 会話結合: `docling-toolchain.test.ts` は `inference_failed` で失敗。隔離fixtureの公開toolchainを旧@1と新@2へ切り替えて比較したところ、どちらも共通fixtureの `toolchain.fixture.ts:241`（find_toolchainの結果取得）で同じ失敗となり、専門担当の実行回数は0。runIdは旧 `6417a5cf-e12d-4f15-ae14-464030c90a71`、新 `1df20096-1e54-496e-b0f8-cc7a572a6eee`。担当外の会話fixtureは修正していない。会話経由の通し成功は今回の成果に含めない。
- liveと反映: 実サービスの起動・再起動、SSH、配備変更、実接続受入は未実施。新しいメニュー定義は通常のbackend初期化・seedで登録される。既存の凍結された旧artifactは書き換えない。

途中の見直し: 最初のdomain検証で検出したeffect内の同期setStateを、接続scopeに対応する表示状態へ修正した。次の検証は試験548件が成功したが、共有作業フォルダの別更新で記録がinvalidatedとなり、合格扱いにしなかった。StrictMode対策を加えた最終版で再検証し、上記の有効なpassを得た。ブラウザfixtureの初回失敗はJSON import属性不足、次の失敗は模擬別タブHTMLのcharset不足であり、試験データの契約を修正して3件成功を確認した。要件・期待値は弱めていない。

差分点検: 語句や利用例による意味判断分岐、新しい判断方式、独自起動台帳・lease・pollは追加していない。専用APIは既存gatewayの起動待ちと認証URL非公開の境界に限定した。着手時からあった多数の担当外差分と、検証で通知された担当外のformat/lint/size指摘は変更していない。今回の変更対象のdiff checkは成功。実装と固定試験は完了し、残る未確認は上記の既存会話fixture問題と実接続受入・稼働環境への反映。

## 追加コードレビュー（2026-10-27）

依頼: 今回の変更をレビューし、見つかった問題を修正して再レビューする。完了条件は、再現した指摘の修正、回帰・API結合・ブラウザの確認、修正後の再点検で新たな対応必須の指摘が残らないこと。実接続・配備・サーバー操作と、既存会話fixtureの修正は範囲外。

修正前に以下を試験で再現した。

1. 設定取得失敗時にhostのerror表示だけになり、既存の再試行UIへ到達できない（Web回帰試験失敗）。設定取得のエラーも既存launcherのsourceへ渡し、再試行で回復させる。
2. 再試行で設定再取得と起動要求を同時に始め、設定が更新されていた場合に古い設定向けの起動要求が余分に送られる（設定GET待機中にready呼出しが増えることを再現）。既存queryの再取得を先に完了させ、同じ設定の場合だけ明示再試行の要求を進める。設定・client変更と閉じる操作ではその再試行も失効させる。
3. 接続変更で以前の開く要求を取り消した後、遅い拒否応答が新しい接続の画面へ残る（共有view回帰試験失敗）。既存source・revision・利用可否に表示中の操作エラーを結び付け、接続の切替え後へ持ち越さない。
4. ticket処理完了からready応答作成までの非同期境界で取消・接続変更があっても成功扱いになる（domain回帰2件失敗）。ready公開操作でも応答直前に取消と既存versionを再検査し、準備した接続の非秘密情報だけを返す。

共通query、AbortController、launcher表示部品、gatewayのticket処理を再利用する。新しい判断方式・自動再送・起動台帳・lease・poll・新revisionは追加しない。これらは元の設計の取消・設定変更・明示再試行を満たす修正とする。

残作業: 上記4点の修正→部分回帰→API結合→ブラウザfixture→domain検証→修正後の再レビューと差分点検。検証中は編集せず、結果は終了後に記録する。

### 追加レビューの完了結果

上記の残作業は完了。4点の修正後の再レビューで期限後の応答採用も確認し、計5種類の指摘を修正した。

| 指摘 | 修正・確認 |
| --- | --- |
| 設定取得失敗から戻れない | 設定取得エラーを既存launcherへ渡して再試行を公開。再試行GET失敗後に背景GETが回復しても、起動要求なしで「準備中」だけが残らないよう失敗状態を保持。初回GET失敗から画面を閉じずに回復するブラウザ試験も成功 |
| 再試行が設定再取得より先に起動を要求する | GET完了後、同じ接続のときだけ明示再試行を進める。接続変更では既存effectに委ねる。二重再試行、GET待機中のunmount/client切替、古いGETの遅着でも不要な起動要求が増えないことを確認 |
| 前の接続の拒否表示が残る | source・revision・利用可否に操作表示を結び付け、遅い拒否応答を新しい接続の表示へ持ち越さない。既存の競合表示と再試行も維持 |
| ready応答直前の取消・接続変更を見落とす | ticket完了後にもcaller signalと既存versionを照合。準備した接続のrevision・originだけを応答。非同期境界に取消と変更を挿入した2件の回帰が成功 |
| 期限後の応答を採用する | 起動準備と開く処理の双方で、実際に渡した合成signalを応答直前にも検査。期限後のready成功でボタンを有効にせず、期限後のticketでは遷移せず予約したタブを閉じることを確認 |

検証結果:

- 最終の部分・API結合: Web 24件、domain・共有view・ready API 14件、計38件成功。
- `bun run verify -- --domain docling --domain artifact --domain capabilities`: pass。backend/共有UI 459件、Web 98件、DesignSystem 2件、計559件。型・build・対象内の境界/lint/formatも成功。記録: `spec/verification/reports/runs/2026-10-26T23-43-30-358Z-66528d10-c32c-45c5-b568-4abcd4d56f6c/report.json`。integrityErrorsは空。
- 最終コードで `bunx playwright test tests/browser/docling-startup.spec.ts`: 4件成功。通常、起動失敗後の再試行、設定取得失敗後の再試行、popup拒否。待受サーバーを作らない通信fixtureで確認した。
- 差分点検: 接続設定・認証方式・bundle revision・LLM指示・意味判断方式・domain依存は今回変更していない。共通query/取消/表示機構の修正に限定し、新たな自動再送・poll・台帳・leaseはない。担当外差分は保持し、今回変更したファイルのdiff checkは成功。
- 修正後の再レビュー: 今回の変更範囲に、根拠のある未解決の対応必須指摘は残っていない。前回記載した既存会話fixtureの失敗は修正しておらず、会話経由の受入成功とは扱わない。実接続、配備、サーバー起動・再起動は未実施。

見直し記録: 初回の回帰で設定取得・再試行順序・古い拒否表示とready境界の問題を再現し、修正後の部分29件が成功。続く再点検で再試行GET失敗時の表示と期限後の応答を追加し、修正後38件が成功。一括検証で見つかったtimeoutメッセージの型問題は既存の辞書取得とfallbackへ揃えて修正した。途中の共有ファイル更新を検出した検証記録は合格扱いにせず、上記の変更検出なしのpassを最終結果とした。要件や期待値を弱めず、指摘の再現→修正→再点検で完了した。
