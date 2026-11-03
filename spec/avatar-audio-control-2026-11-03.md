# 発話音量によるアバター制御（2026-11-03）

利用者の今回の実装依頼に従う。既存Three.jsの光の精霊・判定済みmotion・0.7秒の補間・12/24fps描画を再利用する。モデルの追加取得・再配布、VRMへの変更、backend・DB・分類器・通信方式の変更は不要。

## 現状と接続

- TTS: 音声対話のqueueChunksと読み上げuseReplay → createAudioController.play → AudioBufferSourceNode → 任意の音量Gain → destination。通知・効果音も同じcontrollerを使うため、発話の呼出し元だけで解析を明示する。
- Live: Provider主WebSocket → backend → 既存SSEのPCM → createLivePcm → 予約済みAudioBufferSourceNode → Gain → destination。マイクは独立したWorklet入力。文字起こしに同期情報・表情はない。
- 音楽: DesignSystemの独立したmedia/AnalyserとMusicVisualizer。混ぜず、口パクに参照しない。
- 表情: deliveryのemotionを既存motionに変換済みで、音声chunkと共に返す。現行契約には感情の強度がなく、confidenceは確度であって強度ではない。既存プリセットの振幅を用い、確度を強度へ読み替えない。Liveの字幕へ既存delivery判定を適用することは可能だが、追加推論・字幕区切り・遅着失効の設計が必要であり、今回追加しない。

## 実装と完了条件

1. audioに音声入力元に依存しない共通の解析入力を追加。発話だけの音量調整後をAnalyserに分岐し、解析出力はdestinationへつながない。可聴経路は一本のまま。既存描画ループで短時間RMSを読み、小音量閾値・attack/release平滑化・最大開口を適用する。毎フレームの通信・React状態更新・独立timerは追加しない。
2. TTSは再生開始から終了/中断までだけ登録。LiveはPCMの予約再生区間とAudioContext状態を参照し、受信完了を再生完了としない。閉鎖時はノード・登録を解放する。停止中やcontext休止中は即座に0。
3. 既存モデルの目のボーンへ手続き生成した簡易口を追加。口の値は表情や身振りから独立して最後に適用する。瞬きは表示時計に対するランダムな3〜7秒間隔・短い閉眼で生成し、表情の閉眼と最大値で合成する。静止設定では従来どおり動かさない。
4. 部分試験→audio/avatar/voice-dialogue/live-voice/conversationのdomain verify→利用可能なら消音ブラウザで通し確認。無音、音楽単独、混在、予約再生、自然終了、取消、切断、再作成、表情と瞬きの独立を確認する。サーバー操作は許可されていないため実施せず、起動が必要な試験は理由を記録。実Providerと実機器受入は固定試験と分ける。

外部仕様: AnalyserNodeは接続された入力の時間波形を取得でき、出力未接続でも動作する（https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode）。解析は同一ブラウザ内に閉じる。

## 追加合意: 第3の表示（実装前の更新）

利用者が「光の精霊, spitalの他、3つ目として桃瀬ひよりを導入」と指定した。既存2種は保持し、backgroundに`live2d-hiyori`を追加する。既定値と保存済みの選択は変更しない。表示設定の既存Selectへ選択肢を追加し、公開済みartifactを保持したまま`artifact:settings.display@11`を登録する。共通settings adapterと保存経路を再利用する。

桃瀬ひよりは公式CubismWebSamplesのタグ5-r.5から取得し、moc3・texture・physicsを改変せず同一originから読み込む。Cubism SDK 5-r.5のCoreとFrameworkをローカル同梱し、外部CDNへの実行時依存を置かない。独自のモデリングは行わず、公開済みパラメータへ既存motionに対応する眉・笑顔・頬・口形を渡す。表情の強度入力は0〜1（未指定はプリセットの既定強度）で、確度から生成しない。口の開きと瞬きは最終適用し、表情から独立させる。

