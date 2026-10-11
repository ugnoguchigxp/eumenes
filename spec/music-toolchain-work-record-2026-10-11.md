# 楽曲生成と再生のツールチェーン 作業記録

記録日: 2026年10月11日。調査時の HEAD: `8dc69ea`。

現在の状態: 楽曲担当・Skill・SystemContext・生成API・OpenUI Artifactの接続とCodex Skill化を実施済み。最新の作業単位10では生成のOpus対応、実生成1曲、保存音声のブラウザ確認、全体回帰を完了した。各作業時点の結果は末尾の続行記録で区別する。音楽再生プレイヤーツールチェーンの分離は後続作業。

会話から楽曲生成APIを利用し、生成した曲をArtifactで再生する機能の着手記録。初回の記録時点では既存コードの調査と再利用候補の整理まで行った。その時点では新機能の実装、楽曲生成APIの実行、動作試験は行っていない。続行後の実装・検証結果は末尾の作業単位別記録と[受入記録](verification/music-2026-10-11/README.md)を参照。ユーザーの依頼により、実装を進める前にこの記録を保存した。

後でCodexのSkillにするため、事実と手順候補を分けている。以下は初回調査の記録を保存したもので、末尾の「続行記録」以降に実装・検証の実績を追記する。

## 依頼と目標

ユーザーの依頼は、楽曲生成API、サブエージェント、Skill、SystemContext、Artifactを組み合わせ、指定されたテーマを装飾して楽曲を作り、再生できるようにすること。受入用の入力は「Tetrisを30秒だけ作る」。

- 会話でユーザーのテーマと長さを受け取る。
- 楽曲担当のLLMが、テーマに合う曲調、楽器、構成などを生成用の指示に整える。
- 既存APIを呼び、生成結果を取得する。
- 会話へ結果を戻し、Artifactから再生できるようにする。

Tetrisは試験入力にだけ使う。特定の作品名や発話に対応した分岐、辞書、固定の生成プロンプトを製品コードへ追加しない。

ここでいうサブエージェントとSkillはEumenesの製品機能を指す。後で作るCodexのSkillは、この機能追加の手順を再利用するための別の成果物である。

## 実施した作業

| 作業 | 結果 |
| --- | --- |
| 楽曲生成APIの既存接続を確認 | LARM domainに生成、進捗取得、成果物取得、取消の実装がある |
| 既存の利用画面を確認 | 設定の「サービスを試す」に楽曲の試聴と保存がある |
| 会話からの起動と結果返却の入口を確認 | dialogue、agent-runtime、capabilities、applicationの接続箇所を調査した |
| Artifactの既存型と表示入口を確認 | markdown、showcase、timerがあり、楽曲用の型はない |
| 既存試験とfixtureの所在を確認 | 楽曲の成果物取得と取消の試験、fixture APIがある。今回は実行していない |
| 実装方針を整理 | API接続を再利用し、テーマの装飾をLLMに任せる方向をユーザーへ説明した |

今回の楽曲作業では製品コードを変更していない。APIへの生成要求も送信しておらず、今回のjobId、音声ファイル、再生結果はない。

## 確認できた既存機能

### 楽曲APIと実行管理

接続の実装は [playground.ts](../api/domains/larm/service/playground.ts)、型は [playground contracts](../api/domains/larm/contracts/playground.ts)。`createLarmPlayground` がサービス発見、実行、成果物取得、既存楽曲jobの追跡を提供する。楽曲用selectorは `SAAA-w-music`、protocolは `larm.music-generation.v1`。

現在の楽曲要求は以下の形になっている。これは既存コードの事実であり、今回新たに決めた仕様ではない。

```json
{
  "prompt": "input.text",
  "model": "target.model",
  "durationSeconds": 10,
  "instrumental": true,
  "outputFormat": "mp3",
  "quality": "balanced"
}
```

`prompt` と `model` は実際には入力と発見した対象から渡す。`durationSeconds` は指定値を渡し、未指定時のみ10秒になる。

- 生成POSTは202応答からjobIdを受け取る。既知のHTTP拒否と、生成されたか分からない `generation_unknown` を区別する。
- `musicJob` は同じjobを追跡する。状態は queued、loading、generating、encoding、completed、failed、cancelled。
- 完了時はjobId、成果物metadataのID、取得先のpathなどを検査し、音声を取得する。サービス一覧のモデル名と実行モデル名は異なることがあり、実行モデル名を別に扱う。
- 取消後に遅れて202応答が返った場合も、jobIdを回収して同じjobへ取消を送る処理がある。

