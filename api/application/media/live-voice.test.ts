import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	agencyOf,
	setup,
	INSTANT,
	IMAGE,
	type Harness,
} from "../../domains/dialogue/test/generation.fixture";
import { createSettings, type Settings } from "../../domains/settings";
import { migrations } from "../../domains/live-voice";
import type { LiveSocket } from "../../domains/live-voice/contracts";
import { Peer, until } from "../../domains/live-voice/test/live.fixture";
import { buildLiveVoice } from "./live-voice";
import type { ExternalOutputPort } from "../../domains/dialogue/contracts/external-output";
import { conversationPersona } from "../../domains/dialogue";
import type { AgencyLayerPort } from "../../domains/dialogue/contracts";

let h: Harness | undefined;
let built: ReturnType<typeof buildLiveVoice> | undefined;
afterEach(async () => {
	await built?.live.close();
	await h?.close();
	built = undefined;
	h = undefined;
});
async function fixture(
	persona: Settings["general"]["persona"] = "maid",
	agency?: AgencyLayerPort,
) {
	const sink: ExternalOutputPort = {
		active: (tx, id) => built?.externalOutput.active(tx, id) ?? false,
		reattach: (tx, id, conv, input) =>
			built?.externalOutput.reattach(tx, id, conv, input),
		owns: (tx, id) => built?.externalOutput.owns(tx, id) ?? false,
		assertCurrent: (tx, id) => built?.externalOutput.assertCurrent(tx, id),
		offer: (tx, run, text) =>
			built?.externalOutput.offer(tx, run, text) ?? false,
		announce: (run, text, signal) =>
			built!.externalOutput.announce(run, text, signal),
	};
	h = await setup({
		extraMigrations: [...migrations],
		externalOutput: sink,
		...(agency ? { agency } : {}),
	});
	const settings = await createSettings(h.store, {
		dbPath: join(h.dir, "db.sqlite3"),
		env: {},
	});
	const doc = settings.get();
	doc.general.agentName = "光";
	doc.general.userName = "ご主人さま";
	doc.general.persona = persona;
	const connectionId = crypto.randomUUID();
	doc.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	doc.live = {
		enabled: true,
		cloudAllowed: true,
		connectionId,
		model: "fixture-voice",
		voice: "",
		startWithMicrophone: true,
		instructions: "",
	};
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: doc.revision,
		settings: doc,
		keys: [{ connectionId, value: "fixture-secret" }],
	});
	const peer = new Peer();
	built = buildLiveVoice({
		store: h.store,
		settings,
		conversation: h.conversation,
		dialogue: h.dialogue,
		stopLegacy: async () => {},
		wake: () => h!.queue.wake(),
		connect: () => peer as unknown as LiveSocket,
	});
	const state = await built.live.start({
		requestId: crypto.randomUUID(),
		conversationId: "main",
	});
	built.live.attach(state.id, (event) => {
		if (event.type === "state")
			for (const n of event.state.notices)
				if (n.kind === "announcement" && !n.displayed)
					void built!.displayed(state.id, n.id);
	});
	peer.open();
	peer.event({ type: "session.started" });
	await until(() => built!.live.state(state.id)?.status === "active");
	return { peer, id: state.id, settings };
}
test.each(["maid", "butler", "strategist", "sage"] as const)(
	"Live retains the normal conversation identity and %s role and style independently of its voice",
	async (persona) => {
		const { peer, settings } = await fixture(persona);
		const own = conversationPersona(settings.get().general);
		const start = peer.sent[0] as {
			session: { instructions: string; audio: { output?: unknown } };
		};
		expect(start.session.instructions).toContain(own.role);
		expect(start.session.instructions).toContain(own.style);
		expect(start.session.instructions).toContain("光");
		expect(start.session.instructions).toContain("ご主人さま");
		expect(start.session.audio.output).toBeUndefined();
	},
);
test("Live transcript delegates through the conversation tools and returns only its actual spoken transcript to chat", async () => {
	const { peer, id } = await fixture();
	h!.state.steps.push({
		text: JSON.stringify({ choice: INSTANT.id, inputs: { city: "東京" } }),
	});
	peer.event({
		type: "session.input_transcript.delta",
		delta: "東京の時刻は？",
		start_ms: 0,
		end_ms: 100,
	});
	peer.event({ type: "session.delegation.created", delegation: { id: "d1" } });
	await until(() =>
		peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	// The conversation chooses to search, selects the tool, fills its inputs, and receives the instant result.
	expect(h!.state.calls).toHaveLength(4);
	expect(h!.state.calls[0]!.tools).toContain("find_toolchain");
	expect(h!.state.calls[1]!.tools).toContain("delegate");
	expect(h!.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"東京の時刻は？",
	]);
	expect(
		peer.sent.find((e) => e.type === "session.commentary.append"),
	).toMatchObject({ delegation_id: "d1", content: "東京は12時です。" });
	peer.event({
		type: "session.output_transcript.delta",
		delta: "東京では、いま12時です。",
		start_ms: 200,
		end_ms: 800,
	});
	peer.event({ type: "session.closed", usage: { duration: 1 } });
	await until(() => built!.live.state(id)?.status === "closed");
	expect(h!.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"東京の時刻は？",
		"東京では、いま12時です。",
	]);
});
test("a typed request during Live uses the same tools and external output without adopting a second assistant message", async () => {
	const { peer } = await fixture();
	h!.state.steps.push({
		text: JSON.stringify({ choice: INSTANT.id, inputs: { city: "横浜" } }),
	});
	const run = await h!.say("横浜の時刻は？");
	expect(run.status).toBe("completed");
	expect(h!.dialogue.answerText(run.id)).toBeNull();
	await until(() =>
		peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	expect(
		h!.conversation.get("main").messages.filter((m) => m.role === "assistant"),
	).toHaveLength(0);
});
test("a delegation in a Live conversation is the agent's assignment: nothing is announced, no legacy TTS, and the run's own reply is empty", async () => {
	const { agency, assigned } = agencyOf();
	const { peer } = await fixture("maid", agency);
	let legacyCalls = 0;
	h!.dialogue.setAnnouncementDelivery(async () => {
		legacyCalls++;
		throw new Error("legacy_tts_forbidden");
	});
	h!.state.steps.push({
		text: JSON.stringify({
			choice: IMAGE.id,
			say: "描きますね。",
			request: "青い花を描いて",
		}),
	});
	const run = await h!.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "青い花を描いて",
	});
	await h!.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
	// The agent holds the work, as the user's words; the voice session was told nothing of its own.
	expect(assigned).toMatchObject([
		{
			toolchainId: IMAGE.id,
			request: "青い花を描いて",
			source: { runId: run.id, request: "青い花を描いて" },
		},
	]);
	expect(legacyCalls).toBe(0);
	expect(h!.dialogue.get(run.id)?.announcement).toBeNull();
	expect(h!.dialogue.answerText(run.id)).toBeNull();
	expect(peer.sent.some((e) => e.type === "session.commentary.append")).toBe(
		false,
	);
	expect(peer.sent[0]).toMatchObject({ type: "session.start" });
});

