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
	expect(specialistControl(set, [tool]).instructions).toContain(
		"編集に進む前にget_guidanceを使います",
	);
	expect(specialistControl(set).instructions).not.toContain("get_guidance");
	expect(specialistControl(set, [tool], true).instructions).not.toContain(
		"get_guidance",
	);
});
