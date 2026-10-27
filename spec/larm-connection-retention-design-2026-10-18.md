# チャット画面表示中のLARM接続維持

状態: 画面表示中だけ既存のProfile利用依頼APIを定期送信するEumenes側の実装・固定試験・実接続受入を完了（§11・§12）。同じConnectionを6分保持し、送信停止後に自動解放されることを確認した。利用者のbackend再起動後、稼働APIと実画面への反映も確認済み。以前の自動再接続による代用案は撤回済み。LARM本体・自動解放設定・既存の別作業の差分は変更していない。

最新方針（§11・§12）: 専用のownership API・認証は採用しない。既存の`POST /v1/agent-connections`によるProfile利用依頼を、画面表示中だけ定期送信する。ユーザーが依頼したLARM側の既存API修正の反映後、Eumenes側の実装で期限延長を確認した。§7〜§10は経緯と以前の配備・実測の記録であり、そこに記した専用認証を続行条件としない。

2026-10-18 実装範囲の確定: ユーザーは「Eumenes側だけ改修する」を選択した。現行LARMソースでもrenewと無操作解放が別で、保存済みProfileのcatalogは`idleRelease.enabled=true`だった。以降の実装はEumenes側のローカル保持と、画面表示中の30秒ごとの接続状態確認・解放済み接続の自動再確保に限定する。同一Connectionの恒久保持は保証しない。LARM側の変更・架空の保持API・ダミー推論は追加しない。

上記の自動再接続による代用案は、ユーザーの「所有を維持出来るようにしてください」を受けて撤回した。所有維持に代えて接続を作り直す処理を完成条件にしない。以下の設計案は、正式な所有維持手段が確認できた場合の実装案として残す。

## 1. 目的と完了条件

チャットのメイン画面が表示され、backendが稼働している間は、無操作でも主会話のLARM接続を維持する。利用者が次に話す際のProfile再準備を減らす。ネットワーク断やLARM停止時の接続継続を保証するものではない。

ユーザーの「画面が開いてる間だけでいいかな」を受け、「画面表示中」と「backend稼働中」の両方を保持条件とする。画面を閉じた後のbackend単独での常時保持は行わない。

完了条件は、固定試験・結合試験に加え、実LARMで無操作の5分境界と接続更新を跨いで同一Connectionを保持し、その後の送信に成功すること。画面を閉じた場合の保持解除、設定変更・権限失効・backend終了時に古い接続や保持処理が残らないことも確認する。

## 2. 確認した現状

- `docs/acceptance.md` の2026-10-08の記録では、300秒無操作で接続を解放し、他用途のProfileへの切替を許す方針。health / renewでは無操作期限を延長しない。
- `api/domains/larm/service/index.ts` の無操作期限は300,000ms。`lease-manager.ts` のtimerがローカルleaseとready表示を破棄し、次回利用時に再確保する。無操作timer自体はLARMへDELETEを送らない。
- `lease-manager.ts` はcredential期限の180秒前に更新を試みる。`refresh.ts` は期限が十分残る場合にrenewを行わないため、既存のconnectを定期的に呼ぶだけでは保持を実現できない。
- `api/application/server.ts` は起動後に一度接続確認を行う。`web/src/workspace/useWorkspace.ts` は状態取得と手動再接続を持ち、画面の存在をbackendに伝える契約はない。
- 2026-10-18に保存済みsettingsを読み取り、接続先の公開OpenAPIをGETした。Connectionには`expiresAt`と別に`lastForegroundActivityAt` / `idleReleaseAt`がある。renewの入力は`ttlSeconds`のみで、専用のheartbeat / keepalive操作は見つからなかった。renewによる無操作期限延長の保証は公開記述から確認できない。
- 最近の警告ログに接続モデル一覧APIの502があるが、今回の無操作解放と同一原因とは断定していない。

これはLLMの指示や判断の問題ではなく、接続の寿命管理の変更である。既存の確保・claim・renew・再接続・終了処理を再利用し、LLMへのダミー推論で接続を維持しない。

## 3. 採用する保持方針と実装案

### 3.1 保持条件と責務

Webは、メインのチャット画面がマウントされ、documentがvisibleである間だけ、認証済みのEumenes APIに画面の存在を伝える。タブごとに独立した識別子を使い、複数タブでは一つ以上が有効なら保持する。hidden時・画面離脱時は解除を試み、通信不能・ブラウザ強制終了時はbackend側の期限で解除する。