test("a typed supplement is sent to Live and its repeated delegation reuses the same backend run", async () => {
	const { peer } = await fixture();
	h!.state.steps.push({
		text: JSON.stringify({ choice: INSTANT.id, inputs: { city: "京都" } }),
	});
	await h!.say("京都の時刻は？");
	expect(h!.state.calls).toHaveLength(4);
	await until(() =>
		peer.sent.some((e) => e.type === "session.thinking.append"),
	);
	expect(
		peer.sent.find((e) => e.type === "session.thinking.append")?.content,
	).toContain("京都の時刻は？");
	peer.event({
		type: "session.delegation.created",
		delegation: { id: "typed-duplicate" },
	});
	await Bun.sleep(450);
	expect(h!.state.calls).toHaveLength(4);
});
test("forgetting a seeded text message interrupts Live and does not let it republish that message", async () => {
	const { id } = await fixture();
	const messageId = crypto.randomUUID();
	await h!.store.write((tx) =>
		h!.conversation.appendInTransaction(tx, {
			id: messageId,
			conversationId: "main",
			role: "user",
			text: "削除する補足",
			createdAt: new Date().toISOString(),
			runId: null,
		}),
	);
	await h!.conversation.retract({ messageId });
	await until(() => built!.live.state(id)?.status === "interrupted");
	expect(h!.conversation.get("main").messages.map((m) => m.text)).not.toContain(
		"削除する補足",
	);
});
