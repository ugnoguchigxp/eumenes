# Providerごとに音声を開始する

2026-10-25。利用者からの実装・実接続受入・本番反映依頼を対象とする。LARM対象releaseは `cab4d8a6df382905e9b025e5c87a30960ca7d3eb`。

## 仕様確認と実装方針

既存のcatalog検証、control通信、claimのendpoint/model/credential照合、保持要求、取消、ASRの15秒のlocal試行を再利用する。LLMへの指示・意味判断は変更しない。Connection全体のreadyをProviderのreadyと混同しない。

保存済みProfile・audienceと一意な試験clientを用いた実接続で、同じclientでもLLMのみからProfile全体へ要求すると別Connectionになることを確認した。従来の拡張時DELETEを除き、LLMのみの接続と音声用Profile全体の接続を同じclientの各構成として保持する。背景LLMの接続・保持規則は維持する。音声用ではConnection取得だけを共有し、各ProviderのGET待機・claim・credential更新を独立させる。

- POSTのProfile/client/audience/Provider構成は既存値を使う。音声は従来どおりProfile全体、LLMだけの要求はllmのみ。
- GETをProviderごとに判定し、対象がreadyならprobing/failedのConnectionでも部分claimする。claim bodyのprovidersには対象の外部名を明示する。optional Providerの名前はcatalogから解決する。
- released/expired/404/410はConnection寿命として扱う。対象Providerのfailed、期限、呼出元の取消は他Providerのclaimや接続を破棄しない。
- 各待機は呼出元signal・port lifetimeと準備上限60秒の早い方。ASR要求は既存の15秒のlocal試行が先に切れる。GET/claimにこのsignalを渡す。準備成功後の実処理は従来の呼出元期限を使う。
- credentialはProviderごとに有効期限を管理する。renew後も対象ProviderだけをGET/部分claimし、他Providerの未準備で停止しない。別Providerのtokenを借用しない。
- 音声開始のprepareVoiceはASRの準備だけで完了する。TTS/判断器は使用時に自身を取得する。録音開始はbackendのprepareを待たない既存方式を維持し、保持WAVをASRへ渡す。取消後の結果は採用しない。
- DELETEはportの明示close・設定変更・試験cleanup等の所有終了に限る。Provider失敗・取消によるDELETEは禁止。通常終了のKV保持指定を維持する。
- 準備状態の変化、POST基準のready/claim/初回要求時間は固定状態値・Provider役割・数値・Connection IDだけを記録する。本文・音声・設定・credential・生応答は保存しない。

## 作業順・完了条件

1. 部分claim、失敗分離、並行待機、認証更新、取消のfixtureを追加し実装する。
2. larm → inference/voice-dialogue/audio利用側のdomain verifyを行う。録音buffer・取消のWeb試験を含める。ブラウザE2Eは既存サーバー利用可否を確認し、対象ファイルを指定する。
3. 保存済み接続へ合成音声・テキストで、新規/再依頼、主会話・背景生成中、KV満枠、音声10分無使用後、障害・期限・取消を確認する。実際に作れない状態は未検証と明記し、fixtureをliveと混同しない。他consumerを解放しない。
4. 差分点検後に本番反映する。サーバー再起動が必要な場合はAGENTS.mdに従って明示許可を得る。実装・fixture・live・本番を分けて記録する。

設定、DB schema、LLMモデル選択、fallback優先順位、他domainの不具合は変更対象外。既存の担当外差分を保持する。

## 残作業

- [ ] 実装と回帰試験
- [ ] 利用側を含むdomain検証
- [ ] 実接続受入と10分待機
- [ ] 本番反映と稼働確認
