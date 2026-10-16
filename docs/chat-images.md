# チャットの画像入力

チャットの会話履歴と入力欄への貼り付け、ドラッグ＆ドロップ、入力欄のファイル添付アイコンからJPG／JPEG・PNG・BMPを追加できます。現在は画像のみ対応し、PDFやExcelファイルの解析には対応していません。サムネイルを押すと拡大し、×で送信前に外せます。本文だけ、本文と画像、画像だけの送信に対応します。設定や別のアーティファクトへの貼り付けは取り込みません。

画像は送信操作でEumenes backendへ保存します。発言に関連付けて履歴に表示し、再読み込み後も取得できます。音声の自動送信は手動添付を消費しません。アップロードや入力受付に失敗した場合は本文と添付を保持し、同じrequestIdで再操作しても重複しないようにします。

## 原本と表示

原本と送信用画像をSQLiteで保存します。JPEGはEXIFの向きを補正し、透明部分は白背景に合成します。BMPはデコード後に非圧縮24bit BMPへ正規化します。プレビューは同じ補正後の画素からPNGで作り、Providerが読む向き・背景と一致させます。原本そのものは推論へ送りません。

保存と取得はconversation domainの公開操作を使います。画像は所有者と会話IDを検査して取得し、認証なしの要求、別会話、撤回済み資料を拒否します。履歴JSONには画像ID・寸法などのメタデータだけを含め、巨大なBase64を埋め込みません。

## 上限と失敗時の扱い

Eumenesの受付上限は1画像3 MiB、1入力8枚、各辺8,192px、総画素数16,777,216、縦横比100です。原本と正規化後の画像の両方を検査し、破損・偽MIME・未対応形式を拒否します。未関連のアップロードは所有者あたり合計64 MiBを上限とし、24時間で参照期限が切れ、次回アップロード時に回収します。送信済みの画像は発言の資料として保持します。

実際の推論にはclaimの`chatInput`にある上限を適用します。現在のLARMは全履歴を含む8画像・要求全体4 MiBです。Base64、system、履歴、tools、出力指定を含む最終JSONを検査するため、原本が3 MiB以下でも送信要求が大きすぎる場合があります。

事前計数の`fits=false`や計数不能の場合は生成を止め、理由を画面に出します。画像・履歴の自動削除、画像だけの省略、未確認モデルへの転送はしません。保存bytesを取得できない場合も画像を除いた要求を送らず、失敗として表示します。

## LARMへの接続と送信

保存済みLARM設定からprofileを発見し、Connectionのready確認とclaimを経て、backendだけがProvider credentialを使います。主会話と補助要求は保存済みのprofileを使い、それぞれ独立したsession identityを持ちます。共有KVとSessionの構成、個別sessionのcontext window・出力予約はLARMが管理します。

画像対応はモデル名で判断せず、`supportedCapabilities`の`llm.vision`と`chatInput.contractVersion=larm-chat-input.v1`で確認します。user messageの本文と画像を順序付きcontent partsにし、画像bytesをBase64 data URLへ変換するのは推論を組み立てるbackendだけです。特殊markerはProviderが挿入します。

`chatInput.tokenCounting.endpoint`で発見した正式計数操作へ、推論に送るものと同じ最終JSONを送ります。token計数の契約、digest、モデル、画像数、出力予約、context windowを検査し、同じclaimで生成します。renew後は再claimしたcredentialと契約を使います。取消signalは計数・推論・streamに伝え、通信断で結果が不明な推論POSTは自動再送しません。

最近の会話windowに含まれる過去のuser画像も毎回再送します。ConnectionやKV cacheだけで画像が保持されるとは扱いません。画像の意味・用途・必要な操作は主会話モデルが判断し、文字検索や文字のMemory処理には原本やBase64を渡しません。

## 保持とログ

LARMの画像保持方針はclaimの`chatInput.retention`から取得し、添付欄に表示します。2026-10-13確認時の`full-required`監査は要求・画像・応答を暗号化して最長7日保持します。計数だけのpayloadは保存しません。「LARMに画像が保存されない」とは案内しません。

通常ログには画像、本文、ファイル名、Base64、credential、Provider生応答を入れません。requestId、runId、jobId、容量、時間、分類したエラーで追跡します。

## 検証

- 部分・API結合: `bun test api/domains/conversation/test/attachments.test.ts api/domains/larm/test/chat-input.test.ts api/application/chat-image-attachments.test.ts`
- ブラウザfixture: `bun x playwright test tests/browser/chat-image-attachments.spec.ts`
- 限定live受入: `bun scripts/chat-image-live.ts --run`。保存済み接続設定を読み、隔離DBのEumenes経路から非機密の合成画像を送る。自身のConnectionだけを解放する。
- [実装と検証記録](../spec/.archived/chat-image-attachments-work-record-2026-10-13.md)
