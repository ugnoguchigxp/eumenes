import { expect, test } from "bun:test";
import { Hono } from "hono";
import { watchRun } from "../../../../client/run-stream";
import { waitFor } from "../../../infrastructure/wait-for";
import { registerDialogue } from "../controller";
import type { RunProgress } from "../contracts";
import { setup } from "./generation.fixture";

for (const ending of ["completed", "cancelled", "failed"] as const) {
	test(`the public stream displays a live reply and ${ending} settles it without persisting a draft`, async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await setup({
			conversationAgent: {
				system: () => ({ base: "" }),
				async respond(input) {
					input.onDelta("まだ生成中の本文。");
					await held;
					if (ending === "failed") throw new Error("fixture_generation_failed");
					input.onDelta("完成した末尾。");
					return { text: "まだ生成中の本文。完成した末尾。", ended: false };
				},
			},
		});
		const app = new Hono();
		registerDialogue(app, h.dialogue);
		const controller = new AbortController();
		let watching: Promise<void> | undefined;
		try {
			const accepted = await app.request("/api/runs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "返事をお願いします。",
				}),
			});
			expect(accepted.status).toBe(202);
			const { id } = await accepted.json();
			const frames: RunProgress[] = [];
			const transport = {
				identity: "fixture",
				call: (path: string, init?: RequestInit) =>
					Promise.resolve(app.request(path, init)),
			};
			watching = watchRun(transport, id, controller.signal, (frame) =>
				frames.push(frame),
			);
			await waitFor(() =>
				frames.some((frame) => frame.text === "まだ生成中の本文。"),
			);
			expect(h.dialogue.get(id)?.status).toBe("running");
			expect(
				h.conversation
					.get("main")
					.messages.filter((m) => m.role === "assistant"),
			).toEqual([]);
			if (ending === "cancelled") {
				const result = await app.request(`/api/runs/${id}/cancel`, {
					method: "POST",
				});
				expect(result.ok).toBe(true);
			}
			release();
			await watching;
			expect(frames.at(-1)).toMatchObject({
				status: ending,
				provisional: null,
				text: ending === "completed" ? "まだ生成中の本文。完成した末尾。" : "",
			});
			expect(
				h.conversation
					.get("main")
					.messages.filter((m) => m.role === "assistant")
					.map((m) => m.text),
			).toEqual(
				ending === "completed" ? ["まだ生成中の本文。完成した末尾。"] : [],
			);
			const reconnected: RunProgress[] = [];
			await watchRun(transport, id, controller.signal, (frame) =>
				reconnected.push(frame),
			);
			expect(reconnected).toEqual([frames.at(-1)!]);
		} finally {
			release();
			controller.abort();
			await watching?.catch(() => {});
			await h.close();
		}
	});
}
