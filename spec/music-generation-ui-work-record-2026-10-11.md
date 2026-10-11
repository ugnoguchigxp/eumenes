# 楽曲生成フォーム

## 目的・範囲・完了条件

承認済み画像案を土台にMusicWorkspaceの右側へ曲づくり／生成履歴を追加する。ジャンルの複数選択（オーケストラを含む）、雰囲気・楽器・テンポ・長さ、歌声の有無・男性／女性／おまかせ・声質・歌い方・歌詞を選び、編集可能なプロンプトへ反映する。手入力後の選択変更は自動上書きせず、反映候補と現在の文章を利用者が選ぶ。

左側のイメージは静的なモックと明示し、画像生成の操作は無効。Visualizer・再生・詳細・履歴は既存部品を再利用する。Webの生成ボタンは既存の認証済み会話送信APIを使い、楽曲制作の意図と現在のプロンプトをLLMへ渡す。語句に応じた固定ルーティングを加えない。

接続先の保存済みsettingsをbackendの読み取り専用操作で取得し、2026-10-11にGET /openapi.jsonでMusicGenerationRequestを確認した。instrumental、lyrics、languageに対応し、専用gender／voice項目はない。声の特徴はLLMがpromptへ整える。既存music.create@1の定義・指示・schemaを残し、@2へ歌声対応を追加する。外部接続は既存LARM adapterを必要最小限に拡張し、Opus、取消後の不採用、POST自動再送禁止を維持する。DB migration・認証・外部サービスの設定は対象外。

依存順：契約・担当指示 → 再利用部品とフォーム → OpenUI source・操作とホスト → 回帰試験 → 部分・結合・画面 → domain検証とverify:all → 差分点検。

完了条件：選択と手入力保護が動く、生成と取消が認証済みAPIへ接続される、歌声条件と歌詞がAPIへ渡る、保存状態から表示が更新される、音声が一つのplayerで再生できる、狭い画面でも生成操作が使える、画像生成APIが一度も呼ばれない。

## 検証と残作業

着手時の部分基準：API・music domain 6件成功。Web・Artifact基準は別途記録。

- 部分：フォームの複数選択・検索・手入力保護・声の条件・画像モック。旧版／新版の契約。
- 結合：OpenUIのsource・revision・重複・未知操作拒否、送信・取消・失敗・音声解放。固定モデルから歌声ありAPI要求まで。
- 画面：認証fixtureと保存済み音声でdesktop／narrow、生成・取消、曲送り、Visualizerを確認。
- 回帰：music、artifact、capabilities、larmのdomain検証と横断verify:all。
- live：今回はAPI仕様の読み取りだけ。UI接続・adapterの検証は固定fixtureを使い、本物の生成を再実行しない。実際の歌声の聞き取りは未確認として報告する。

実装済み・固定試験済み。部分・結合・画面と最終差分点検を完了。全体検証は担当外のログ試験1件の失敗で未合格。担当外の処理・試験を変更せず、その修正と安定した入力での全体再検証を残作業として区別する。

## 実装と確認済みの範囲

- MusicCreationFormをDesignSystemへ追加し、既存MusicWorkspace／Playlist／MusicPlayer／Visualizer／GenerationStatusを再利用した。60ジャンル、検索、選択チップ、雰囲気、楽器、テンポ、長さ、歌声、声質、歌詞を提供する。
- OpenUI music-workspaceとMusicResourceに制作状態、music-generate／music-cancelを接続。JSONのsource／revisionと実行可否を検証し、既存の認証済みsubmit／cancelへ渡す。通信受付が不明な場合の利用者による再試行は同じrequestIdを使う。完了状態の更新時にも楽曲一覧を再取得する。
- music.create@2／music.generate@2／musicPlanV2を登録し、公開済み@1を不変に保った。意味判断と英語promptの構成は担当LLMに委ね、コードは明示選択の直列化とAPI契約の検証・受渡しだけを行う。版番号によるschema選択は保存済み旧bindingを維持するために必要。利用者の語句による専用分岐を追加していない。
- 専用のAPI受渡しは、保存済み接続先のOpenAPIで確認したinstrumental／lyrics／languageだけ。声の希望はpromptへ含める。参考：[ACE-Step公式ガイド](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/ace_step_musicians_guide.md)。

