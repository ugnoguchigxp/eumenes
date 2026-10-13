# 物体認識の正式gateway・実接続検証

2026-10-13、19:34〜19:44 JST。ユーザーのbackend再起動・設定済みLARM共有credentialによる実接続確認依頼を実施した。目的は既存実装の実接続と配備確認で、製品コード・Linux側の配備・認証設定は変更していない。

## 接続と正式配備

- LARM Controlの保存済み接続先: `http://192.168.0.130:9810`。backend settings domainの読み取り専用操作で取得した。再入力・環境変数による上書き・製品DBやcredentialのコピーは行っていない。
- backend起動環境の `LARM_API_TOKEN` を利用。値は表示・証拠保存していない。`GET /v1/local-services` とservice詳細が認証付きで200。`object-recognition-host` と `ocr-host` は独立して登録されている。
- Linux `larm-object-recognition-host-gateway.service` は `/etc/systemd/system` に正式配置され、enabled / active / running。`127.0.0.1:18796` でlisten。workerのapp/service/observe/stop unitも配置済み。配備releaseは `vision-ocr-host/7e97dbc683e120e5dbcea7382749bf4f5c4cfd2575f496f6db304baff4695811`。systemdの公開状態だけを[formal-systemd-status.txt](formal-systemd-status.txt)へ保存。
- 共通Page（sequence 2、更新19:05 JST）にはまだ「正式systemd配備・稼働LARM登録は未実施」とある。今回の19:35以降の実測は、それより新しい正式配備・登録の存在を示す。Pageは編集していない。
- MacBookでは `127.0.0.1:18796` → SSH `gnosis`（192.168.0.130）→ Linux `127.0.0.1:18796` を開いた。別hostのloopbackを直接使ったとは扱わない。両端のgateway origin・Hostが一致する同じポートのトンネルを使う。
- Eumenesの認証済みsettings PUTで接続先 `http://127.0.0.1:18796` と `credentialSource: larm` を保存（revision 1）。SQLiteを直接書き換えていない。公開APIのcredentialConfigured / sharedCredentialAvailableはtrue。backendは `http://127.0.0.1:8787`。

## 実接続の結果

[live-result.json](live-result.json)と各recordはEumenesの認証済み公開API経由の結果であり、fixtureの応答を注入していない。入力画像は [Ultralyticsの公開bus.jpg](https://github.com/ultralytics/assets/blob/main/im/bus.jpg)。確認用MP4は同じ実写画像を3秒と29秒表示する動画で、実際に動く物体の追跡試験ではない。入力とEumenesから取得した原本はSHA-256一致を確認。

| 検証 | 実結果 |
| --- | --- |
| 実画像 | yolo26n、810×1080。bus 1件、person 4件、元pixel座標とscore。約3.3秒で完了 |
| 3秒MP4 | yolo26n、600×800。0 / 0.5 / 1 / 1.5 / 2 / 2.5秒の6フレームで物体検出、約1.8秒で完了。実時間の短さによりrunning・数値進捗の表示は今回の正常動画では観測できず、前回の固定試験と区別 |
| 処理開始後の取消 | 29秒MP4をPOSTし、startingを確認してcancel。cancelling→cancelled、errorCode null、result null。約3.1秒。単なるHTTP待機の切断ではなく、取消APIと上流の終端確認に成功 |
| 会話へ取り込み | 動画のframeIndex 2（1秒）の物体名・座標を検証用会話へ保存。実LLMのrun `03eb3f2e-7e16-4a0b-86b1-a44a17f73099` がcompleted。main会話には試験文を追加していない |
| backend再起動 | 初めはEumenes backendが停止していたため起動。19:41:49にPID 58166をSIGTERMで正常終了（shutdown reason ok）、19:42:07にPID 59499 / 新bootIdで再起動。共有方式・revision・画像・動画結果・取消結果・原本を保持 |
| idle停止 | 最後の解析・取消後、認証済みControl GETだけを使用。19:42:40ではready、19:43:10ではstopped。停止までの正確な秒数はこの観測間隔では特定していない |
| 停止後の保存結果 | Eumenesの結果と元画像を取得できた。上流の解析POSTは再送していない |
| 次の操作で起動 | 停止状態generation 4から新しい画像POSTでgeneration 5 / ready、約4.3秒で完了。同じbus 1件・person 4件 |
| OCRの分離 | 各解析・取消・再起動前後のOCRはgeneration 5 / stoppedのまま。物体認識操作でOCRを起動していない |
| 秘密・認証 | 設定API・保存結果API・運用JSONLにLARM credential値がないことを検査。無認証gateway `/hosting/status` は401、設定済み共有credentialでは200。値はブラウザ・URL・モデルへ渡していない |

画像の主な座標: bus `[5.58, 228.87, 807.23, 749.24]`、person `[46.57, 398.75, 236.99, 901.75]`。本人識別・行動推定・同一個体追跡の検証ではない。全検出は[image-record.json](image-record.json)、動画は[video-record.json](video-record.json)、取消は[cancel-record.json](cancel-record.json)、再起動後の解析は[cold-restart-record.json](cold-restart-record.json)。HTTP相関IDもlive-result.jsonに保存した。

## 運用状態と範囲外

完了時点でbackend PID 59499とSSHトンネル PID 58483は起動中。MacBook/backendの再起動後はトンネルの再作成も必要。SSH接続の再作成は既存のgnosis設定を使う:

```sh
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -NT -L 127.0.0.1:18796:127.0.0.1:18796 gnosis
```

新しい解析POSTは検証段階ごとの意図した別入力として一回ずつ送信し、失ったPOSTの自動再送は行っていない。検証用結果は会話ID `object-recognition-live-2026-10-13` に保持した。backend lifecycleとqueue・会話runの相関ログ、[backend-final-status.json](backend-final-status.json)、[security-check.json](security-check.json)を保存。

会話run自体は成功したが、別の既存memory-agent処理に `larm_control_404` とembedding失敗を観測した。jobId `5e74baed-550b-4414-8126-376c568b7d49` / `3a77f54f-fb14-4e84-ab3e-857d1ede369c`。担当外として調査記録のみで、Profile・期待値・既存実装を変更していない。前回の全体gateのsettings→memory依存違反も今回のruntime確認で解消したとは扱わない。

MacBook物理カメラ・実際の動きがある動画・今回のlive結果のブラウザ表示/seekは未実施。前回の仮想カメラとArtifactの固定ブラウザ検証とは別。製品コードを変更していないためdomain/full gateは再実行せず、今回は実公開API→gateway→YOLO26n→保存→会話というlive経路を確認した。差分点検で追加したものは検証入力・実行手順・結果・作業記録に限る。
