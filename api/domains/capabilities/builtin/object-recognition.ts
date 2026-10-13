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
export const objectRecognitionBuiltins: Definition[] = [
	{
		...base,
		kind: "profile",
		id: "object-recognition.manage",
		title: "物体検出操作担当",
		summary: "入力画面と保存済み検出結果の操作を選ぶ",
		body: "物体認識の操作担当です。ユーザーの意図を認可済みsnapshotと公開ツールに基づいて解釈します。画面表示・結果照会・取消要求を区別し、未取得の観測を作りません。",
	},
	{
		...base,
		kind: "skill",
		id: "object-recognition.manage",
		title: "物体認識の手順",
		summary: "カメラ入力・座標・時刻・取消の境界",
		body: readFileSync(
			new URL("./object-recognition/SKILL.md", import.meta.url),
			"utf8",
		),
	},
	{
		...base,
		kind: "tool",
		id: "object-recognition.manage",
		title: "物体認識画面と結果",
		summary:
			"action=openは入力画面表示、readは認可済みidの結果、cancelは上流取消要求。frameIndex=-1は全時刻、それ以外はsnapshotのフレーム番号。",
		backend: "object-recognition",
		schemaKey: "recognitionManage",
	},
	{
		...base,
		kind: "package",
		id: "object-recognition.manage",
		title: "物体認識",
		summary: "撮影・選択入力の検出画面と保存済み観測を扱う",
		backend: "object-recognition",
		schemaKey: "toolchainRequest",
		dependencies: [
			"profile:object-recognition.manage@1",
			"skill:object-recognition.manage@1",
			"tool:object-recognition.manage@1",
		],
		profileRevisionId: "profile:object-recognition.manage@1",
		requiredSkillRevisionIds: ["skill:object-recognition.manage@1"],
		toolRevisionIds: ["tool:object-recognition.manage@1"],
	},
];
