# インスタント3Dモデル

文章、または LARM の画像ライブラリにある画像から 3D モデル（GLB）を作り、保存済みのモデルを探して表示し、タイトル・タグの変更や削除をする。設計は [設計書](../spec/instant-3d-model-toolchain-design-2026-10-18.md)。

## 接続

- 保存済みの LARM Control 接続先と、backend の Control Bearer（`LARM_API_TOKEN`）を使う。agent-connections の確保や会話 Profile の切替はしない。Provider credential は使わない。
- 生成先は、`GET /v3/agent-profiles` のルート `services` から capability `media.mesh.generate`・protocol `larm.mesh-generation.v1` で探す。要求の `model` にはそのサービスの `model` を入れ、POST はそのサービスの `url`（保存済み Control と同じ origin のものだけ）へ送る。文章から作るときは、同じ catalog の `media.image.generate`／`larm.image-generation.v1` のサービスの `model` を `source.imageModel` に入れる。どちらかが見つからなければ利用不能として止め、モデル名を推測しない。
- 解像度は 512。`steps` は送らない。シードは依頼ごとに backend が決めて保存する。

## 生成の流れ

1. 依頼（画面の `POST /api/model3d/generations`、または会話の `model3d_studio`）を保存し、UUID の再送キーを発行する。
2. キューのジョブ `model3d.submit` が catalog を読み、要求本文を一度だけ確定して保存してから POST する。通信断や再起動の後は、同じキーと同じ本文で送り直す。429 は `Retry-After` を待つ。400・401・409・503・507 は理由を付けて失敗にし、作り直さない。
3. `model3d.poll` が `GET /v1/3d/generations/:jobId` を数秒おきに読み、status と stage を別々に保存する。画面は stage を日本語に置き換えて表示し、進捗率は出さない。60分たっても終わらなければ待つのをやめ、画面の「状態を再確認」で再び追う。
4. 完了すると assetId と warnings を保存する。会話から頼まれた生成なら、その会話へ完了（または失敗）の発言を一件追加する。`deleted:true` の完了は「完成品は削除済み」と表示する。
5. 取消は `DELETE /v1/3d/generations/:jobId`。取消の後に届いた完了は採用しない。完成品の削除とは別の操作である。

`failed` の `interrupted` と `worker_stop_failed` は自動で作り直さない。

## 保存済みモデル

- 正本は LARM にある。Eumenes は、会話の担当が対象を選ぶための目録（ID・タイトル・タグ・作成日時・元の文の先頭・警告）だけを SQLite に持つ。GLB と画像はコピーしない。
- 画面の一覧・検索は `GET /api/model3d/assets`（`q`・`tags`・`sort`・`order`・`limit`・`cursor`）で LARM に問い合わせる。条件を変えたら cursor を捨てる。
- 表示は `GET /api/model3d/assets/:id/content` の GLB を three.js で描く（回転・拡大・リセット・背景の明暗）。LARM の preview HTML は使わない。
- タイトル・タグの変更は `PATCH`、削除は `DELETE`。削除しても元の画像ライブラリの画像は残る。

## 会話

toolchain `model3d.studio@1`（関数 `model3d_studio`、表示名「インスタント3Dモデル」）。command 担当が `open`・`generate`・`find`・`show`・`update`・`delete`・`cancel` から一つを選ぶ。対象は snapshot にあるホストの ref（`assetRef`・`generationRef`・`imageRef`）だけを受け付ける。生成の成功と、編集・印刷に向く品質は区別し、警告を伝える。編集には Blender 4.0 以降か WebP テクスチャ対応のビューアを使う。

## 確認

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/model3d.bundle.json
bun run verify -- --domain model3d
bun test api/domains/larm/test/mesh-library.test.ts api/application/media/model3d-adapter.test.ts
bunx vitest run web/src/domains/model3d
```

固定試験は LARM のスタブで行う。実 LARM での生成・表示・削除と、会話からの受入は別に記録する。