CoreはProprietary Software LicenseのRedistributable Code、FrameworkはOpen Software License、HiyoriはFree Material Licenseと個別利用条件。桃瀬ひよりのデザイン改変は禁止。開発・検証と第三者への製品公開を区別し、公開時のSDKリリースライセンス条件（事業規模・拡張性アプリ）とモデル条件は配布者が確認する。同梱noticeに出典・版・hash・原契約を保存する。今回、外部公開・配布操作は行わない。

直前までの共通解析の部分試験は3件成功。既存音声試験5件の失敗は、今回追加したdisconnectに対する既存fakeの未実装と特定できたため、fakeにWeb Audioの契約を補う。元の期待値は維持する。表示方式の合意に従いThree.jsへの口追加を取りやめ、Live2Dの描画・表情・瞬きと3択設定の検証を残作業へ追加した。

## 実装結果・差分点検

- 既存の2背景と既定選択を維持し、共通の背景メニューと表示設定へ桃瀬ひよりを第3候補として追加。`settings.display@7..10`の内容を変えず`@11`を追加した。設定は既存adapter・共通下書きで保存し、新規toolchain・判断器・backend操作は追加しない。
- モデルは`web/public/live2d/hiyori/`へローカル配置し、Gitでは`.gitkeep`だけを保持。Core・Framework・shaderのコードと契約文書は同梱。モデルのないcheckoutでもビルド・起動でき、読込み失敗はその背景内だけに閉じる。
- TTSはchunkとreplayの既存playへ`assistantSpeech`の種別だけを渡し、共通出力の音量Gain後へsilent tapを接続。通知・効果音は既定で対象外。音楽・マイクは別経路。Liveの既存PCM出力Gainへ同じ解析を接続し、onended/closeで解放する。新たな再生先や推論要求は作らない。
- RMS閾値0.008、最大開口0.7、attack35ms/release80ms。既存の描画ループからpullし、毎フレームの通信・React更新・解析用timerは追加しない。停止・取消・音声context休止では閉口する。
- 表情プリセットは判定済みmotionからの表示変換に限定し、0〜1の強度入力と補間を持つ。確度を強度へ読み替えない。瞬きは3〜7秒間隔、160〜280msを描画時計で生成。physicsと公式poseの適用後、口・目を独立に制御する。Liveはneutralで、新しい字幕分類・API要求を追加しない。
- テクスチャはSDKのpremultiplied alpha契約に合わせ、公式poseで腕パーツの表示を切り替える。モデルデザインの改変ではない。
- 差分に語句やシナリオ別の意味判断・固定応答は追加していない。既存のrouter-export作業の変更は保持し、実装対象にしていない。`docs/domains.md`は索引生成の結果としてconversation→audioの依存に加え、既存のdocling/model3d→larmの宣言も同期した（業務実装の変更なし）。

## 検証記録

変更前のavatar・Live PCM・performer・idleの24試験成功。変更後の部分試験108件、登録の旧版保持・再import試験1件、設定保存と3択切替の試験が成功。

関連domain verifyはavatar/audio/conversation/voice-dialogue/live-voice/settings/capabilitiesを選択し成功。backend567件・Web239件、境界・context・size・SQL・索引・書式・lint・DesignSystem・全体型検査を含む。記録: `verification-reports/runs/2026-11-03T01-09-52-247Z-f4ecafd3-5738-4f0e-8347-27da5bce4429/report.json`。settings-dataは独立domainとして登録されていないため、該当試験を直接実行した。

サーバーを起動せず、消音ブラウザーで`tests/browser/avatar-control.spec.ts`の3件成功。

1. 実モデルのWebGL描画・画像点検、固定TTS/Live PCMで口パク、無音・音楽・マイクのみでは閉口、音楽同時再生時もAI音声だけに追従、自然終了・TTS中断・Live切断後の閉口、3回の再接続と再作成、Coreの一重読込み。
2. モデルを404にして、背景内の案内・会話入力・操作・他背景への切替と再試行が継続。canvasや未処理エラーを残さない。
3. 製品と同じCSPでSDK・Wasmが動き、描画loopは1本、reduced motion/アンマウントでは0本、3回の再マウント後も1本。shaderとテクスチャは同一origin。