画面の存在通知は30秒ごと、有効期限は最終受信から90秒とする案。これはLARMの更新周期とは別の、画面消失を回収するための期限である。復帰時は即時通知する。通知APIの入力は識別子と状態に限定し、認証済み利用者へ紐付け、件数を制限する。credentialやLARM接続先をWebへ渡さない。

backendのapplication / inferenceが保持要求をまとめ、現在の保存設定に対応する主会話portだけへ渡す。保持要求が有効な間の接続維持はLARM domainが担い、画面の存在通知ごとにConnectionを作成しない。補助control要求・画像生成等の一時接続には保持を適用しない。最初は既存どおりLLMのみを確保し、音声Providerは音声利用時に既存経路で確保する。

保持解除後は既存の300秒無操作方針へ戻す。実推論の最終利用時刻を正本とし、既に300秒を過ぎていれば速やかにローカルleaseを失効させる。画面通知を推論の利用履歴として扱わない。

### 3.2 LARM側の前提

実装前に、LARMが正式に許可する「推論せずに無操作解放を延期する操作」を確定する必要がある。renewがその役割を持つなら、`idleReleaseAt`の延長と他用途への切替方針を仕様または再現可能な試験で確認する。持たない場合はLARM側の契約追加が必要になる。公開されていない入力項目やendpointを推測して呼ばない。

この前提が確定するまでは、ローカルtimerの停止だけで接続維持済みとは扱わない。実LARMの無操作解放を防げない場合、保持要求中のready表示は実状態に追従する。

### 3.3 既存処理との統合

- 保持は既存のlease managerへ最小限の寿命条件として加える。更新はcredential期限とLARM側の確定した無操作期限に従って予約し、同時更新をまとめる。
- renew後の再claim・全Providerの整合性検査・credential一括交換を再利用する。推論中のcredential交換を避ける既存の利用数管理を保つ。
- 通信失敗時は接続失敗を状態へ反映する。再試行は上限付きの間隔増加で行い、保持解除・設定変更・権限失効・port終了で止める。具体的な周期はLARMの保持契約と合わせて実装前に確定する。
- 設定変更では旧portの保持を解除し、現在の保存設定へ移す。終了済みportへ遅れて届いた保持・更新結果を採用しない。
- 終了・取消・解放確認済み拒否の復旧・公開済みSSEの再送禁止は既存契約を保つ。生成POSTを接続監視に使わない。
- 主会話接続を保持する分、共有LARMの接続枠・モデル資源を長く使用する。別用途への無操作切替を抑えることが今回の仕様変更になる。

DBスキーマ・モデル選択・Profile名・認証方式・LLMの意味判断は変更しない。別のCodexチャットへの依頼送信、LARM本体の変更、サーバーの起動・停止・再起動はこの案の実装許可に含めない。

## 4. 作業順と検証

1. 保持範囲は合意済み。LARM側の正式な保持操作を確定する。確定後、現行の無操作試験を変更前の基準として記録する。
2. LARM domainの部分試験。保持中の5分境界、保持解除後の失効、renewと再claim、推論中の更新、更新失敗、closeと遅延応答の競合を固定時計とfixtureで確認する。保持しない一時接続の既存期待値は維持する。
3. application / inferenceとWebの結合試験。複数タブ、hidden、復帰、通知喪失、90秒失効、設定切替、権限失効を確認する。未認証通知では保持できないこと、件数上限も確認する。
4. `bun run verify -- --domain larm --domain inference --domain voice-dialogue`。実装で変えたdomainやWeb側の所有領域を確認し、必要な選択検証を追加する。担当外の失敗は証拠を記録し、この作業で無断修正しない。
5. 対象を明示したブラウザE2Eで表示・離脱・複数タブを確認する。サーバー操作が必要なら別途許可を得る。
6. 実LARMで5分以上無操作かつ少なくとも一度のrenewを跨いだ同一Connection保持と、その後の送信を確認する。保持解除による資源返却も確認する。既存稼働環境に影響するProfile占有を伴う場合は、実施条件を先に利用者へ示す。
7. 差分を点検し、個別の発話・Profile・モデル名への依存、無関係な変更がないことを確認する。fixture、live、実機器の結果を分けて報告する。

## 5. 今回の到達点と残作業

完了: 現行設計・実装・既存試験の確認、警告ログの確認、保存済み接続先の公開OpenAPIの読み取り、変更案と検証条件の作成。