サービス試用側の [service/index.ts](../api/domains/service-tests/service/index.ts) には、保存済み設定を使う接続、進捗保存、成果物の扱い、再起動時に既知のjobを追跡する処理がある。製品の楽曲機能を試用domainへ依存させる案はまだ採用していない。まず下位のLARM接続を再利用する。

設定画面の利用範囲は [settings.md](../docs/settings.md)、過去の試験とliveの記録は [service-testsの検証記録](verification/service-tests/README.md) にある。過去の成功を、今回の会話からArtifactまでの成功として扱わない。

### 会話とツールチェーン

| 参照先 | 確認した役割 |
| --- | --- |
| [conversation-tools.ts](../api/domains/dialogue/service/conversation-tools.ts) | 会話に公開するツール、入力の契約、ツールに対応した方針 |
| [generation-operation.ts](../api/domains/dialogue/service/generation-operation.ts) | 会話モデルが選んだ操作を受け付け、委任する処理 |
| [generation-prepare.ts](../api/domains/dialogue/service/generation-prepare.ts) | 結果を受け取った会話の次の入力を組み立てる処理 |
| [start-task.ts](../api/domains/agent-runtime/service/start-task.ts) | 既存のweb、historyなどの経路選択 |
| [toolchain.ts](../api/application/toolchain.ts) | capability、tool、agent-runtimeの組立て |
| [server.ts](../api/application/server.ts) | domain、queue、inference、dialogueの接続と起動 |

既存の研究用runtimeをそのまま楽曲生成に使えるとはまだ判断していない。長時間の生成待ち、音声成果物、取消を既存の契約にどう載せるかが残っている。新しいexecutorやdomainの追加は未決定である。

登録の種類と変更箇所は [ツールチェーン拡張手順](../docs/toolchain-extension.md)、検証の区切りは [ツールチェーン拡張の検証手順](../docs/toolchain-extension-verification.md) を参照する。

### Artifactと再生

[Artifactの型](../web/src/domains/artifact/store/index.ts) と [ArtifactPanel](../web/src/components/domains/artifact/ArtifactPanel.tsx) を確認した。現在はmarkdown、showcase、timerに対応し、楽曲専用の表示はない。

会話runからArtifactを開く参考として [useTimerArtifacts.ts](../web/src/domains/timers/useTimerArtifacts.ts) を確認した。楽曲について同じ接続方式を採用するかは未決定。UIの更新方式は [realtime.md](../docs/realtime.md) のSSE方針と整合させる必要がある。

「再生を動的に作る」を、生成結果に応じてプレイヤーを構成することまでとするか、LLMによるUI定義の生成まで含めるかは、実装前に整理する。固定の楽曲プレイヤーを追加しただけで、要求をすべて満たしたとは扱わない。

## 再利用の方針と未決事項

再利用の第一候補は、LARMの生成・取得・取消、共通の推論とqueue、会話結果の受渡し、Artifact workspace。LLMにはテーマの意味理解と生成用指示の作成を任せ、コードにはAPI接続、状態管理、契約検査、認証を担当させる。

実装前に次を確定する必要がある。

1. 楽曲担当の入力と出力。テーマ、長さ、生成用指示、表示名、結果参照をどこで確定するか。
2. SkillとSystemContextの所有場所。既存capability登録とruntimeで満たせる範囲、および不足する具体的な契約。
3. 長時間jobの保存と取消。推論完了後にLLMの実行枠を占有せず生成を待てるか。状態不明時に重複生成しないか。
4. 成果物の保存期間、取得API、Artifactの構成。LARM credentialをブラウザへ渡さないこと。
5. 30秒の要求が対象APIで受理される条件と、取得した音声の長さを確認する方法。試用UIの制限をProviderの仕様と同一視しないこと。

## 検証の現状と次回の記録

今回の楽曲作業で新たに実行したテストは0件。fixture、実LLM、実生成API、ブラウザ再生はいずれも未実施。

既存の [LARM試験](../api/domains/larm/test/playground.test.ts) には成果物取得と遅延応答後の取消があり、[fixture server](../scripts/larm-fixture-server.ts) には生成受付、完了状態、metadata、音声の応答がある。これだけでは、実LLMによるテーマの装飾や30秒の実音声生成は確認できない。

