import { expect, test } from "bun:test";
import type { LarmCallOptions } from "../../domains/larm";
import { createGitObservation } from "../../domains/git-observation";
import { fixture } from "./app-development.fixture";
import { readingNotes, readingRequest } from "./app-records.fixture";

test("ordinary app authoring carries its operation contract, saved reasoning and unchanged output bound to LARM", async () => {
	const calls: Array<{ system: string; options: LarmCallOptions | undefined }> =
		[];
	const h = await fixture({
		request: readingRequest,
		draft: readingNotes,
		git: createGitObservation("/unused"),
		specialist: (messages, _signal, options) => {
			calls.push({ system: messages[0]!.content, options });
			return {
				action: "invoke",
				tool: "doc.write",
				arguments: {
					baseRevision: 0,
					title: "読書メモ",
					content: readingNotes,
				},
				text: "下書きを作りました。",
			};
		},
	});
	try {
		await h.propose(readingRequest);
		expect((await h.source()).data.work.confirmation).toBeTruthy();
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.system).toContain("OUTPUT_SCHEMA=");
		expect(call.system).toContain("doc.write");
		expect(call.options).toMatchObject({
			jsonOutput: true,
			reasoning: "low",
			maxOutputTokens: 16144,
			sessionRole: "subagent",
		});
		// Ordinary collaboration has open operation arguments; strict delivery uses a different explicit schema.
		expect(call.options?.jsonSchema).toBeUndefined();

		const bundle = await Bun.file(
			"api/domains/capabilities/bundles/app-development.bundle.json",
		).json();
		const binding = bundle.bindings.find(
			(x: { revision: number }) => x.revision === 13,
		);
		expect(binding.agent.turn).toEqual({
			maxModelCalls: 4,
			retries: { "doc.edit": 1, "doc.write": 1 },
			maxOutputTokens: 6144,
		});
	} finally {
		await h.close();
	}
}, 10000);