未実施: 製品実装、試験実行、実接続の保持試験。製品差分がないため部分→結合→通しの実行検証は省略した。OpenAPIの読取り成功を、接続保持のlive成功に数えない。

2026-10-18の追加確認: 公開OpenAPIのConnection作成・claim・renew・healthと、activityを含む操作を確認した。renew入力は引き続き`ttlSeconds`のみ。`GET /v1/activity`は処理状況の観測で、保持要求ではない。現在公開されている契約から、無操作解放の延期方法を確定できなかった。

参照専用のSAAAに保存された2026-09-26時点のLARM controller資料では、renewはallocationとcredentialの期限を更新し、無操作期限は実際のforeground要求の終了時刻から別に計算されていた。これは既存のEumenes受入記録と整合するが、現在配備されたLARMの実装そのものの証明ではない。SAAAのDB・設定・秘密は参照・コピーしていない。

残作業はLARM側の保持契約の確定から。保持方法の新しい根拠がない状態では、connect / health / renewの反復やローカルtimer停止による製品実装を進めない。LARM側の契約が確認できれば、§4の順で許可済みのEumenes実装を再開する。

## 6. LARM側に確認する内容

依頼内容: Eumenesのメインのチャット画面が表示されている間だけ、主会話Connectionを、推論リクエストなしで保持したい。画面離脱・通知失効・backend終了では保持を解除し、既存の無操作解放へ戻したい。モデル・Profileの選択や生成処理は変えない。

確認事項:

1. 現行の正式な操作で`idleReleaseAt`を延長または一時停止できるか。可能ならmethod / path / schema・認証・必要な権限と、renew / claimの要否を示してほしい。`expiresAt`だけの延長では要件を満たさない。
2. 専用操作が必要なら、Connectionに対する期限付きの保持要求と、解除・失効時の意味を正式契約として定義してほしい。更新が止まった保持要求は自動失効し、画面離脱後に資源を占有し続けないことが必要。
3. 共有資源との競合・優先処理による解放時に返る状態とエラー、保持可能な上限・推奨更新周期、再起動後の扱いを示してほしい。既存の接続枠・他consumerへの影響も確認したい。

受入条件: 実推論なしで300秒を跨ぎ、credential更新も跨いで同じConnectionがreadyを維持する。保持解除・通知失効後は無操作解放へ戻る。保持できない場合はその状態を観測できる。ダミー推論、Profile名別の特例、稼働サーバーの再起動で代用しない。

この確認内容は文書として準備しただけであり、別のCodexチャットや外部への送信はしていない。

## 7. プロファイルの再要求による所有維持の実接続確認

2026-10-18、ユーザーの「プロファイルリクエストが所有権と取得と同じなのでAPIを叩けばよい」という指摘を受け、renewではなく、既存の`POST /v1/agent-connections`の再要求を確認した。

方法: backendのsettings公開読取り操作で保存済み接続先・Profile・audienceを取得し、そのProfileのcatalog revisionを使った。検証専用のclient識別子でLLMのみを要求し、readyを待って2秒後に同一client・同一要求内容を新しいIdempotency-Keyで再送した。推論は送らず、取得した検証用ConnectionだけをfinallyのDELETEで解放した。製品設定・LARMコード・自動解放設定・サーバー起動状態は変更していない。

| 観測項目 | 1回目 | 2回目 |
| --- | --- | --- |
| Connection | 同じConnection | 同じConnection |
| `idleReleaseAt`（JST） | 2026-10-18 11:56:47.206 | 2026-10-18 11:56:47.206 |
| `expiresAt`（JST） | 2026-10-18 12:06:47.015 | 2026-10-18 12:06:47.015 |

再要求は既存Connectionを返したが、どちらの期限も進まなかった。現在の配備先では、「同じProfileを再要求すれば、既存Connectionの無操作期限が延びる」という仮説は成立しなかった。これは2回の要求による期限比較であり、5分超の所有維持試験に成功した記録ではない。

参照した現行LARMソースでも、同じsession scopeの再要求は既存Connectionの公開状態を返し、idle timerを更新していなかった。renewもallocationとcredentialの期限更新であり、foregroundの無操作期限更新ではない。公開APIの名称だけで所有維持が可能と判断せず、上記の実測を採用する。

