import { z } from "zod";

/** The operations of the `resources` toolchain's one function (spec resource-uri-implementation-plan §8.1). */
export const resourcesOperations = ["find", "open", "play", "read"] as const;
export type ResourcesOperation = (typeof resourcesOperations)[number];

export const RESOURCES_FIND_LIMIT_DEFAULT = 5;
export const RESOURCES_FIND_LIMIT_MAX = 10;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The arguments of the `resources` toolchain's function: one flat object (a tool takes no union), where
 * `operation` says which of the four is meant. `find` takes `query` and the optional filters; `open`, `play`
 * and `read` take `item`, a number (`a<n>`) the conversation was shown.
 */
export const resourcesTool = z
	.object({
		operation: z
			.enum(resourcesOperations)
			.describe(
				"find=生成物や過去の記録を探す、open=画面に表示する、play=再生する、read=内容を読んで伝える。",
			),
		query: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"find のとき必須。探したいものを利用者の言葉のまま書く（例: ダース・ベーダーの画像、先週の調査）。",
			),
		kind: z
			.string()
			.trim()
			.min(1)
			.max(40)
			.optional()
			.describe(
				"find のとき任意。種類の表示名で絞る（例: 画像、曲、調査報告）。絞らないときは書かない。",
			),
		since: day
			.optional()
			.describe(
				"find のとき任意。この日（日本時間・YYYY-MM-DD）以降に作られたものに絞る。",
			),
		until: day
			.optional()
			.describe(
				"find のとき任意。この日（日本時間・YYYY-MM-DD）以前に作られたものに絞る。",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(RESOURCES_FIND_LIMIT_MAX)
			.optional()
			.describe(
				`find のとき任意。返す件数（1〜${RESOURCES_FIND_LIMIT_MAX}。既定${RESOURCES_FIND_LIMIT_DEFAULT}）。`,
			),
		item: z
			.string()
			.regex(/^a[1-9][0-9]{0,5}$/)
			.optional()
			.describe(
				"open・play・read のとき必須。<state> に載っている番号か、find の結果の番号（例: a3）。",
			),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.operation === "find") {
			if (value.query === undefined)
				ctx.addIssue({ code: "custom", path: ["query"], message: "required" });
			if (value.item !== undefined)
				ctx.addIssue({
					code: "custom",
					path: ["item"],
					message: "not_allowed",
				});
			return;
		}
		if (value.item === undefined)
			ctx.addIssue({ code: "custom", path: ["item"], message: "required" });
		for (const key of ["query", "kind", "since", "until", "limit"] as const)
			if (value[key] !== undefined)
				ctx.addIssue({ code: "custom", path: [key], message: "not_allowed" });
	});
export type ResourcesToolInput = z.infer<typeof resourcesTool>;