| 段階 | 対象・期待結果 | 実結果 |
| --- | --- | --- |
| 部品 | 複数選択、検索、手入力保護、歌声条件、画像モック | MusicCreationFormとMusicWorkspaceの9件成功 |
| API結合 | 固定モデルからinstrumental=false、歌詞改行、ja、声のpromptを一度送信。取消後不採用と旧版保存 | music-e2eとmusic-versionsの8件成功 |
| ホスト結合 | 認証済み送信・取消、source／revision拒否、重複防止、不明な受付の手動再試行 | 新規4件成功、既存MusicArtifactとcomposition14件成功 |
| 画面 | desktop／390px、生成・取消・再生・Visualizer・履歴・prompt再利用、画像API未呼出し | music-creation-ui-check成功。fixtureと保存済みOpus使用、pageerrorなし |
| 既存画面 | 保存済み音声の選曲、解析、詳細、一覧・お気に入り・プレイリスト | music-ui-check成功。左右配置とスクロール、解析peak=255確認 |
| domain | 静的確認と所有試験 | music 13件、artifact 49件、capabilities 22件、larm 76件成功 |
| 全体・静的 | size、SQL・domain境界、文書整合、format、lint、typecheck | 2回とも成功 |
| 全体・backend等 | verify:allの固定試験 | 最終回1,534成功、1スキップ、1失敗。全体gateは未合格 |
| 全体・画面側 | 全Web／client、DesignSystemの型・部品、本番buildを個別実行 | Web／client 633件、部品1,109件、型とbuild成功 |
| 全体・ブラウザ | 既存Playwright fixtureを個別実行 | 44成功、1スキップ |

画面記録の通知エラーは、音楽専用fixtureに通知・タイマーAPIがないための表示であり、楽曲操作の失敗ではない。画面確認では外部への実生成を行っていない。実LLMの選択・英語化と実際の歌声の聞き取りは未確認。

## 全体検証で残った問題と停止条件

初回は入力hash `27b7a493cddd62dc60f895f841ee82309f6c0acb8951c516cccb467c9ba87e4e` で1,532成功、1スキップ、control-outputの1失敗。期待 `llm_json_duplicate_key` と実際 `expected_object_end` の差。検証中に担当外のcontrol-output／llm-jsonのファイル更新を確認し、検証後の単独実行は5件成功した。入力が変わった新しい根拠があったため全体を1回再実行した。

最終回は入力hash `ad2621d32bdee03d91b44760773359a4d1da1c5dd387715bbfa8229a92d837a9`、211,268 ms。agent-runtime/test/rejection-logging.test.tsの「rolled-back and stale rejections are not logged as committed failures」で、期待ログ0件に対して1件。単独でも再現した。読み取り専用の診断でparseControlOutputの不正な固定入力が `llm-json / llm_json.rejected / llm_json_unsafe_repair` を記録することを確認した。失敗はrollback前の共通JSON拒否ログとログ0件の期待との差であり、今回の音楽UIではその処理・試験を編集していない。正しいログ契約の判断と修正は担当外のため行わず、全体の再実行を停止した。最終回の検証中にも別の入力変更があったため、全体成功の証拠にはできない。

verify:allはbackend試験の失敗で後続を実行しなかった。その後、Web／client・DesignSystem・build・ブラウザを個別に実行して成功を確認したが、全体gateの成功には置き換えない。スキップはreal-local-providerとAudioWorkletの実音声試験であり、成功件数に含めない。

続行条件は、担当外のログ契約と回帰試験の問題が解消し、検証中に作業入力が変わらないこと。実LLMでの歌声指定や長い歌詞の境界、生成音声の聞き取りは固定試験では保証せず、別の受入範囲とする。今回の画像生成操作は無効のまま。

## 保存した証拠・差分点検

[画面・検証記録](verification/music-generation-ui-2026-10-11/README.md)にdesktop／ジャンル／生成中／390pxの画像、API経路のfixture記録、domainログ、全体2回と個別回帰の結果を保存した。着手時に既存の未コミット変更を退避参照し、今回の差分だけを比較した。担当外の変更を巻き戻さず、キーワードによる意味判断や画像生成通信を追加していない。git diff --checkは成功。

context_compile／compile_evalは本会話で各2回（設計段階1回、実装段階1回）。実装の評価は固定試験後に登録した。

## 追加修正：基本項目の初期表示

利用者から「画像にはテンポや雰囲気があったが、実装の画像では見えない」と指摘。項目自体は存在していたが、展開した60ジャンルが縦方向を占めていた。MusicCreationFormの雰囲気・楽器・テンポ・長さを上部へ移し、ジャンル一覧を高さ16remの独立したスクロール領域にした。全ジャンル、検索、キーボード操作、歌声、プロンプト反映を保持する。意味判断やLLMの指示、API・OpenUI契約は変更していない。

完了条件は、desktop初期表示で基本4項目の全体がスクロール領域内に収まり、雰囲気・テンポの選択がpromptへ反映され、既存の生成・取消・再生と390px幅の操作が通ること。ブラウザ確認に実座標の検証を追加して成功した。MusicCreationForm／MusicWorkspaceの9試験、部品build（型検査含む）、format・lint・size・差分確認も成功。証拠は[修正後の画面](verification/music-basic-fields-2026-10-11/overview.png)と同フォルダのログ・API記録。

今回の変更は既存部品内の配置とスクロール範囲だけのため、部品→利用画面の結合→生成・取消・再生の通し確認に絞った。直前の全体gateで残った担当外のログ試験はこの修正で解消したと扱わず、全体gateは再実行していない。画像生成は引き続き無効、外部生成も実行していない。