検証: 変更前の既存LARM lifecycle試験17件は成功。途中の画面通知・自動再接続試験の成功は、所有維持の成功には数えない。取り下げた製品差分の完全な除去を確認し、既存試験を再確認する。変更が文書のみとなるため、結合・ブラウザの通し検証は行わない。

続行条件: 現行配備先で無操作解放期限を延長できる正式操作・追加の要求項目・応答契約など、新しい根拠が確認できること。同じ内容のPOSTを繰り返す、ダミー推論を送る、LARMや設定を無断変更する方法では続行しない。

## 8. LARM実装・再起動完了の連絡後の確認

2026-10-18、ユーザーの確認依頼に基づき、更新ソース・固定試験・保存済み接続先の稼働API・systemdの起動状態を確認した。こちらではLARMコード・設定・秘密・配置・サービスの起動状態を変更していない。

### ソースと固定試験

`/srv/ai/apps/local-LLM-harness` の作業ツリーに、以下の正式契約が追加されている。

- Connection取得時に`ownership: { id, issuedAt }`を指定する。
- `PUT /v1/agent-connections/{id}/ownership`へ`{ id, sequence }`を送り、30秒周期・90秒期限で所有を更新する。
- 同じpathへのDELETEで保持だけを解除する。連番・失効・解除を検査し、古い通知で所有を復活させない。
- credential期限と所有期限は別。renew / claimは従来どおり必要。
- 優先権は専用consumer credentialに結び付ける。共有token・任意のclient名では所有を取得できない。

LARM側の`specs/connection-screen-ownership-2026-10-18.html`と上記のcore schema・controller・routeを確認した。ソースは未コミット差分を含むため、HEADのcommitだけではこの追加実装を識別できない。

次の固定試験を実行し、46件成功・0件失敗を確認した。

```sh
bun test apps/daemon/src/usage-integration.test.ts packages/core/src/agent-connection.test.ts packages/core/src/api-contract.test.ts
```

固定時計での5分超の保持、credential更新、他consumerの拒否、保持終了後の取得、90秒失効、連番・再送・遅延要求・認証・handoverを含む。実Providerへの長時間の実接続試験とは区別する。

### 稼働環境の確認結果

| 確認 | 結果 |
| --- | --- |
| 保存済み接続先の`GET /health` | HTTP200、status=ok |
| `releaseCommit` | `764c0a86c7f99e93d56fd5f2f81ff54f99f51d9e` |
| `bootEpoch` | `epoch-2f698767-e641-4503-927a-c9920be724d5` |
| 保存済み接続先のOpenAPI | ownership path・新規取得のownership入力とも未掲載 |
| 存在しない検証IDへのownership PUT | HTTP404 / not_found（実Connectionは作成していない） |
| `larm-daemon.service` | active / running、MainPID=937613 |
| serviceの起動日時 | 2026-10-18 06:08:53 JST |
| WorkingDirectory | `/srv/ai/apps/larm-current` |
| currentの実体 | `/srv/ai/apps/larm-releases/764c0a86c7f9` |
| current側のroute / schema | ownershipの記述なし |

ソース実装はあるが、Eumenesが接続しているサービスには反映されていない。稼働先のpreflightが不合格のため、実接続での取得・30秒更新・5分超保持・ContextStill相当の競合・解除試験は実行していない。未搭載endpointを繰り返し呼んだり、別の接続先へ勝手に切り替えたりしない。

次の続行条件: 更新ソースを含むreleaseが保存済み接続先に反映され、OpenAPIにownership操作が掲載されること。その後、Eumenes backendで専用consumer権限を利用できることを確認し、実接続受入へ進む。専用credentialの配備・権限は今回の旧版APIへの確認だけでは判定していない。

## 9. 配備反映後の再試験

2026-10-18、再試験依頼を受けて保存済み接続先へ再接続した。前回からの変更条件は稼働releaseとboot epochの更新、新APIの掲載である。

| 確認 | 結果 |
| --- | --- |
| `GET /health` | HTTP200、status=ok |
| `releaseCommit` | `51873b6ddf0a7a5038736dd0bb41332a5072b2db` |
| `bootEpoch` | `epoch-62e3aa3e-c499-4378-b9c4-929d4429733f` |
| OpenAPI | ownership PUT / DELETEと、取得入力のownershipを掲載 |
| 保存済みProfileのcatalog取得 | 成功 |
| Eumenesの既存backend認証でownership付きConnection取得 | HTTP403 / consumer_credential_required |
| 検証用Connection作成 | なし（認証権限の検査で拒否） |