表情の補間・強度・瞬きの独立性・小音量除外・開口上限・音声context休止・古い解析値の破棄は固定試験で確認。実ProviderのTTS/Live音声や、実機器での3往復は未検証。Liveは現行契約に独立したoutput取消イベントがなく、会話内割込みでProviderがどう送信を止めるかと機器の出力遅延は実接続での残課題。今回、字幕や受信時刻で口を止める専用処理を追加していない。

途中の失敗は、fakeのdisconnect未実装、SDK shader配置の不足、ImageBitmapのpremultiply設定、公式poseの未適用、試験fixtureのWorklet配信/文字コード、書式とstatus要素のlintをそれぞれ観測し修正した。表示が空でも制御値だけで合格にせず、最終画像と実WebGLを確認した。総合検査中のソース変更は行っていない。

実API課金接続、製品設定の変更、サーバーの起動・停止・再起動、外部公開は行っていない。Context Stillはcontext_compile1回・compile_eval1回。

### 全体検査と最終結果

- `verify:all`: backend 5,063件成功・6件失敗。`verification-reports/runs/2026-11-03T01-13-57-520Z-c2ced68f-1ef2-4dc1-8f43-d3b793bb52cf/report.json`。うち今回の新版を期待する設定結合試験1件は、固定値を@10から@11へ更新して再試験し、関連2ファイル4件すべて成功した。契約・保存条件は弱めていない。
- 残るbackendの5件は未変更の領域。`api/application/fixed-names.test.ts`の2件は画像bundleと画像/LARM文書の既存固定名を検出。`api/application/toolchain/toolchain.test.ts`の3件は、拒否応答・期限切れ時のTODO結果が期待に反して空。後者は当該3件だけの単独実行でも再現した。担当外として調査のみ行い、修正しない。
- 全体verifyがbackendで止まりWeb全体を実行できなかったため、Vitestを別途全件実行: 1,328件成功・4件失敗。未変更の`client/larm.test.ts`（空JSON）、`client/test/settings-tasks.test.ts`の2件（既存live/router既定値とfixtureの不一致）、`web/src/workspace/shell-artifact.test.tsx`（readyでなくerror）。これらは今回の実装範囲外として保持する。全体合格とは扱わない。
- 製品`vite build`成功。既存のbundle-budgetは超過するため、HEAD `98b188d2c61352d2278b1912a78e8cd465d37671`の追跡ファイルだけを隔離ディレクトリへ展開し、同じ依存で比較した（DB・環境設定・秘密の複製なし、サーバー操作なし）。変更前はentry gzip 231,547 B / initial gzip 377,724 Bで既に予算超過。今回の最終値は232,937 B / 379,794 B、増分1,390 B / 2,070 B。予算値は変更していない。
- 任意のモデル描画コードもpublic入口から遅延importするよう調整し、SDKとモデル制御は初期entryに含まれないことを生成物で確認。SDKのCore・モデル・テクスチャは選択後にだけ取得する。
- この調整後も消音ブラウザー3件成功。最後にavatar/conversationのdomain verifyを再実行して成功（`verification-reports/runs/2026-11-03T01-27-25-688Z-af4d65b2-131a-40c9-b634-d3034764eeb9/report.json`）。関連7domainの成功、最終の遅延読込み、実モデルと欠落時の動作を分けて記録した。

モデルのGit対象は`.gitkeep`だけであることと`git diff --check`を確認。新しい意味判断・固定発話処理・別再生経路は追加していない。利用者が開いた実アプリへの反映・実Provider/実機器受入は、未実施のまま明記する。サーバー操作は行っていない。

