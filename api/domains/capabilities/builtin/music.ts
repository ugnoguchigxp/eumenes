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
export const musicBuiltins: Definition[] = [
	{
		...base,
		kind: "profile",
		id: "music.playback",
		title: "音楽再生担当",
		summary: "保存曲を選んでプレイリストを開く",
		body: systemContext("capabilities.contexts.music.body-2", {}),
	},
	{
		...base,
		kind: "skill",
		id: "music.playback",
		revision: 2,
		title: "保存曲の選曲",
		summary: "依頼に添えられた曲を開くか、実在するタグから検索条件を作る",
		body: readFileSync(
			new URL("./music-playback/SKILL-v2.md", import.meta.url),
			"utf8",
		),
	},
	{
		...base,
		kind: "tool",
		id: "music.library",
		revision: 2,
		title: "楽曲ライブラリ",
		summary:
			"添えられた曲、または保存済み曲の検索結果でプレイリスト参照を保存する",
		backend: "music",
		schemaKey: "musicPlaybackPlanV2",
	},
	{
		...base,
		kind: "package",
		id: "music.playback",
		revision: 2,
		title: "音楽再生",
		summary:
			"LARMの保存曲、または依頼に添えられた曲をPlaylistとMusicPlayerで再生する",
		backend: "music",
		schemaKey: "musicRequest",
		dependencies: [
			"profile:music.playback@1",
			"skill:music.playback@2",
			"tool:music.library@2",
		],
		profileRevisionId: "profile:music.playback@1",
		requiredSkillRevisionIds: ["skill:music.playback@2"],
		toolRevisionIds: ["tool:music.library@2"],
	},
];
