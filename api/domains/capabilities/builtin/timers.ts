import { readFileSync } from "node:fs";
import type { Definition } from "../contracts";

const skill = readFileSync(
	new URL("./timers/SKILL.md", import.meta.url),
	"utf8",
);
const base = {
	revision: 1,
	aliases: [] as string[],
	tags: [] as string[],
	useWhen: [] as string[],
	avoidWhen: [] as string[],
};

export const timerBuiltins: Definition[] = [
	{
		...base,
		kind: "skill",
		id: "timers.manage",
		title: "タイマー操作",
		summary: "相対時間タイマーの開始、照会、取消",
		dependencies: [],
		body: skill,
	},
	{
		...base,
		kind: "profile",
		id: "timers.manage",
		title: "タイマー担当",
		summary: "現在の依頼のタイマーを保存確認してから報告する",
		dependencies: [],
		body: "相対時間の開始、照会、取消だけを扱います。保存済みreceiptの前に開始や取消を報告しません。",
	},
	{
		...base,
		kind: "tool",
		id: "timer.start",
		title: "タイマー開始",
		summary: "相対時間のタイマーを保存する",
		dependencies: [],
		backend: "timer",
		schemaKey: "timerStart",
	},
	{
		...base,
		kind: "tool",
		id: "timer.list",
		title: "タイマー照会",
		summary: "現在のタイマーを取得する",
		dependencies: [],
		backend: "timer",
		schemaKey: "timerList",
	},
	{
		...base,
		kind: "tool",
		id: "timer.cancel",
		title: "タイマー取消",
		summary: "指定したタイマーを取り消す",
		dependencies: [],
		backend: "timer",
		schemaKey: "timerCancel",
	},
	{
		...base,
		kind: "package",
		id: "timers.manage",
		title: "タイマー",
		summary: "相対時間タイマーを開始、照会、取消する",
		aliases: ["タイマー", "カウントダウン", "残り時間", "timer", "countdown"],
		useWhen: ["現在の依頼がタイマーの開始、確認、取消である"],
		avoidWhen: ["説明", "引用", "反復アラーム"],
		backend: "timer",
		schemaKey: "timerCommand",
		dependencies: [
			"profile:timers.manage@1",
			"skill:timers.manage@1",
			"tool:timer.start@1",
			"tool:timer.list@1",
			"tool:timer.cancel@1",
		],
		profileRevisionId: "profile:timers.manage@1",
		requiredSkillRevisionIds: ["skill:timers.manage@1"],
		toolRevisionIds: [
			"tool:timer.start@1",
			"tool:timer.list@1",
			"tool:timer.cancel@1",
		],
	},
];
