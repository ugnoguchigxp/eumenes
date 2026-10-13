# Excalidraw連携の検証

2026年10月13日。fixture、実接続の前提確認、正式環境の受入を区別する。

| 区分 | 結果 | 証拠 |
| --- | --- | --- |
| 実装・固定試験 | 成功 | domain.json、backend-settings.txt、dialogue.json、larm.json、capabilities.json、artifact.json |
| MacBook上のChromium fixture | 成功（単独実行） | browser.txt、editor.png。起動・描画・保存・再表示・下書き復元・idle解放・再起動復帰・会話からの連続起動 |
| 実HTTPでのHost中継 | 成功（ローカルfixture） | backend-settings.txt。接続先ポート、gateway Host、lease endpointを分離 |
| 型検査・Web build | 成功 | typecheck.txt（空=エラーなし）。Web buildは成功、重いExcalidraw chunkの警告あり |
| settings / verify:all | 担当外の境界違反で停止 | settings-blocked.json、all-blocked.json |
| 正式配備の前提確認 | Local Services無効、consumer/Excalidraw unit/18790入口なし | deployment-status.json、live-status.json |
| 正式LARMでのcold起動・保存・停止 | 未実施 | 専用consumer/gatewayが未配備のため。fixture成功をlive成功と扱わない |

実装・残条件は ../../excalidraw-work-record-2026-10-13.md と ../../../docs/excalidraw.md を参照。