実装後は部分、結合、通しの順に確認する。途中で通し試験を行う場合は、何を確認するためかを先に明示する。過去の依頼では通し確認を1回に限定し、失敗後の再試行や追加修正を止める指定が繰り返されている。今回の実行時にも回数と停止条件を明記し、無断で試行を重ねない。

受入入力は「Tetrisをテーマにした30秒の楽曲を作って」。通し確認では以下を一連の記録に残す。

1. 試験入力、公開ツール、選択された担当。
2. 楽曲担当が作った生成用指示と長さ。
3. 秘密を除いたAPI要求項目、受付結果、jobId。
4. 取得できた進捗状態、完了または失敗した段階。
5. 音声取得結果、形式、実際の長さの確認結果。
6. 会話の最終回答、Artifact表示、再生を確認した範囲。
7. 失敗時は観測事実、原因の根拠、未確定の点、残作業。

通常の製品ログには会話本文、音声、credential、設定、Provider生応答を追加しない。試験入力と生成用指示などの受入記録は、秘密を除いた試験資料として分けて残す。音声取得、ブラウザ再生、実機器での聴取は別々の確認として記録する。

## CodexのSkillへ整理するときに残す手順

以下は今回の調査から得た手順候補であり、実装を完了して再検証した手順ではない。

1. ユーザーの目的と受入例を整理し、例固有の処理を製品仕様に混ぜない。
2. 既存のAPI接続、LLM指示、公開ツール、実行機構、成果物表示を先に調べる。
3. 追加の種類を分類し、再利用する入口と不足する契約を列挙する。
4. LLMの意味判断とコードの実行責務を分け、変更範囲と完了条件を決める。
5. 入力から結果返却までの実装を揃えてから、段階別に検証する。
6. 失敗時は段階と根拠を記録し、指定された停止条件に従う。
7. 最後に差分を確認し、専用分岐、無関係な変更、未検証の完了宣言がないか点検する。

Skill化の際は、汎用手順を本文、Eumenes固有のパスと契約を参照資料、Tetrisの30秒試験を実例として分ける。実行コマンドや成功条件は、今回の機能を実装・検証できてから確定する。CodexのSkill自体は今回まだ作成・登録していない。

## この記録での変更と残作業

今回追加したのはこの記録とspec索引へのリンクのみ。着手前から存在する `docs/README.md`、`docs/toolchain.md`、`docs/toolchain-extension.md`、`docs/toolchain-extension-verification.md` の未コミット変更は、先行するドキュメント整備の差分であり、楽曲機能の実装差分ではない。

残作業は、未決事項の整理、最小の実装方針の確定、製品実装、段階別検証、受入記録の追記、CodexのSkill化。次回はこの記録と現在の差分を確認してから再開する。

## 続行記録 作業単位1 担当と実行経路

ユーザーから実生成・動作試験までの続行依頼を受けた。`music.create@1` のpackage、profile、Skill、生成toolの契約を追加。既存の研究runtimeは根拠付き報告と短時間の資料操作が前提なので、音声生成ジョブを扱うmusic domainを追加する方針とした。意味判断は楽曲担当の1回のLLM呼出しで行い、生成処理は既存LARM接続を使う。

実装中: 推論queueで指示を作成後、生成queueへ移して推論枠を解放する。会話は結果を待ち、成功・失敗を受け取って回答する。生成POSTは自動再試行しない。取消後の結果を採用しない。既存の会話期限内で実行し、最終回答用に15秒を残す。現時点では試験未実施。

## 続行記録 作業単位2 会話とArtifactの接続

会話にcreate_musicツールを公開し、ユーザーの原文と会話モデルが渡した依頼を楽曲担当に渡す。楽曲担当の生成結果からtitleとdescriptionを作り、音声取得が完了した結果だけを会話へ返す。Artifactは生成結果ごとにプレイヤーを構成し、認証済みAPI経由で取得した音声を再生・保存する。任意のHTMLやJavaScriptをLLMに実行させる構成にはしていない。

進捗と完了は既存SSEの変更通知で取得する。音声はbackend内に保存し、ブラウザへLARMの認証情報を渡さない。プレイヤーを閉じる際はBlob URLを解放する。現時点で実装を接続済み、これから部分・結合試験を行う。

## 続行記録 作業単位3 部分と結合の確認

