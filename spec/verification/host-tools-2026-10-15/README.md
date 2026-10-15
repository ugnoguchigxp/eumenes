# Lunaのホスト操作誤認：原因・修正・検証

2026-10-15。会話履歴・追加資料・モデル呼出しを増やさず、Lunaの既存SDK呼出しにおける指示の配置と付加文脈を修正した。

## 原因の確認

以前失敗した固定入力（TOOLSにweb.lookup、budget.canInvoke=true、operations=[]）を実SDKへ3回渡すと、2回はinvoke、1回は操作前にfinishを返した。ツールの欠落ではなく、ホストへ操作を依頼するJSONと、Codex自身のツール実行環境を混同する振る舞いだった。

ローカルの固定応答サーバーでSDKの実送信本文を確認した。EumenesのTOOLSと指示はbase指示へ届いていたが、SDKは別途スキル、permissions、会話モード、実行環境の説明を付加していた。CLI側にはEumenesのホスト操作とは別のnativeツール記述もあった。従来の「SDKへ渡した3メッセージ」の計測だけでは、これらの付加分を測れていなかった。

この観測から、ホスト操作選択の指示とCodexの実行環境説明が競合し得る構成を修正した。各フラグ単独の効果を証明したものではなく、以下の一組の変更を同じ入力で比較している。

## 修正

- 長いmissionを短く書き換え、ホスト操作を選ぶ役割をdeveloper指示へ移した。TOOLSはCodex nativeツールとsandbox/network accessから独立したホスト操作一覧で、invokeを受けたEumenesが実行することを明示した。
- 版付き調査方針、TOOLS、出力定義はbase指示に一度だけ渡す。タスク、原文、状態、資料の受け渡しは変更しない。
- この制御呼出しでのみ、SDKのスキル・permissions・apps・会話モード・環境の説明を省いた。これは説明の省略であり、read-only sandbox、approvalPolicy=never、プロセス分離、receipt、期限、取消の強制は維持する。
- lockedCodexの通常呼出しは従来の設定を保つ。モデル、公開API、DB、検索adapter、報告schema、修正回数は変更していない。取得をコードで強制したり、個別の地名・話題・応答文を判定する処理は追加していない。

## 入力量

| 計測 | 変更前 | 変更後 |
|---|---:|---:|
| Eumenesの指示＋固定SDK入力 | 8,191 bytes | 7,729 bytes |
| 固定内容によるSDK実送信本文（タスクを含むrequest） | 27,931 bytes | 23,738 bytes |

前者は462 bytes減、後者は4,193 bytes減。後者は固定の小さいhost指示を使った付加説明の比較で、実調査全体のサイズではない。CLIが付加するnativeツール記述・multi-agent関連の説明はこの設定でも一部残るため、「モデルにはEumenesの入力だけが届く」「native tool記述がゼロ」とは主張しない。今回の変更でそれらを新たに増やしていない。

## 検証

部分試験20件を先に通し、その後に以下を実施した。

```sh
bun run verify -- --domain inference --domain agent-runtime --domain dialogue
bun test api/application/search-agents-e2e.test.ts api/application/research-isolation.test.ts api/application/requirements-toolchain.test.ts api/application/delegation-context.test.ts
```

- domain検証：backend 354件、Web単体17件、境界・容量・整形・lint・型・共有build・source/build整合性が成功。
- domain検証run：`2026-10-15T14-31-16-854Z-34772626-9dd6-4876-b9bf-388a360f03d6`。
- API・queue・worker等の結合試験：46件成功。合計417件。
- 実SDKの同一失敗入力：変更前2/3回がinvoke、変更後3/3回が正しいinvoke。期待値・原文・TOOLS・状態は同じ。
- 別対象「函館市の人口」：対象と情報種別を保持したweb.lookupを選択。
- TOOLS=[]、canInvoke=false：invokeを返さずfinish。存在しない操作を作らない。
- 実SDK＋隔離API/queue/ホスト固定検索結果：invoke→ホスト検索→finishの2stepで、根拠付きV2報告が採用された。資料は東京の予報なので、鎌倉の予報を捏造せず不足を明記したpartialとなった。これは実Webから鎌倉の天気を取得した検証ではない。
- SDK単体試験でdeveloper指示とbase指示の分離、TOOLS・出力定義の非重複、制御指示700 bytes未満、付加説明の省略、取消、異常終了、生応答を通常ログへ残さないことを確認。
- git diff --check、および個別語句への依存・意味判断のコード化がないことの差分点検：成功。

UI変更がないためブラウザE2Eは省略。実Web取得adapterは変更していないため、実Webの網羅性や予報の正しさは今回の完了条件に含めない。実モデルの少数試行は将来の全応答を保証しない。

固定入力のSDK採取・前後比較はprivateな `verification-reports/host-tools-2026-10-15/` に0600で保存した。通常ログへ会話本文・認証情報・Provider生応答を追加していない。ContextStillのcompile/evalはこの会話を通じて6回ずつ。稼働中アプリの再起動・配備は行っていない。別作業の文書変更には触れていない。
