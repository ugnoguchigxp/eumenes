import { systemContext } from "../../../infrastructure/system-context";
import { readFileSync } from "node:fs";
import type { Definition } from "../contracts";
const base = {
	revision: 1,
	aliases: [],
	tags: [],
	useWhen: [],
	avoidWhen: [],
	dependencies: [],
};
export const imageBuiltins: Definition[] = [
	{
		...base,
		kind: "profile",
		id: "image.create",
		title: "画像制作担当",
		summary: "画像制作・編集画面・履歴の依頼を解釈する",
		body: systemContext("capabilities.contexts.image.body", {}),
	},
	{
		...base,
		kind: "skill",
		id: "image.create",
		title: "画像生成と閲覧",
		summary: "依頼を一つの画像計画にする",
		body: readFileSync(new URL("./image/SKILL.md", import.meta.url), "utf8"),
	},
	{
		...base,
		kind: "tool",
		id: "image.generate",
		title: "画像生成・画面表示",
		summary:
			"generateなら一度生成、studio/libraryなら画面を開く。width/heightは100〜1280、formatはPNG/WebP、seedは非負整数。",
		backend: "image",
		schemaKey: "imagePlan",
	},
	{
		...base,
		kind: "package",
		id: "image.create",
		title: "画像生成",
		summary: "画像を作成し、編集画面と保存画像一覧を開く",
		backend: "image",
		schemaKey: "imageRequest",
		dependencies: [
			"profile:image.create@1",
			"skill:image.create@1",
			"tool:image.generate@1",
		],
		profileRevisionId: "profile:image.create@1",
		requiredSkillRevisionIds: ["skill:image.create@1"],
		toolRevisionIds: ["tool:image.generate@1"],
	},
];
