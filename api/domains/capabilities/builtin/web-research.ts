import type { Definition } from "../contracts";
const base = { revision: 1, aliases: [], tags: [], useWhen: [], avoidWhen: [] };
export const builtins: Definition[] = [
	{
		...base,
		revision: 2,
		kind: "tool",
		id: "web.lookup",
		title: "Web検索",
		summary: "公開Webを検索して候補を取得",
		dependencies: [],
		backend: "web",
		schemaKey: "lookupV2",
	},
	{
		...base,
		kind: "tool",
		id: "web.read",
		title: "本文読取",
		summary: "指定した公開URLの本文を取得",
		dependencies: [],
		backend: "web",
		schemaKey: "read",
	},
	...[
		{ id: "web.find", schemaKey: "find" as const, title: "保存本文内検索" },
		{
			id: "web.read_saved",
			schemaKey: "readSaved" as const,
			title: "保存本文の範囲読取り",
		},
	].map((t) => ({
		...base,
		...t,
		kind: "tool" as const,
		backend: "web",
		summary: t.title,
		dependencies: [],
	})),
	{
		...base,
		kind: "tool",
		id: "recipe.find",
		title: "保存済みの取得手順",
		summary:
			"同じ要求の保存済み取得手順の候補を返す。titleは手順の要約、urlは取得し直すページ",
		dependencies: [],
		backend: "web",
		schemaKey: "recipeFind",
	},
];
