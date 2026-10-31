import { systemContext } from "../../../infrastructure/system-context";
import { readFileSync } from "node:fs";
import type { Definition } from "../contracts";
export const coordinatorSkill = readFileSync(
	new URL("./dots/SKILL.md", import.meta.url),
	"utf8",
);
export const dotsMcpSkill = readFileSync(
	new URL("./dots/MESSAGING.v2.md", import.meta.url),
	"utf8",
);
const common = {
	revision: 1,
	aliases: [],
	tags: [],
	useWhen: [],
	avoidWhen: [],
	dependencies: [],
};
export const dotsBuiltins: Definition[] = [
	{
		...common,
		kind: "profile",
		id: "dots.orchestrate",
		title: "Codex作業の調整担当",
		summary: "対象プロジェクトのSessionへ委任し進捗と不足を報告",
		body: systemContext("capabilities.contexts.dots.body", {}),
	},
	{
		...common,
		revision: 2,
		kind: "skill",
		id: "dots.orchestrate",
		title: "dots連携手順",
		summary: "受領・Session紐付け・質問・結果・停止の報告",
		body: coordinatorSkill,
	},
	{
		...common,
		kind: "tool",
		id: "dots.coordinate",
		title: "dotsへの委任",
		summary: "登録したプロジェクトに作業を委任",
		backend: "dots",
		schemaKey: "dotsDelegation",
	},
	{
		...common,
		revision: 2,
		kind: "package",
		id: "dots.orchestrate",
		title: "Codexの作業を委任",
		summary: "実装・レビュー・調査・コンテンツ作業のSessionを調整",
		backend: "dots",
		schemaKey: "dotsDelegation",
		profileRevisionId: "profile:dots.orchestrate@1",
		requiredSkillRevisionIds: ["skill:dots.orchestrate@2"],
		toolRevisionIds: ["tool:dots.coordinate@1"],
		dependencies: [
			"profile:dots.orchestrate@1",
			"skill:dots.orchestrate@2",
			"tool:dots.coordinate@1",
		],
	},
	{
		...common,
		revision: 2,
		kind: "skill",
		id: "dots.messaging",
		title: "dotsメッセージの返却手順",
		summary: "メッセージへの返答と連携後の要約をMCPへ返す",
		body: dotsMcpSkill,
	},
];
