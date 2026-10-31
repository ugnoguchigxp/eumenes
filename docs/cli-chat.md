# CLIの対話モード

起動済みのEumenesに、リポジトリのルートから接続します。

```sh
bun run cli -- chat
```

`>`に発言を入力し、Enterで送信します。返事を受け取ったら続けて入力できます。「画像を作って」「画面を作って」などの制作依頼や、確認質問への返答も通常の会話と同じ経路で処理します。作成・保存・確認の可否は既存の担当と設定に従います。CLIはアーティファクトを描画しません。画面上の操作が必要な場合はWebを使います。

標準ではWebと同じ`main`の会話を使います。CLIの発言・返信はサーバーに保存され、開いているWebにも反映されます。Web側の発言や後から届く制作完了の知らせもCLIに表示します。Webを後から開いても保存済みの会話を読めます。変更通知には既存のSSEを使い、定期取得はしません。

起動時は直近200件の会話を表示し、発言の本文は省略しません。古い発言は`history-search`・`history-read`で参照できます。CLIからはWebで開いている画面の内容を自動参照しないため、「これを変えて」などの依頼では対象を言葉で指定してください。

- `/exit`または`/quit`で終了します。
- Ctrl+CはCLIの待機と接続を終了します。受付済みの依頼はbackendで続くため、Webで会話を続けられます。
- 依頼を取り消す場合は、既存の`bun run cli -- cancel <run-id>`を使います。
- 送信結果が不明なときは表示されたrequest IDと同じ本文・会話IDを`send --request-id <UUID>`に指定します。自動では再送しません。

別の会話を使う場合と、発言ごとのJSON行を出力する場合:

```sh
bun run cli -- chat --conversation cli-demo
bun run cli -- chat --json
```

Webが表示する会話は現在`main`です。別のIDを指定したCLIの会話はWebの主会話には混ざりません。標準入力をパイプで渡すこともでき、各行を順に送信して応答を待ちます。入力終了後、最後の応答を受け取って終了します。制作を担当に引き継ぐ場合の応答は受付文です。その後の完了通知もCLIで読みたい場合は、対話モードを開いたままにしてください。

JSON出力の`type`は通常の発言が`message`、担当への受付文が`announcement`です。受付文もWebと同じ実行記録から読み、本文を省略せずに表示します。

接続先は既存CLIと同じ`EUMENES_URL`（既定`http://127.0.0.1:8787`）、API認証も同じ設定を使います。CLIがDBを開いたり、LARMやクラウドへ直接接続したりすることはありません。

実装方針と検証記録: [CLI対話モードの設計](../spec/cli-chat-mode-design-2026-10-31.md)。

## AIによる再現・デバッグ

このCLIは、AIエージェントがEumenesの会話backendを再現・調査するための入口としても使えます。Webと同じAPI・LLMの判断・担当への依頼・保存処理を通ります。対話の問題を調べるためだけにブラウザを操作する必要はありません。画面の描画、アーティファクト上の操作、Webで表示中の対象への参照、マイク・音声再生はCLIでは再現しません。

最初に警告ログと接続状態を確認します。backendの起動・停止・再起動には、プロジェクトの作業規則どおり利用者の許可が必要です。

```sh
bun run logs -- --level warn
bun run cli -- status --json
```

続いて、検証ごとに固有の会話IDを指定して、複数の発言を順に送ります。次の文面は再現したい発言に置き換えてください。

```sh
printf '%s\n' '最初の発言' '続きの発言' |
  bun run cli -- chat --conversation debug-unique-case-id --json
```

同じIDを使うと以前の会話を引き継ぎます。新しい条件の再現には新しいIDを使います。`main`を指定するとWebの普段の会話に反映されます。再現用IDの会話もサーバーへ保存され、依頼した処理は通常どおり実行されます。会話IDを分けることは、制作・外部操作の試行環境を分ける機能ではありません。

`chat`の標準入力は1行が1発言です。パイプ入力と`--json`では、最初の送信・応答の失敗で停止し、後続行は送りません。送信結果が不明な要求はrequest IDで確認し、自動で別の要求として送り直さないでください。通常の端末表示では、エラーを読んだ後に入力を続けられます。

標準出力は1行1件のJSONです。プロンプトや診断は混ざりません。

| 項目 | 読み方 |
| --- | --- |
| `type` | `message`は保存済みの発言・返信、`announcement`は担当への受付文 |
| `id`・`updated` | 同じIDの`updated: true`は訂正後の内容。受付文のIDはCLI表示用で、会話メッセージのIDではない |
| `role`・`text` | 発言者と本文。複数行の本文はJSONの文字列内に保持される |
| `conversationId`・`runId` | 会話と実行の追跡先。起動時の既存履歴も出るため、再現には固有の会話IDを使う |

失敗は標準エラー出力にも表示します。受付が不明な場合の`Request ID`は送信の重複防止に使うIDです。`API request ID`はHTTPの`X-Request-Id`で、運用ログの照合に使います。両者は別のIDです。JSONLには会話本文が含まれるため、本文を含めない運用ログとは分けて扱います。

| chatの終了コード | 意味 |
| --- | --- |
| `0` | 正常終了、またはCtrl+C等によるCLIだけの終了。受付済みの仕事は取り消さない |
| `2` | 引数・入力の不正、または認証失敗（HTTP 401） |
| `3` | 応答失敗・中断、応答の受信・同期の失敗、その他のAPIエラー |
| `4` | backend側でrunが取り消された |
| `5` | APIへの接続不能 |

出力のrunIdを使って、まず保存された実行状態を確認します。`--error-report`は失敗・中断したrunに対して使います。

```sh
bun run cli -- run <run-id> --json
bun run cli -- run <run-id> --error-report
bun run logs -- --id <run-id> --json
```

runのJSONにはrequestId・jobId・状態・期限もあります。必要ならjobIdや`API request ID`でもログを絞ります。会話runの`completed`はその発言の処理完了を意味します。担当へ依頼を渡した場合、制作物の完成まで保証する値ではありません。後続の仕事と完了通知は、会話や既存の担当別APIで確認します。詳しい追跡は[ログの確認](logging.md)を参照してください。

送信が不明な場合は、同じ会話ID・本文・request IDで照会・再試行します。複数行の本文を一度の発言として扱いたい場合も`send`を使います。

```sh
bun run cli -- send '同じ発言の本文' --conversation debug-unique-case-id \
  --request-id <request-id> --wait --json
```

CLI専用の固定試験は次の4本です。実HTTP処理とSSEは同一プロセス内で接続し、プロセス試験は接続不能なURLを使うため、テスト用サーバーを起動しません。

```sh
bun test api/application/cli-chat.test.ts \
  api/application/cli-chat-errors.test.ts \
  api/application/cli-chat-integration.test.ts \
  api/application/cli-failure.test.ts
bun run verify -- --domain conversation --domain dialogue
```

固定試験の成功と、実LLMの回答品質、実ブラウザでの表示・操作の成功は分けて記録してください。
