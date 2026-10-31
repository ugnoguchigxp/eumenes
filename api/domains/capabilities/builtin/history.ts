import { systemContext } from "../../../infrastructure/system-context";
import { readFileSync } from "node:fs";
import type { Definition } from "../contracts";
const common = {
	revision: 1,
	aliases: [],
	tags: [],
	useWhen: [],
	avoidWhen: [],
	dependencies: [],
};
export const historyBuiltins: Definition[] = [
	{
		...common,
		kind: "profile",
		id: "history.research",
		title: "会話履歴担当",
		summary: "許可された保存済み発言を確認",
		body: systemContext("capabilities.contexts.history.body", {}),
	},
	{
		...common,
		revision: 2,
		kind: "skill",
		id: "history.research",
		title: "会話履歴参照",
		summary: "段階取得と原文版検証",
		body: readFileSync(
			new URL("./history/SKILL.v2.md", import.meta.url),
			"utf8",
		),
	},
	{
		...common,
		kind: "tool",
		id: "history.search",
		title: "会話履歴検索",
		summary: "キーワード・日時で限定された候補を探す",
		backend: "history",
		schemaKey: "historySearch",
	},
	{
		...common,
		kind: "tool",
		id: "history.read",
		title: "会話履歴の周辺読取り",
		summary: "発言と前後の保存済み原文を読む",
		backend: "history",
		schemaKey: "historyRead",
	},
	{
		...common,
		revision: 2,
		kind: "package",
		id: "history.research",
		title: "会話履歴の確認",
		summary: "前に何と言ったか、過去に決めた日時や会話を検索・確認する",
		aliases: ["履歴", "会話履歴", "前に", "以前", "決めた", "history"],
		tags: ["history"],
		useWhen: ["保存済みの会話を確認する依頼"],
		avoidWhen: ["公開情報の検索", "一般的な歴史の質問"],
		backend: "history",
		schemaKey: "history",
		dependencies: [
			"profile:history.research@1",
			"skill:history.research@2",
			"tool:history.search@1",
			"tool:history.read@1",
		],
		profileRevisionId: "profile:history.research@1",
		requiredSkillRevisionIds: ["skill:history.research@2"],
		toolRevisionIds: ["tool:history.search@1", "tool:history.read@1"],
	},
];
