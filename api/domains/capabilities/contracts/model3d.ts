import { z } from "zod";

/** Host-issued references from the 3D snapshot (assets, generations and source images). */
const ref = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const title = z.string().trim().min(1).max(80);
const tags = z.array(z.string().trim().min(1).max(24)).max(8);

export const model3dGenerate = z
	.object({
		prompt: z
			.string()
			.trim()
			.max(2000)
			.describe(
				"元画像として描くもの。一つの対象を全身が見える形で、無地の背景で書く（例: 白い背景に、青緑の小さなロボットを全身で描く）。sourceImageRefを使うときは空文字。",
			),
		title: title.describe("3Dモデルの短い日本語のタイトル"),
		tags: tags.describe("利用者が言った分類だけ。無ければ空配列"),
		sourceImageRef: ref
			.optional()
			.describe("既存の画像を立体にするとき、snapshotのimages[].imageRef"),
	})
	.strict()
	.refine((v) => !!v.sourceImageRef || v.prompt.length > 0, {
		message: "prompt or sourceImageRef is required",
	});
export const model3dFind = z
	.object({
		query: z
			.string()
			.trim()
			.max(100)
			.describe("タイトル・元の文・タグを探す語。空白区切りで全て含むもの"),
		tags: tags.describe("全て付いているタグ。無ければ空配列"),
	})
	.strict();
export const model3dTarget = z
	.object({ assetRef: ref.describe("snapshotのassets[].assetRef") })
	.strict();
export const model3dUpdate = z
	.object({
		assetRef: ref.describe("snapshotのassets[].assetRef"),
		title: title.optional().describe("新しいタイトル。変えないなら省く"),
		tags: tags
			.optional()
			.describe(
				"変更後のタグの全件。追加・削除は今のタグに反映して渡す。変えないなら省く",
			),
	})
	.strict();
export const model3dJobTarget = z
	.object({
		generationRef: z.uuid().describe("snapshotのgenerations[].generationRef"),
	})
	.strict();