部分試験ではSkillの組立て、原文をデータとして保持すること、未公開ツールの拒否、音声の認証取得とBlob URL解放、失敗時に音声を取得しないことを確認した。UI試験2件は成功。

結合試験の初回はテストが存在しない `/api/dialogue/runs` を指定して404となった。実際の公開API `/api/runs` に修正。次にfixtureのLARM接続へダミー認証tokenを渡しておらず、カタログを取得できなかった。fixtureの設定を修正した。いずれも実生成APIは未実行。境界検査で検出したテストのcapabilities内部参照も公開入口経由へ修正した。試験期待値は弱めていない。

## 続行記録 作業単位4 実生成とブラウザ再生

実LLMによる担当選択と生成指示作成、LARMの楽曲生成API、音声取得、会話への結果返却、Artifact再生を1回実行して成功。曲名は「8-Bit Tetris Rush」、実音声はMP3・48kHz・ステレオ・30.000秒。依頼から最終回答まで約56.5秒。ブラウザで約1秒再生し、時刻の進行とエラーがないことを確認した。音声、画面、全経過、生成指示と会話の全文を[受入記録](verification/music-2026-10-11/README.md)へ保存した。

表示確認でタブの初期名「楽曲を制作中」が完了後も残る点を見つけ、初期名を「楽曲」へ変更した。音声は再生成していない。実スピーカーでの聴取と音楽的な品質評価は行っていない。

## 実装で触れた場所

| 追加の種類 | 変更場所 | 今回の役割 |
| --- | --- | --- |
| 登録定義と契約 | api/domains/capabilities/builtin/music.ts、builtin/music/SKILL.md、contracts/music.ts、service/builtin-seed.ts | package・profile・Skill・toolと入出力schemaを登録 |
| サブエージェントと生成処理 | api/domains/music/service | 1回のLLM呼出し、生成queue、API呼出し、取消、完了・失敗の結果返却 |
| 保存と取得 | api/domains/music/repository、controller、contracts | 原依頼、定義のsnapshot、生成指示、進捗、音声を保存し認証APIで公開 |
| 会話 | api/domains/dialogue/contracts/music.ts、service/conversation-tools.ts、generation-operation.ts、generation-prepare.ts、index.ts | ツール公開、委任、結果待ち、最終回答、取消対象jobの接続 |
| 組立て | api/application/server.ts、toolchain.ts、app-modules.ts、migrations.ts | domainと依存関係、migration、公開APIを接続 |
| クライアントと表示 | client/music.ts、web/src/domains/music、components/domains/music、ArtifactPanel、App、queryKeys | SSEから成果物を発見し、音声を認証取得して再生・保存 |
| 境界と索引 | scripts/domains.ts、docs/domains.md | domainの所有範囲と依存関係を登録 |
| 試験 | music/test、dialogue/test/music-routing、application/music-e2e、MusicArtifact.test、scripts/music-live.ts | 部分・結合・失敗・取消・実生成・再生を別々に確認 |

生成結果に応じてArtifactへプレイヤーを開く構成であり、テーマごとのコード生成はしない。タイトルと制作意図はLLMが作成する。Tetrisに依存する製品分岐は追加していない。

## 続行記録 作業単位5 回帰試験と差分点検

全体の試験内訳は、backend等1,471成功・1スキップ、web 284成功、client 329成功、design-system 1,086成功、ブラウザ44成功・1スキップ。型、lint、整形、SQL境界、domain索引、サイズ制限、Webビルドの各工程も成功した。

ただし `verify:all` の最終結果は成功ではない。検査中に検証用スクリプトと記録を追加し、初期タブ名も修正したため、最後の `source changed during verification` で終了コード1になった。これは私の検証順序の不備であり、各試験の成功と一括検査の成功を混同しない。全体の再実行はせず、楽曲domainと利用側dialogueを最終状態で個別検査する。実生成は既に成功した1回のみとする。

差分を点検し、Tetris等の固有テーマによる製品分岐、発話の意味をコードで分類する処理、認証情報のブラウザ公開は追加していない。既存のドキュメント差分は保持。App内の既存タイマー用callbackは、音楽Artifact追加時に関数サイズ制限を超えないよう同じファイルのhookへ移した。タイマーの動作は変更していない。

