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
		id: "music.create",
		title: "楽曲担当",
		summary: "テーマを楽曲生成指示へ整える",
		body: systemContext("capabilities.contexts.music.body", {}),
	},
	{
		...base,
		kind: "skill",
		id: "music.create",
		title: "楽曲生成",
		summary: "テーマの装飾と生成指示の作成",
		body: readFileSync(new URL("./music/SKILL.md", import.meta.url), "utf8"),
	},
	{
		...base,
		kind: "tool",
		id: "music.generate",
		title: "楽曲生成API",
		summary: "指定した生成指示と長さで一度生成して音声を取得する",
		backend: "music",
		schemaKey: "musicPlan",
	},
	{
		...base,
		kind: "package",
		id: "music.create",
		title: "楽曲生成",
		summary: "ユーザーのテーマから曲を作りArtifactで再生する",
		backend: "music",
		schemaKey: "musicRequest",
		dependencies: [
			"profile:music.create@1",
			"skill:music.create@1",
			"tool:music.generate@1",
		],
		profileRevisionId: "profile:music.create@1",
		requiredSkillRevisionIds: ["skill:music.create@1"],
		toolRevisionIds: ["tool:music.generate@1"],
	},
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
		title: "保存曲の選曲",
		summary: "依頼と実在するタグから検索条件を作る",
		body: readFileSync(
			new URL("./music-playback/SKILL.md", import.meta.url),
			"utf8",
		),
	},
	{
		...base,
		kind: "tool",
		id: "music.library",
		title: "楽曲ライブラリ",
		summary: "保存済み曲を検索してプレイリスト参照を保存する",
		backend: "music",
		schemaKey: "musicPlaybackPlan",
	},
	{
		...base,
		kind: "package",
		id: "music.playback",
		title: "音楽再生",
		summary: "LARMの保存曲をPlaylistとMusicPlayerで再生する",
		backend: "music",
		schemaKey: "musicRequest",
		dependencies: [
			"profile:music.playback@1",
			"skill:music.playback@1",
			"tool:music.library@1",
		],
		profileRevisionId: "profile:music.playback@1",
		requiredSkillRevisionIds: ["skill:music.playback@1"],
		toolRevisionIds: ["tool:music.library@1"],
	},
];

// Keep the published V1 definitions intact; V2 uses the same worker and API.
musicBuiltins.push(
	{
		...base,
		kind: "skill",
		id: "music.create",
		revision: 2,
		title: "楽曲・歌声生成",
		summary: "選択条件と歌詞を楽曲生成指示へ整える",
		body: readFileSync(new URL("./music/SKILL-v2.md", import.meta.url), "utf8"),
	},
	{
		...base,
		kind: "tool",
		id: "music.generate",
		revision: 2,
		title: "楽曲・歌声生成API",
		summary: "生成指示・歌声の有無・歌詞・言語・長さで一度生成する",
		backend: "music",
		schemaKey: "musicPlanV2",
	},
	{
		...base,
		kind: "package",
		id: "music.create",
		revision: 2,
		title: "楽曲・歌声生成",
		summary: "フォームまたは依頼から曲を作り共通プレイヤーで再生する",
		backend: "music",
		schemaKey: "musicRequest",
		dependencies: [
			"profile:music.create@1",
			"skill:music.create@2",
			"tool:music.generate@2",
		],
		profileRevisionId: "profile:music.create@1",
		requiredSkillRevisionIds: ["skill:music.create@2"],
		toolRevisionIds: ["tool:music.generate@2"],
	},
);

// Playback V2 opens the tracks a request carried instead of searching; V1 stays as published.
musicBuiltins.push(
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
);
