import { expect, test } from "bun:test";
import type { SpecialistSet } from "../contracts";
import { decodeSpecialistOutput } from "../service/specialist-output";
import { specialistControl } from "../service/specialist-prompt";

test("guidance instructions appear only for a turn that can use the tool", () => {
	const set: SpecialistSet = {
		toolchainId: "test.production",
		toolchainRevisionId: "toolchain:test.production@1",
		title: "制作",
		bindingRevisionId: "binding:test.production@1",
		adapterRef: "adapter:test.production@1",
		artifactRevisionId: "artifact:test.production@1",
		packageRevisionId: "package:test.production@1",
		profile: "制作を担当する",
		skills: [],
		tools: [],
		targetSchemaRef: null,
		timeLimits: null,
		agent: { document: null, sharedTools: [] },
	};
	const tool = {
		id: "get_guidance",
		description: "制作に必要な手順を参照する",
		inputSchema: { type: "object" },
	};
	const instructions = specialistControl(set, [tool]).instructions;
	expect(instructions).toContain("GUIDANCE_CANDIDATES");
	expect(instructions).toContain("最後の利用者メッセージに全文");
	expect(instructions).toContain("何を次に確認するかは担当が判断します");
	expect(specialistControl(set).instructions).not.toContain("get_guidance");
	expect(specialistControl(set, [tool], true).instructions).not.toContain(
		"get_guidance",
	);
});

test("the structured specialist reply retains two bounded sentences and rejects a third", () => {
	const packet = {
		action: "reply",
		tool: null,
		arguments: null,
		forward: null,
		stateUpdate: null,
		text: { first: "版を確認します。", second: "設定も照合します。" },
	};
	expect(decodeSpecialistOutput(JSON.stringify(packet))).toEqual({
		action: "reply",
		text: "版を確認します。 設定も照合します。",
	});
	expect(() =>
		decodeSpecialistOutput(
			JSON.stringify({
				...packet,
				text: {
					first: "版を確認します。 設定も照合します。",
					second: "差分を報告します。",
				},
			}),
		),
	).toThrow();
});

test("the reply can quote an exact numbered Markdown heading and a version in two sentences", () => {
	const packet = {
		action: "reply",
		tool: null,
		arguments: null,
		forward: null,
		stateUpdate: null,
		text: {
			first: "まず「2. 報告」の字下げを確認してください。",
			second: "CommonMark 0.31.2 の設定も照合します。",
		},
	};
	expect(decodeSpecialistOutput(JSON.stringify(packet))).toEqual({
		action: "reply",
		text: packet.text.first + " " + packet.text.second,
	});
});