取得要求は保存済みProfile・audienceと最新catalog revision、検証専用のclient・所有UUID・現在のissuedAtを使い、LLMのみを指定した。tokenの値は出力・保存していない。Eumenesの認証解決は既存の`resolveLarmToken`を使用し、他consumerの秘密をコピーして権限検査を回避する操作は行わなかった。

新APIの配備反映は確認済み。一方、Eumenesの現在の認証には所有維持権限がないため、所有取得以降の30秒更新・5分超保持・credential更新・ContextStill競合・保持解除の実接続受入は未実施。前回の固定試験46件の成功を、この実認証によるlive成功へ読み替えない。

LARM側の更新文書にも、実Providerの360秒試験は一時検証daemon・一時credentialで成功し、本番の専用consumer認証は未設定と記録されている。これは参考情報であり、Eumenesの実認証による上記403を今回の正本とする。

続行条件は、Eumenesのbackendが正式に専用consumer権限を利用できるようになること。認証設定・秘密・自動解放設定・稼働サービスは今回の再試験では変更していない。

## 10. 更新版での占有期限の直接比較

2026-10-18、ユーザーの「占有期間が延長されるか」という確認依頼に合わせ、更新版に対してEumenesの既存接続先・認証・保存済みProfileで実測した。今回はownership取得の権限確認だけでなく、通常のProfile要求とrenew前後の`idleReleaseAt`を比較した。

| 操作 | `idleReleaseAt`（JST） |
| --- | --- |
| 検証専用clientによる初回取得・ready確認 | 2026-10-18 12:46:26.752 |
| 約1.5秒後の同一client・Profile再要求 | 2026-10-18 12:46:26.752 |
| 同じConnectionのrenew | 2026-10-18 12:46:26.752 |

3回とも同じ期限で、通常のProfile再要求・renewによる占有期間の延長はなかった。ownership PUTも既存認証では403 / consumer_credential_required。現在のEumenes接続条件では占有期間を延長できない。

実推論は送らず、検証専用Connectionは最後にDELETEの204で解放を確認した。設定・認証・サーバー状態は変更していない。今回は既存手順の検証だけのためcontext_compile / compile_evalは各0回。

## 11. 既存Profile利用依頼APIを使うEumenes側の準備

2026-10-18、ユーザーがLARM側へ既存APIの修正依頼を送信し、Eumenes側の準備を指示した。§3のownership専用操作を前提とする案は採用しない。

実装範囲と依存順:

1. Webはチャット画面が表示されている間、30秒周期でEumenes APIへ生存通知を送る。非表示・pagehide・画面終了では停止通知を送る。複数タブは個別に識別し、一つ以上が有効なら継続する。backendは通知から90秒で期限切れとし、古い通知が終了状態を戻さないよう連番と通知時刻を検証する。
2. inferenceは有効な画面通知を現在の保存設定に対応する主会話portへ束ねる。設定変更時は旧portへの定期要求を止め、新しい設定へ移す。補助session・画像生成等の一時接続は保持しない。
3. LARM portは既存の確保・claim・renew・取消・終了処理を使い、初回要求のclient・Profile・audience・Provider subset・catalog revisionを保持する。画面表示中は30秒周期で、同じ既存`POST /v1/agent-connections`へ同じ内容を新しいIdempotency-Keyで送る。GETやrenewだけで延長を代用しない。返されたConnectionが同じ対象であることと契約を検証し、別Connectionへの置換を成功扱いしない。要求失敗時は状態に反映し、通常の次の30秒周期で再試行する。
4. 定期POST自体を推論活動として記録しない。ローカルの無操作timerによる接続破棄は表示中だけ抑え、画面保持終了後は従来の無操作方針へ戻す。設定変更・通知失効・port終了で旧処理を中止し、遅れた応答を採用しない。credential期限と再claimは既存機構で扱い、表示中であることだけを根拠にcredential期限を延長しない。
5. 固定試験で同じ要求内容・新しい冪等key・credential更新との並行・音声Provider構成・取消競合・複数タブ・通知失効・認証・古い通知の拒否を確認する。部分→API結合→Webの順で検証し、`bun run verify -- --domain larm --domain inference --domain voice-dialogue`も実施する。担当外の失敗は修正せず記録する。
6. LARM側の反映後に、既存認証・同じConnectionで期限が進むことと、6分以上の無推論保持・送信停止後の解放を実接続で確認する。サーバーの起動・再起動は今回行わない。ブラウザE2Eにサーバー起動が必要なら、固定試験の結果と未実施理由を区別する。

