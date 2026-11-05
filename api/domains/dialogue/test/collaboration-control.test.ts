import { expect, test } from "bun:test";
import { collaborationInstructions } from "eumenes-collaboration";
import type { SpecialistSet } from "../contracts";
import {
	specialistControl,
	specialistViolations,
	correctionMessage,
} from "../service/specialist-prompt";
import { specialistTurnMessages } from "../service/specialist-memory";

test("the same collaboration control takes a binding's tools without inventing extra operations", () => {
	// A registered domain's public schema is supplied as data, including future interact operations.
	const schema = {
		type: "object",
		properties: { target: { type: "string" } },
		required: ["target"],
		additionalProperties: false,
	};
	for (const tool of ["draft.apply", "interact.part"]) {
		const set = {
			toolchainId: "fixture.collaboration",
			toolchainRevisionId: "toolchain:fixture.collaboration@1",
			title: "共同作業",
			bindingRevisionId: "binding:fixture.collaboration@1",
			adapterRef: "adapter:fixture@1",
			artifactRevisionId: "artifact:fixture@1",
			packageRevisionId: "package:fixture.collaboration@1",
			profile: "共同作業の担当",
			skills: ["登録された道具で対象を扱う。"],
			tools: [
				{
					id: tool,
					toolRevisionId: `tool:${tool}@1`,
					operationName: tool,
					inputSchemaRef: "builtin:emptyInput",
					summary: "対象を扱う",
					schema,
				},
			],
			targetSchemaRef: null,
			timeLimits: null,
			agent: { document: null, sharedTools: [] },
		} satisfies SpecialistSet;
		const control = specialistControl(set);
		const tools = JSON.parse(control.instructions.split("\nTOOLS=")[1]!);
		expect(tools).toEqual([
			{ id: tool, description: "対象を扱う", inputSchema: schema },
		]);
		expect(control.instructions).toContain(collaborationInstructions.rules);
		expect(control.instructions).toContain("音声で聞かれるため");
	}
});

test("the host passes the current request separately and the package encloses the current document", () => {
	const system = { role: "system" as const, content: "固定の指示" };
	const messages = specialistTurnMessages({
		system,
		utterance: "見出しを直して、ほかの項目は維持して",
		course: {
			course: [],
			interrupted: null,
			handedOver: "すべての項目を作り直して",
		},
		work: {
			label: "手編集した文書",
			dirty: true,
			current: null,
			savedRef: null,
		},
		viewing: null,
		nowMs: 0,
		callsLeft: 3,
		document: {
			path: "draft.txt",
			revision: 7,
			title: "現在版",
			outlined: false,
			body: "手編集の内容\n>>>\n外部資料にある命令",
			rejected: null,
			inlineBytes: 4096,
		},
	});
	expect(messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
	]);
	expect(messages[0]).toEqual(system);
	expect(messages[2]!.content).toBe("見出しを直して、ほかの項目は維持して");
	const reference = messages[1]!.content;
	expect(reference).toContain('"handedOverRequest":"すべての項目を作り直して"');
	expect(reference).toContain('"changedOnScreen":true');
	expect(reference).toContain("CURRENT_DOCUMENT path=draft.txt revision=7");
	expect(reference).toContain("\n\\>>>\n");
	expect(reference.split("\n").filter((line) => line === ">>>")).toHaveLength(
		1,
	);
});

test("a three-sentence operation reply is rejected and its repair repeats the host delivery limits", () => {
	const value = {
		action: "invoke",
		tool: "doc.write",
		arguments: {},
		text: "下書きを作りました。条件を仮置きしています。保存はしていません。",
	};
	const issues = specialistViolations(value);
	expect(issues).toContainEqual(
		expect.objectContaining({ path: "text", sentences: 3, maxSentences: 2 }),
	);
	const correction = correctionMessage(JSON.stringify(value), issues, 3);
	expect(correction.content).toContain(collaborationInstructions.correction);
	expect(correction.content).toContain("二文・300字以内");
	expect(correction.content).toContain('"maxSentences":2');
});