今回の手順からSkillへ反映する点: 実生成用スクリプトまで先に揃え、検査実行中はソースを編集しない。記録の追記は検査が終わってから行う。APIのURLと認証fixtureは公開controllerと既存fixtureから確認し、推測で作らない。

## 最終確認

- `verify --domain music`: 成功。部分試験3件を含む。[最終出力](verification/music-2026-10-11/verify-music-final.txt)
- `verify --domain dialogue`: 成功。backend 119件、web 6件。[最終出力](verification/music-2026-10-11/verify-dialogue-final.txt)
- 全体の型検査、lint、整形、サイズ、SQL境界、差分の空白検査は成功。全体検査の一括判定に関する制約は作業単位5のとおり。
- 製品実装、今回指定の実生成、ブラウザ再生、作業単位別の記録を完了。実生成は1回。変更は未コミット。

この実績を元にしたCodexのSkill化は、下記の作業単位6で実施した。今回固有の試験ログ・音声・時刻は参照資料に残し、Skill本文には登録・接続・段階別検証・停止と報告の手順を抽出した。

## 続行記録 作業単位6 Codex Skillへの整理

- 目的: 楽曲生成に依存せず、サブエージェント・実行用Skill・SystemContext・Artifactの登録から動作確認まで再利用できる手順にする。
- 作成先: `/Users/y.noguchi/.codex/skills/add-toolchain/`。`SKILL.md`、UI設定の`agents/openai.yaml`、登録先の`references/eumenes.md`、実績の`references/music-example.md`を作成した。製品実装は変更していない。
- 本体: 追加種別の判断、既存機構の再利用、公開から結果返却までの接続表、指示とschemaの一致、非同期操作・取消・Artifact、段階別検証、停止条件、作業単位の記録をまとめた。
- 一般化の範囲: Tetris・30秒・実生成1回は今回の実例に残し、他機能の固定要件にはしていない。Eumenes固有の登録先は参照資料へ分離した。
- 確認: skill-creatorの`quick_validate.py`成功。Markdownリンクと具体的なリポジトリ参照23箇所の存在を確認。手順を机上で「既存ツールの担当改訂」「新しい非同期生成APIとArtifact」「dots担当のAPI登録」に当てはめ、不要な実装やliveを強制しないことを点検した。
- 未実施: 新Skillを使った別機能の実装・実LLMによる行動評価。今回は手順の作成であり、製品試験・外部API・楽曲生成は再実行していない。
- 利用例: `$add-toolchain を使い、既存の実行機構を再利用してツールチェーンを追加し、登録から結果返却・動作確認まで進めてください。`

## 方針訂正 UIの登録と組合せ

ユーザー指定により、今後の追加手順は次の構成とする。既存UIの組合せはOpenUIのJSONで表し、音楽プレイヤーのような固有の操作を持つ部品はDesignSystemへ作成してOpenUIへ登録する。Artifactの表示定義はJSONを正本とし、音声・業務状態・認証済み取得はホストのsourceへ分離する。他のUIと組み合わせた表示と操作まで確認する。

現行の音楽実装は専用のMusicArtifact、kind=music、renderMusicであり、この到達形への移行前。現行OpenUIも単一viewだけを受理するため、複数部品の構成対応は未実装。今回の変更はCodex Skill本体と参照資料への方針反映であり、製品のDesignSystem/OpenUI移行は行っていない。Skillの形式検証は成功。実生成・製品試験は再実行していない。

## 続行記録 作業単位7 DesignSystemの音楽UIと汎用生成中表示

ユーザーの指定でMusicPlayerとPlaylistをDesignSystemへ実装。画像生成したUI案を参考に、再生・一時停止・シーク・前後10秒・前後の曲・曲選択を追加した。サムネイル生成は後続の画像生成ツールチェーンで検討するため、現在は音符の仮表示。追加依頼の生成中画面はGenerationStatusとして独立させ、音楽や画像に依存しないpropsで状態・実測進捗・取消・失敗を表示する。

DesignSystem全単体1,095件、新規部品9件、型、build、ブラウザ12項目を確認。目視で見つかったPlaylistのCSS分離ミスは修正して再確認した。OpenUI登録・JSON合成・既存MusicArtifactの置換は未実施。楽曲生成APIを再実行せず、ブラウザ再生はローカル試験音源を使った。詳細・実画面・画像生成promptは [検証記録](verification/music-player-2026-10-11/README.md) に保存。


## 続行記録 作業単位8 OpenUI登録・JSON合成・保存済み楽曲での確認