この準備の完了条件はEumenes側の実装・固定試験・差分点検であり、LARM側の期限延長がliveで成功したと報告しない。ContextStillの状態・優先順位・専用credential・新しいLARM API・モデル名別の分岐は追加しない。DBスキーマ・製品設定・秘密は変更しない。

実装済み:

- `useScreenPresence`と既存clientの`screenPresence`が、画面の可視状態・pagehide / pageshow・画面終了・onlineを通知する。Eumenes内の認証済みPUTは既存のauth / origin検査を通り、連番・送信時刻・入力サイズ・最大64画面を検証する。
- inferenceの`createScreenPresence`が複数画面と90秒失効を管理し、保存設定が指す主会話portだけの`retain`を切り替える。初回Profile確保時の要求内容をleaseに保持し、定期送信では既存`createConnection`を再利用する。
- ローカルの無操作timerを画面保持中だけ抑える。通常の定期要求ではready表示を点滅させず、通信失敗は既存statusへ反映する。再要求が別Connectionを返した場合はそのport固有のclientに属する余分な接続を解放し、失敗とする。
- 既存の内部lease更新処理と固定のControl tokenを維持する。`LARM_API_TOKEN`は変更も再発行もしない。終了時の遅延応答の不採用を検査し、画面停止直後のidle timerが最終DELETEを飛ばす競合も再現試験を追加して修正した。

固定試験: 同じPOST内容・新しい冪等keyによる6分相当の周期送信、音声Profile構成、固定Control認証、既存推論との並行、要求失敗からの次周期の再試行、終了中の遅延claim、終了timer競合、複数画面、通知途絶、遅延・重複通知、設定切替、認証・origin・入力検証を確認した。6分は固定時計によるfixture試験であり、実LARMでの占有延長成功ではない。

検証は、当初のサイズ検査の指摘に対して接続状態通知・終了待ち・設定からのport構築を小さな既存責務へ分離し、上限を変更せず通した。最初のdomain選択検証はbackend401件・Web48件で成功。差分点検で見つけた終了timer競合の修正と1試験追加後の最終版も、backend402件・Web48件で成功した。型・書式・lint・境界・サイズ・DesignSystemの検証を含み、入力hashの変更は検出されなかった。

最終結果: `spec/verification/reports/runs/2026-10-18T03-58-09-442Z-12e8efc3-5905-4580-805f-65997def1ef8/report.json`（pass）。

API結合は既存app試験を含め19件成功、画面通知・共通client・App smokeは5件成功。ブラウザE2E・実LARMでの期限延長受入は未実施で、稼働サーバーの起動・停止・再起動やLARM側の変更は行っていない。

差分点検: 他作業のmonitoring、会話、UI制作などの変更は保持した。Profileとmodelの固定値・ContextStillの識別や優先順位分岐・別のLARM認証は追加していない。コードに追加した連番・UUID・時刻・件数・応答照合は画面生存と外部API契約の検証に限定され、発話の意味判断を代替しない。

## 12. LARM更新後の実接続受入と稼働反映確認

2026-10-18、LARM側の既存API修正完了の連絡を受け、保存済み接続先・Profile・audienceと既存の固定`LARM_API_TOKEN`で検証した。稼働LARMの`releaseCommit`は`0baea1ede627b6b078f59db4d8cf3215709fe690`。LARM側のAPI契約と先行受入記録は `/srv/ai/apps/local-LLM-harness/specs/agent-connection-demand-refresh-2026-10-18.html` を参照した。こちらではLARM・秘密・設定を変更していない。

### 初回liveで確認した応答検査の誤りと修正

最初の試験では既存POSTで期限は延びたが、30秒後にEumenesが`larm_retention_provider_changed`としてfailedを報告した。LARMの現行`agent-connection-controller.ts`の公開応答は、`claimable`をsemantic probeのcacheがreadyかどうかで計算し、`semantic-readiness.ts`の成功cacheは10秒で失効する。実接続GETでも、ConnectionとProviderがreadyのまま`claimable=false`になることを確認した。

取得済みclaimを持つ保持処理に「新たにclaimできる」を必須としたのが誤りだった。保持応答からこの条件だけを外し、Connection・Profile・Providerのmodel/protocolとready状態・有効期限の照合は維持した。初回取得のready/claimable検査、claim、期限更新は変更していない。疎通確認のための推論を周期的に追加する対応もしていない。

