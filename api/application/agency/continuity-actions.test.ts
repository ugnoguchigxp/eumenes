import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { imageFixture } from "../media/image.fixture";
import { actionHost } from "./action-host.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";

test("native recall starts creation after the speech cap and returns a real resource once", async () => {
	const media = imageFixture("success");
	const h = await harness({
		everyday: true,
		resources: true,
		memory: true,
		model: media.model,
		imageGateway: media.gateway,
		discoveryTarget: () => "image",
	});
	const a = actionHost(
		h,
		{ id: "image.create", question: "散歩の静かな雰囲気を一枚の絵にする" },
		{
			speakFirst: true,
			discover: true,
			afterRecall: true,
			inputTokens: 13_000,
		},
	);
	try {
		await a.start();
		await waitFor(() => a.host.inspect("agency-action")?.idle.unanswered === 1);
		await settle();
		await waitFor(() => !a.host.status("agency-action").busy);
		expect(a.rows()).toHaveLength(0);
		// The first review settles the preceding speech receipt; the next admits recall.
		await a.advance(121_000);
		await waitFor(() =>
			a.host
				.inspect("agency-action")!
				.snapshot.observations.some((o) => o.kind === "recall.offered"),
		);
		await waitFor(() =>
			a.host
				.inspect("agency-action")!
				.snapshot.observations.some((o) => o.kind === "action.observed"),
		);
		await waitFor(() => !a.host.status("agency-action").busy);
		await a.advance(61_000);
		await a.returned();
		expect(h.toolchain.agents.executions.list("agency-action")[0]?.status).toBe(
			"completed",
		);
		expect(
			JSON.stringify(h.dialogue.conversationResources("agency-action")),
		).toContain('"image"');
		expect(a.host.inspect("agency-action")?.idle.unanswered).toBe(1);
		await a.restart();
		await a.advance(121_000);
		expect(a.rows()).toHaveLength(1);
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);
