# 会話からの調査(toolchain)

通常の会話入力からWeb検索・読取りを選べます。`EUMENES_TOOLCHAIN_ENABLED` は既定 `1`、`0` なら従来の会話生成へ戻ります。制御用の推論はLARMのみを使い、内部JSONを読み上げや態度収集へ渡しません。子の待機中は推論枠を解放します。

子は取得本文を読み、短い要約、主張、出典、未確認点を返します。メインへ本文・生引用・ページタイトルは渡しません。主張の引用が実際に子へ提示した資料に含まれるかを確認しますが、この検査だけで主張の意味まで正しいと保証するものではありません。メインでも報告を未信頼データとして扱います。調査cardに進行状態・停止・出典・確認できなかった点を表示します。

予報の専用読取りは東京、大阪、神奈川、京都、愛知、福岡、兵庫に対応します。他の地域は検索を使います。株価は依頼にtickerが明示された場合に専用読取りを使い、市場終了・遅延・価格時点を区別します。上流の取得拒否やguard拒否を迂回しません。結果データは14日、本文を含まない処理metadataは30日で整理し、既存の会話は残します。

`EUMENES_LIVE_TOOLCHAIN=1 bun run verify:live -- --domain agent-runtime` は一時DBを持つ隔離backendを起動し、実LARMと公開データで天気・株価を確認します。LARM認証はbackendの環境変数から読み、通常DBは使いません。判定は子の報告と最終回答の数値まで確認します。[実装・検証記録](../spec/verification/toolchain/README.md)を参照してください。

domain の責務は [domains.md](domains.md)、Web 取得は [web-research.md](web-research.md)、取得先の学習は [research-routes.md](research-routes.md) を参照してください。
