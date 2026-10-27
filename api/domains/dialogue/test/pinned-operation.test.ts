import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ToolchainCard } from "../../capabilities";
import {
	IMAGE,
	MUSIC,
	RESEARCH,
	setup,
	type Harness,
} from "./generation.fixture";

/** A screen's form submit: the body names the toolchain, the run hands over with no model call. */
const request = '夕焼けの海を描いて\n\n{"width":512}';

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const playback: ToolchainCard = {
	...RESEARCH,
	revisionId: "toolchain:fake.play@1",
	id: "fake.play",
	functionName: "fake_play",
	execution: "music-playback",
};

test("a run pinned to image.create hands its submit body to the toolchain: a TODO, no model call, no answer text", async () => {
	h = await setup({ cards: [IMAGE] });
	const run = await h.say(request, "queued", {
		toolchainId: IMAGE.id,
		presentation: "artifact",
	});
	expect(h.state.calls).toHaveLength(0);
	expect(run.answerMessageId).toBeNull();
	const [todo] = h.todos();
	expect(todo).toMatchObject({
		status: "todo",
		title: expect.stringContaining("夕焼けの海を描いて"),
	});
	const delegated = h
		.log()
		.find((event) => h!.fields(event).action === "delegate");
	expect(h.fields(delegated!)).toMatchObject({
		action: "delegate",
		toolchain: IMAGE.id,
		request,
		todo: todo!.id,
	});
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		retrieval: "none",
		toolchainId: IMAGE.id,
		toolchainRevisionId: IMAGE.revisionId,
		request,
	});
});

test("a run pinned to music.create hands over the same way when the music port is offered", async () => {
	h = await setup({ cards: [MUSIC], music: true });
	await h.say(request, "queued", {
		toolchainId: MUSIC.id,
		presentation: "artifact",
	});
	expect(h.state.calls).toHaveLength(0);
	expect(h.todos()).toMatchObject([{ status: "todo" }]);
});

const command: ToolchainCard = {
	...RESEARCH,
	revisionId: "toolchain:fake.operate@1",
	id: "fake.operate",
	functionName: "fake_operate",
	execution: "command",
};

test("a run pinned to a command toolchain (the CLI's --toolchain) hands its body to the command sub-agent", async () => {
	h = await setup({ cards: [command] });
	await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "このタブで商品名を検索して",
		toolchainId: command.id,
		presentation: "artifact",
	});
	// The command job runs next; this fixture has no command set, so only the hand-over is checked.
	await waitFor(() => h!.state.selections.length > 0);
	expect(h.state.calls).toHaveLength(0);
	expect(h.todos()).toMatchObject([
		{ title: "このタブで商品名を検索して", toolchainId: command.id },
	]);
	expect(h.state.selections.at(-1)).toMatchObject({
		decision: "toolchain",
		toolchainId: command.id,
		request: "このタブで商品名を検索して",
	});
});

const unavailable: Array<
	[
		string,
		() => {
			cards: ToolchainCard[];
			music?: boolean;
			unbuildable?: string[];
			toolchainId: string;
		},
	]
> = [
	[
		"a toolchain that is not offered on this host (no music port)",
		() => ({ cards: [MUSIC], toolchainId: MUSIC.id }),
	],
	[
		"a toolchain with no active revision (not in the catalog)",
		() => ({ cards: [MUSIC], music: true, toolchainId: IMAGE.id }),
	],
	[
		"a toolchain whose card cannot be rebuilt",
		() => ({
			cards: [IMAGE],
			unbuildable: [IMAGE.revisionId],
			toolchainId: IMAGE.id,
		}),
	],
	[
		"a research toolchain",
		() => ({ cards: [RESEARCH], toolchainId: RESEARCH.id }),
	],
	[
		"a music playback toolchain",
		() => ({ cards: [playback], toolchainId: playback.id }),
	],
];

for (const [name, make] of unavailable)
	test(`${name} fails the pinned run with toolchain_unavailable and no fallback`, async () => {
		const { toolchainId, ...options } = make();
		h = await setup(options);
		const run = await h.say(request, "failed", {
			toolchainId,
			presentation: "artifact",
		});
		expect(run.error).toBe("toolchain_unavailable");
		expect(h.state.calls).toHaveLength(0);
		expect(h.todos()).toEqual([]);
	});
