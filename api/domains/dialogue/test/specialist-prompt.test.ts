import { expect, test } from "bun:test";
import type { SpecialistSet } from "../contracts";
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
	expect(instructions).toContain("最初の行動として get_guidance を呼びます");
	expect(instructions).toContain(
		"追加情報を尋ねたりする前に、手順の候補を確認します",
	);
	expect(instructions).toContain("返ったSKILLは手順の候補として読みます");
	expect(instructions).toContain("次に何をするかは担当が判断します");
	expect(specialistControl(set).instructions).not.toContain("get_guidance");
	expect(specialistControl(set, [tool], true).instructions).not.toContain(
		"get_guidance",
	);
});