MusicPlayer・Playlist・GenerationStatusをOpenUIへ登録し、既存viewも含めてstack/gridで並べるlayout定義を追加した。Artifactのkind=musicとrenderMusicを廃止し、kind=openuiと表示JSONを保持する構成へ置換。MusicArtifactは認証済みsourceを解決するホストとし、表示は共通ArtifactRendererへ移した。生成・取得状態と音声URLは保存JSONに含めない。

部分・結合ではArtifact 47件、musicのbackend 1件・Web 4件を確認。保存済みの30秒MP3を認証付き読取fixtureから配信し、実際の製品画面で生成中表示、再生・一時停止、シーク、前後10秒、前後の曲、Playlist選択、ダウンロード参照を確認した。初回のPlaylist選択は、試験locatorが同名タブの閉じるボタンも拾って停止。Playlist内へ限定した2回目で成功。2曲目は同音声の選曲試験用コピー。実LLMや外部生成は再実行していない。

全体回帰は1回で成功。backend等1,471、Web 293、client 329、DesignSystem 1,095、ブラウザ44が成功。スキップはbackend 1・ブラウザ1。全体の型・lint・整形・境界・サイズ・build、検証入力の同一性も成功。所要468,965 ms。長い既存関数の制限を守るため、Appの音楽タブを開くcallbackとShowcaseのサンプルタブを同じファイル内で分離した。

詳細、失敗原因、保存音声fixtureの範囲、JSON登録例、実画面は [OpenUI音楽UIの検証記録](verification/music-openui-2026-10-11/README.md) と [OpenUIのドキュメント](../docs/openui-artifact-showcase.md) に保存。現行タブはインメモリー保持で、新規DB永続化は追加していない。音楽生成取消・再試行の新しいAPI接続、画像生成サムネイル、実スピーカーでの聴取は今回の対象外。

## 続行記録 作業単位9 ツールチェーン登録文書へUI追加手順を統合

ユーザーの指定を受け、`docs/toolchain-extension.md`にEの追加種別を設けた。既存OpenUIのJSON合成、既存DesignSystem部品のOpenUI登録、必要なDesignSystem部品の新設を分け、各変更先と最小例を記載。props・イベント・Storybook・試験・exportから、view schema・描画adapter・source種類・認証済みホスト・Artifact JSONまで接続順に示した。現行のlayout制限とインメモリー保持も明記した。

`docs/toolchain-extension-verification.md`には部品→JSON・ホスト結合→画面→回帰の確認手順を追加。保存済み成果物を使う確認とlive生成を区別し、UI追加だけで不要な再生成をしない手順にした。

確認: 本文中のJSON例3件の構文、OpenUI合成例の現行schema適合、文書2件のローカルリンク21件の存在、差分の空白を確認して成功。登録先と最小例は現行コードと照合した。今回は文書のみの変更であり、製品実装・全体試験・生成API・ブラウザ試験は変更・再実行していない。
## 続行記録 作業単位10 楽曲生成のOpus対応

ユーザーが全機能の統合を分割し、今回は楽曲生成ツールチェーンのOpus対応だけを指定した。保存済みControl接続のOpenAPI・musicサービスを確認し、既存の生成・音声保存・認証取得・OpenUI経路を再利用。生成形式をOpusへ変更し、`audio/ogg` とOgg / Opus識別ヘッダーを検査する。保存拡張子は `.opus`。指示・schema・package版とプレイヤー部品は変更していない。

部分・結合28件、LARM・music・dialogue domain、全体回帰が成功。実接続は30秒の確認曲1曲のみ。Opus・48 kHz・30.0065秒を取得し、確認曲だけを削除して404を確認した。最初のブラウザ待機は旧locatorで停止したためスクリプトを修正し、生成を再送せず同じ保存音声を認証付きfixtureから再生して確認した。全体検証初回の静的検査違反も確認用スクリプト内だけを修正し、2回目で成功。失敗・成功・未実施を分けた[詳細記録](verification/music-opus-2026-10-11/README.md)と証拠を保存した。

残作業は、次の依頼での音楽再生プレイヤーツールチェーン分離と追加統合。ライブラリ・タグ検索・お気に入り・Range中継・実スピーカーでの聴取は今回未実施。テーマ固有の製品分岐と担当外の変更は追加していない。`context_compile` 1回、`compile_eval` 1回。