固定回帰試験を先に追加し、修正前は8件成功・1件失敗で再現した。修正後は保持試験9件成功。cache失効後も同じ取得済みConnectionで回答でき、claim追加やhealth要求が増えないことも確認した。初回liveのConnectionはDELETE 204で解放してから、修正済み処理の試験を新しく開始した。

### 実接続の測定結果

HTTPリスナーや一時backendサーバーは起動せず、改修済みHono画面通知controllerへ`app.request`で入力し、inferenceの画面寿命管理とLARM portの実装を通して保存済みの実LARMへ送信した。初回connect/claimを済ませてから保持区間を計測し、画面通知を30秒周期で送り、停止時はactive=falseを通知した。各新規利用依頼のKeyの一意性、要求bodyの一致、固定Control認証を検査した。保持区間中に実装・runnerを変更していない。

| 項目 | 結果 |
| --- | --- |
| 保持時間 | 362.131秒（6分2秒） |
| Connection / Allocation | 全期間同じ各1件 |
| `idleReleaseAt` 初期値（JST） | 14:26:58.123 |
| `idleReleaseAt` 最終値（JST） | 14:32:59.231（361.108秒延長） |
| 新しいKeyのPOST | 初回1回＋保持中13回、全14回201、全Keyが別 |
| 同じKeyの再送 | 1回201、GETで前後の期限が同じことを確認 |
| 保持区間のEumenes推論要求 / 追加claim | 各0回 |
| 停止後の新しい利用依頼 | 0回 |
| 自動解放の観測（JST） | 14:32:59.256、status=released |
| 最後の新しい利用依頼から解放観測まで | 300.067秒 |
| 停止通知から解放観測まで | 299.021秒 |
| 終了時の検証Connection削除 | DELETE 204 |

停止後はGETだけで観測し、保持期限は延長されなかった。推論0回はこの検証portが保持区間に送信した要求の数であり、共有LARM全体のProvider counterの測定とは区別する。初回claimの疎通確認は計測区間外。ContextStillの呼出しや優先順位判断はEumenes側に追加していない。

### 固定試験・稼働反映・完了点検

修正後の`bun run verify -- --domain larm --domain inference --domain voice-dialogue`はbackend403件・Web48件成功。型・書式・lint・境界・サイズ・SystemContext・DesignSystem・入力hash検査も通過した。最終結果は `spec/verification/reports/runs/2026-10-18T05-22-13-957Z-2ea6ec93-2d52-4d0d-b67a-90296c6bc052/report.json`。§11のAPI結合19件、画面通知・client・App smoke 5件の結果も保持する。

初めの稼働Eumenesは画面通知APIが404で未反映だった。ユーザーが再起動を実施し、14:24:24の起動後に同APIの204、status APIの200/readyを確認した。さらに14:29:59の実ブラウザでdocument.visibilityState=visibleと「LARMの接続状態: 接続済み」、14:30:05のstatus APIでreadyを確認し、起動時のローカル無操作5分境界を超える接続保持も確認した。検証用に開いたブラウザタブは最後に閉じた。こちらから稼働サーバーの停止・起動・再起動は行っていない。

実ブラウザでは可視状態と接続表示を確認した。非表示通知・複数タブ・90秒失効・古い通知・設定変更は固定試験、6分保持と停止後解放は上記のcontrollerから実LARMまでの結合試験で確認した。これらを実ブラウザによる全操作のE2Eと読み替えない。

検証記録: [live](verification/larm-profile-retention-2026-10-18/live.json)、[初回失敗](verification/larm-profile-retention-2026-10-18/first-live-failure.json)、[cache失効の観測](verification/larm-profile-retention-2026-10-18/cache-observation.json)、[稼働反映](verification/larm-profile-retention-2026-10-18/deployment.json)。接続先・設定・Profile名・モデル名・認証値やKeyの値は保存していない。

差分点検では無関係な他作業の変更を保持し、新しい発話別・Profile別の分岐やLLMの判断を代替する処理は追加していない。今回の追加修正は外部契約で意味の異なるclaim可否と取得済みConnectionの保持を区別する範囲に限定した。Context Stillは今回context_compile 1回・compile_eval 1回で、取得したcontextの一般的な最小変更・検証手順を利用し、API契約は現行実装と実測を根拠にした。
