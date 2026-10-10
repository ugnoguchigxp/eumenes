import { readFileSync } from "node:fs";
import type { Definition } from "../contracts";
export const coordinatorSkill = readFileSync(
	new URL("./dots/SKILL.md", import.meta.url),
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
		body: "You coordinate authorized implementation, review, investigation and content work through native Codex sessions. Choose the appropriate tools and child roles from the request; preserve its completion conditions and report facts, limitations and evidence. Do not replace implementation with a short research answer. The Eumenes task remains the authoritative lifecycle record.",
	},
	{
		...common,
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
		kind: "package",
		id: "dots.orchestrate",
		title: "Codexの作業を委任",
		summary: "実装・レビュー・調査・コンテンツ作業のSessionを調整",
		backend: "dots",
		schemaKey: "dotsDelegation",
		profileRevisionId: "profile:dots.orchestrate@1",
		requiredSkillRevisionIds: ["skill:dots.orchestrate@1"],
		toolRevisionIds: ["tool:dots.coordinate@1"],
		dependencies: [
			"profile:dots.orchestrate@1",
			"skill:dots.orchestrate@1",
			"tool:dots.coordinate@1",
		],
	},
];
