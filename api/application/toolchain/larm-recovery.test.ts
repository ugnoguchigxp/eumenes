import { expect, test } from "bun:test";
import {
	lifecycleFixture,
	makeLarm,
} from "../../domains/larm/test/larm.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "./toolchain.fixture";
import {
	CONVERSATION_WINDOW_TOKENS,
	withRespond,
} from "./conversation-script.fixture";

for (const cancel of [false, true])
	test(`public API replaces a gone LARM connection and ${cancel ? "rejects cancelled late output" : "completes the answer"}`, async () => {
		const fake = lifecycleFixture();
		let gone = false,
			generating = false;
		const gate = Promise.withResolvers<void>();
		const port = makeLarm(async (url, init) => {
			if (
				gone &&
				init?.method === "GET" &&
				String(url).endsWith("/connection1")
			)
				return new Response(null, { status: 410 });
			if (String(url).endsWith("chat/completions") && cancel) {
				generating = true;
				await gate.promise;
			}
			return fake.fetcher(url, init);
		});
		const h = await harness({
			model: withRespond({
				...port,
				llmContextWindow: () => CONVERSATION_WINDOW_TOKENS,
			}),
		});
		try {
			expect((await h.request("/api/larm/connect", {})).status).toBe(200);
			gone = true;
			expect((await h.request("/api/larm/connect", {})).status).toBe(200);
			expect(fake.generation()).toBe(2);
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "こんにちは",
			});
			expect(response.status).toBe(202);
			const run = (await response.json()) as { id: string };
			if (cancel) {
				await waitFor(() => generating);
				expect((await h.request(`/api/runs/${run.id}/cancel`, {})).status).toBe(
					200,
				);
				gate.resolve();
			}
			await waitFor(() =>
				["completed", "cancelled", "failed"].includes(
					h.dialogue.get(run.id)?.status ?? "",
				),
			);
			expect(h.dialogue.get(run.id)?.status).toBe(
				cancel ? "cancelled" : "completed",
			);
			if (cancel) expect(h.dialogue.answerText(run.id)).toBeNull();
			else expect(h.dialogue.answerText(run.id)).toBe("承知しました");
		} finally {
			gate.resolve();
			await h.close();
			await port.close();
		}
	});
