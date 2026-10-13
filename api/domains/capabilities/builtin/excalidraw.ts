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
export const excalidrawBuiltins: Definition[] = [
	{
		...base,
		kind: "profile",
		id: "excalidraw.edit",
		title: "図の編集担当",
		summary: "図の作成・再表示を案内する",
		body: "あなたは図の編集担当です。利用者の依頼からExcalidrawの新しい図または保存済み図の編集入口を選び、ツールの出力契約を満たします。保存先と権限はホストが管理します。",
	},
	{
		...base,
		kind: "skill",
		id: "excalidraw.edit",
		title: "図の編集画面",
		summary: "保存済み図から編集対象を選ぶ",
		body: readFileSync(
			new URL("./excalidraw/SKILL.md", import.meta.url),
			"utf8",
		),
	},
	{
		...base,
		kind: "tool",
		id: "excalidraw.open",
		title: "Excalidrawを開く",
		summary:
			"createで新しい図、openでreferenceIdと任意の版、libraryで一覧。利用可能な図だけを指定する",
		backend: "excalidraw",
		schemaKey: "drawingPlan",
	},
	{
		...base,
		kind: "package",
		id: "excalidraw.edit",
		title: "図の編集",
		summary: "Excalidraw編集画面を準備する",
		backend: "excalidraw",
		schemaKey: "drawingRequest",
		dependencies: [
			"profile:excalidraw.edit@1",
			"skill:excalidraw.edit@1",
			"tool:excalidraw.open@1",
		],
		profileRevisionId: "profile:excalidraw.edit@1",
		requiredSkillRevisionIds: ["skill:excalidraw.edit@1"],
		toolRevisionIds: ["tool:excalidraw.open@1"],
	},
];
