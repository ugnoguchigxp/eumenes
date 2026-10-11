# ASR断片の集約

## 変更

無音区間で分かれた録音を、回答キューへの登録前に保留する。既存の言語確認controlに `relation`（continuation / independent / uncertain）と `readiness`（ready / waiting / uncertain）を追加し、言語・継続関係・応答可能性を1回で判定する。前の未確定入力と直前の会話を渡す。Ruriなど別の判断器は追加しない。

同じ音声セッションのASR・判定を入力順に処理する。continuationをconfidence 0.8以上で判定した場合、以前の全文へ今回の確定文字起こしを改行で追加する。independentは別入力、判定不明・不正・失敗は下書きとする。句点、特定の語句、文字種、時間だけによる意味分類は実装しない。

ready・confidence 0.8以上になった最新入力だけを、ブラウザで録音・アップロードが進行していないことを確認してcommitする。revision・sequence・音声セッション・全ASRと最終controlの検証結果を確認して既存のdialogue受付へ渡す。二重commitは一つのrunとなり、ASRとcontrolを再実行しない。各ASRは回答/TTSの検証parentとして引き継ぐ。未完の入力は6秒後に続き待ちを知らせ、マイク停止後に既存のテキスト入力として編集・送信できる。

この専用の状態管理が必要な根拠は、今回の再現で1件の依頼が3録音として届き、各録音の認識後に回答が始まっていたことにある。録音の無音確定は1500msで、調査した最初のASRは2870ms。ASR完了時点でも次の録音が進行し得るため、言語controlだけで即時受付する経路から、ブラウザの録音状態も確認する確定操作を分離した。回答キュー自体は再利用する。

Webの連続入力はdeferredモードで送る。従来の明示的な確定済み音声API入力は既存経路を保つ。追加migrationは既存のmigration本文を変更せず、文字起こし・結合元・検証参照を保存する。

## 検証

- 部分・結合: voice-dialogueの選択検証成功。backend 62件、Web 34件。うち新規のbackend 9件とWeb 2件で、3断片→1回答、次のASRが遅い場合の旧入力の確定拒否、二重commit、不明/不正/未完判定、独立した依頼、取消された元断片、権限失効、回答後の古い下書きの排除を確認。既存migration試験を拡張して履歴と未確定入力の保存・再起動時のmigration再適用を確認。
- 利用側: inferenceとdialogueの選択検証成功。
- 全体: backend 1579件成功・1件skip、Web 306件、client 329件成功。全体の型・境界・サイズ・整形・lintも成功。`verify:all` は未変更の `packages/design-system/src/components/MusicWorkspace/MusicCreationForm.test.tsx` の型エラー6件（テスト側のByRoleOptionsにexactがない）で停止した。担当外のため変更しない。後続の画面部品試験1109件とWebビルドを別途実行して成功。
- ブラウザ全体: 44件成功・1件skip・1件失敗。今回の音声集約、既存の会話/音声入力/再生/長文入力はすべて成功。失敗は未変更のArtifactタッチリサイズ試験で、beforeEachの画面初期化が20秒以内に終わらずrootが空のままだった。機能本体の検査に入る前の失敗で、原因は未確定。担当外を修正したり期待値を弱めたりしていない。再現性確認の単独再実行では1件成功（2.0秒）したが、全体実行の失敗を取り消さない。
- ブラウザ通し: `tests/browser/voice-input.spec.ts` 成功。AudioContextから合成音声を入れ、実AudioWorklet・無音確定・API・DB・回答キューを通す。ASRとcontrolは固定のProvider応答。提示例の3断片を送り、commit 1回・ユーザーメッセージ1件・回答1件、前2断片のmergedを確認。暫定ASRだけはブラウザのfixture応答に置き換え、確定ASRの試験列を消費しない。
- live: `bun scripts/voice-input-live.ts --run` を試行したが、保存済みLARM Controlの接続が15秒でタイムアウトし、判定呼出し前に停止。保存済み接続先への読み取り専用healthも5秒でタイムアウト。実LLMの判定品質・所要時間は未確認。接続先を変更したり、利用者に再指定を求めたりしていない。
- 実機器: 今回の実マイク・ヘッドホンによる3往復は未実施。音声MVPの完成・実機器受入とはしない。

全体検証の結果と機械記録は同ディレクトリのresults.jsonに記録する。作業開始時から存在した別作業のconversation-output・会話生成・toolchain文書の差分は保持し、今回の変更に含めて説明しない。最終差分点検で個別語句・提示例に依存する製品条件分岐が追加されていないことを確認した。

Context Stillは今回の実装でcontext_compile 1回・compile_eval 1回。
