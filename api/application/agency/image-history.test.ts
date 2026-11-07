import { expect, test } from "bun:test";
import { harness, choice, updated } from "./host.fixture";
import { syntheticImages } from "../../domains/conversation/test/image.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("image-only input and its analysis reach autonomous selection as one identifiable exchange", async () => {
	const h = harness({ update: () => updated(), select: () => choice("wait") });
	const image = await h.conversation.uploadAttachment(
		"c1",
		crypto.randomUUID(),
		(await syntheticImages())[1]!,
	);
	await h.conversation.append({
		...h.message("c1", "image-input", "user", "", "vision-run"),
		attachments: [image],
	});
	const analysis =
		"赤い円が3個、青い四角が2個、緑の三角が1個。文字はR7K4です。";
	await h.say("analysis", "assistant", analysis, "vision-run");
	await waitFor(() => h.calls.select === 1);
	const data = JSON.parse(
		h.requests.find((r) => r.purpose === "select")!.prompt,
	);
	for (const id of ["image-input", "analysis"]) {
		const observation = data.observations.find(
			(o: { id: string }) => o.id === id,
		);
		expect(observation.text).toContain(image.id);
		expect(observation.text).toContain("image-input");
	}
	const answer = data.observations.find(
		(o: { id: string }) => o.id === "analysis",
	);
	expect(answer.text).toContain(analysis);
	expect(answer.text).not.toContain("画像付きのモデル呼出しが正常終了");
	expect(data.delivered).toContain(answer.text);
	expect(data.conversationEvidenceRefs).toContain("image-input");
	expect(JSON.stringify(data)).not.toMatch(
		/base64|data:image|originalMime|bytes/,
	);
});

test("a host-recorded image answer reaches autonomous selection as execution evidence", async () => {
	const h = harness({ update: () => updated(), select: () => choice("wait") });
	const image = await h.conversation.uploadAttachment(
		"c1",
		crypto.randomUUID(),
		(await syntheticImages())[1]!,
	);
	await h.store.write((db) => {
		h.conversation.appendInTransaction(db, {
			...h.message("c1", "hamster-input", "user", "", "vision-run"),
			attachments: [image],
		});
		h.conversation.appendInTransaction(
			db,
			h.message(
				"c1",
				"hamster-answer",
				"assistant",
				"ハムスターのオフィスで、看板はHUMSTER CORP.です。",
				"vision-run",
			),
		);
		h.conversation.recordImageAnswerInTransaction(
			db,
			"hamster-answer",
			{
				requestId: "image-request",
				attemptId: "image-attempt",
				inputs: [{ messageId: "hamster-input", attachmentIds: [image.id] }],
			},
			new Date().toISOString(),
		);
	});
	await waitFor(() => h.calls.select === 1);
	const data = JSON.parse(
		h.requests.find((r) => r.purpose === "select")!.prompt,
	);
	const answer = data.observations.find(
		(o: { id: string }) => o.id === "hamster-answer",
	);
	expect(answer.text).toContain("HUMSTER CORP.");
	expect(answer.text).toContain(
		"画像付きのモデル呼出しが正常終了し、この回答を会話へ採用済み",
	);
	expect(answer.text).toContain(image.id);
	expect(data.delivered).toContain(answer.text);
});
