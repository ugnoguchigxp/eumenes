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
export const objectRecognitionBuiltins: Definition[] = [
	{
		...base,
		kind: "profile",
		id: "object-recognition.manage",
		title: "物体検出操作担当",
		summary: "入力画面と保存済み検出結果の操作を選ぶ",
		body: systemContext("capabilities.contexts.object-recognition.body", {}),
	},
	{
		...base,
		kind: "skill",
		id: "object-recognition.manage",
		revision: 2,
		title: "物体認識と撮影の手順",
		summary: "撮影の確認・カメラと画面の撮影・表示中の画像を見せる境界",
		body: readFileSync(
			new URL("./object-recognition/SKILL-v2.md", import.meta.url),
			"utf8",
		),
	},
	{
		...base,
		kind: "tool",
		id: "object-recognition.manage",
		revision: 2,
		title: "物体認識画面・撮影・結果",
		summary:
			"action=openは入力画面表示、readは認可済みidの結果、cancelは上流取消要求、captureは承諾後にカメラ(camera)か画面(screen)を撮影して会話のLLMに見せる、askは表示中の保存済み画像を会話のLLMに見せる。frameIndex=-1は全時刻、それ以外はsnapshotのフレーム番号。",
		backend: "object-recognition",
		schemaKey: "recognitionManageV2",
	},
	{
		...base,
		kind: "package",
		id: "object-recognition.manage",
		revision: 2,
		title: "物体認識",
		summary:
			"撮影・選択入力の検出画面と保存済み観測を扱い、撮影画像を会話に見せる",
		backend: "object-recognition",
		schemaKey: "toolchainRequest",
		dependencies: [
			"profile:object-recognition.manage@1",
			"skill:object-recognition.manage@2",
			"tool:object-recognition.manage@2",
		],
		profileRevisionId: "profile:object-recognition.manage@1",
		requiredSkillRevisionIds: ["skill:object-recognition.manage@2"],
		toolRevisionIds: ["tool:object-recognition.manage@2"],
	},
];
