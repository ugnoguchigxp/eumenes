import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { setup, type Harness } from "./generation.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a conversation has an active run from acceptance until the run ends, and only that conversation", async () => {
	h = await setup({ autoStart: false });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "お答えします。" });
	const active = (conversationId: string) =>
		h!.store.read((db) =>
			h!.dialogue.conversationHasActiveRunInTransaction(db, conversationId),
		);
	expect(active("main")).toBe(false);
	const accepted = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "こんにちは",
	});
	expect(active("main")).toBe(true);
	expect(active("other")).toBe(false);
	h.start();
	// The generation is in flight (held at the model call): the run is still active.
	await waitFor(() => h!.dialogue.get(accepted.id)?.status === "running");
	expect(active("main")).toBe(true);
	release();
	await waitFor(() => h!.dialogue.get(accepted.id)?.status === "completed");
	expect(active("main")).toBe(false);
});
