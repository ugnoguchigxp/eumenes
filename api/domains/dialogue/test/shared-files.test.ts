import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { SharedFilesPort } from "../contracts/resources";
import { INSTANT, choice, setup, type Harness } from "./generation.fixture";
import { fakeResources } from "./resource.fixture";

/**
 * The user's input as shared files and the conversation's recent ones (spec/server-scratch-cache-design-2026-11-07.md
 * §6.1・§8.1): `attached` in the ledger, linked to the input's message, `提示中` for the input and `共有中` after.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

function shared(resources: ReturnType<typeof fakeResources>) {
	const recent: string[] = [];
	const next: string[] = [];
	const port: SharedFilesPort = {
		async inputUris() {
			const uris = next.splice(0);
			recent.unshift(...uris);
			return uris;
		},
		recentUris: (_conversationId, limit) => recent.slice(0, limit),
	};
	return {
		port,
		/** The next input's shared file. */
		attach(id: string, label: string, note: string) {
			const uri = resources.make("scratch", id, label, undefined, label, note);
			next.push(uri);
			return uri;
		},
		/** A file made elsewhere (a sub-agent's write) that is recent but was never numbered. */
		unnumbered(id: string, label: string) {
			recent.unshift(resources.make("scratch", id, label, undefined, label, "x"));
		},
	};
}

const stateOf = (index = -1) => {
	const last = h!.state.calls
		.filter((call) => call.session?.outputSchema)
		.at(index)!
		.messages.at(-1)!.content;
	const start = last.indexOf("## State\n") + "## State\n".length;
	const end = last.indexOf("\n\n", start);
	return last.slice(start, end < 0 ? undefined : end);
};
async function say(text: string) {
	h!.state.steps.push(choice({ choice: INSTANT.id, inputs: { city: "東京" } }));
	const run = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
	});
	await waitFor(() => h!.dialogue.get(run.id)?.status === "completed");
	return run;
}

test("an input's shared file is numbered, linked to its message and presented; the next turn lists it as shared", async () => {
	const resources = fakeResources();
	const files = shared(resources);
	h = await setup({ resources: resources.access, sharedFiles: files.port });
	const uri = files.attach("img-1", "IMG_2041.jpg", "利用者が添付、画像 1600×1200");
	const run = await say("これを見て");
	expect(stateOf()).toContain(
		"提示中:\n- a1「IMG_2041.jpg」（利用者が添付、画像 1600×1200）",
	);
	expect(stateOf()).not.toContain("共有中:");
	const response = h.dialogue.conversationResources("main");
	expect(response.resources.map((r) => [r.ref, r.uri])).toEqual([["a1", uri]]);
	expect(response.messages).toEqual([
		{ messageId: h.dialogue.get(run.id)!.inputMessageId!, uris: [uri] },
	]);
	expect(
		h.store.read(
			(db) =>
				db.query("SELECT source FROM dialogue_resources WHERE uri=?").get(uri) as {
					source: string;
				},
		).source,
	).toBe("attached");

	files.unnumbered("draft-1", "下書き.md");
	await say("さっきのはどう？");
	const state = stateOf();
	expect(state).not.toContain("提示中:\n- a1");
	expect(state).toContain(
		"共有中:\n- a1「IMG_2041.jpg」（利用者が添付、画像 1600×1200）",
	);
	// A recent file without a number is not offered: nothing could name it.
	expect(state).not.toContain("下書き.md");
});

test("a shared file that is gone is neither presented nor listed", async () => {
	const resources = fakeResources();
	const files = shared(resources);
	h = await setup({ resources: resources.access, sharedFiles: files.port });
	files.attach("img-1", "IMG_2041.jpg", "利用者が添付、画像 1600×1200");
	await say("これを見て");
	resources.remove("img-1");
	await say("まだある？");
	expect(stateOf()).not.toContain("IMG_2041.jpg");
});

test("a store that cannot take the input leaves the input accepted without numbers", async () => {
	const resources = fakeResources();
	h = await setup({
		resources: resources.access,
		sharedFiles: {
			inputUris: async () => {
				throw new Error("scratch_capacity");
			},
			recentUris: () => [],
		},
	});
	const run = await say("長い文章");
	expect(h.dialogue.get(run.id)?.status).toBe("completed");
	expect(h.dialogue.conversationResources("main").resources).toEqual([]);
});
