import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";

const NOTICE = "「会話履歴の調査」に頼みます。";
const REQUEST = "先月話した京都旅行の行き先を会話履歴から調べて";
const DESTINATION = "東福寺";

async function researchHarness(
	options: { voiceText?: string; speechFailure?: boolean } = {},
) {
	const h = await harness({
		...options,
		history: true,
		control(messages) {
			const data = workerPacket(messages);
			if (!data.operations.length)
				return JSON.stringify({
					action: "invoke",
					tool: "history.search",
					arguments: { query: "京都旅行", limit: 5 },
				});
			const excerpt = data.observations
				.flatMap(
					(observation: {
						excerpts: Array<{ quote: string; reference: string }>;
					}) => observation.excerpts,
				)
				.find(({ quote }: { quote: string }) => quote.includes(DESTINATION));
			expect(excerpt).toBeDefined();
			return JSON.stringify({
				action: "finish",
				report: {
					outcome: "answered",
					summary: `京都旅行の行き先は${DESTINATION}です。`,
					claims: [{ text: excerpt.quote, evidence: [excerpt.reference] }],
					limitations: [],
				},
			});
		},
	});
	await h.conversation.append({
		id: crypto.randomUUID(),
		conversationId: "main",
		role: "user",
		text: `京都旅行の行き先は${DESTINATION}に決めました。`,
		createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
		runId: null,
	});
	return h;
}

test("research announces before the worker, retains the notice over API reads, then finishes without a reply of its own", async () => {
	const h = await researchHarness();
	let stop = () => {};
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: REQUEST,
		});
		const observations: number[] = [];
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement) observations.push(h.workerContexts.length);
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(observations[0]).toBe(0);
		const final = await (await h.request(`/api/runs/${run.id}`)).json();
		expect(final.announcement).toBe(NOTICE);
		// The agency reports the finished research; the run has no reply.
		expect(h.dialogue.answerText(run.id)).toBeNull();
		expect(h.reported()).toContain(DESTINATION);
		expect(
			h.conversation.get("main").messages.map((message) => message.role),
		).toEqual(["user", "user"]);
		expect(h.workerContexts.length).toBeGreaterThan(0);
	} finally {
		stop();
		await h.close();
	}
});

test("voice waits for playback of the host's notice before executing the conversation's delegation", async () => {
	const h = await researchHarness({ voiceText: REQUEST });
	try {
		const session = crypto.randomUUID(),
			utterance = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, utterance, wav);
		await waitFor(() => h.voice.get(utterance)?.status === "input_ready", {
			timeout: 1000,
		}).catch(() => {
			throw new Error(`input stage: ${JSON.stringify(h.voice.get(utterance))}`);
		});
		await h.voice.commit(utterance, h.voice.get(utterance)!.revision);
		await waitFor(() => !!h.voice.get(utterance)?.audioChunks?.length);
		expect(h.workerContexts).toHaveLength(0);
		expect(h.voice.get(utterance)?.audioChunks?.[0]?.text).toBe(NOTICE);
		await h.voice.played(
			utterance,
			h.voice.get(utterance)!.audioChunks![0]!.index,
		);
		await waitFor(
			() =>
				["played", "completed", "failed"].includes(
					h.voice.get(utterance)?.status ?? "",
				),
			{ timeout: 2000 },
		).catch(() => {
			throw new Error(
				`speech stage: ${JSON.stringify({ turn: h.voice.get(utterance), spoken: h.spoken })}`,
			);
		});
		const turn = h.voice.get(utterance)!;
		expect(turn.status).toBe("played");
		// The notice is the only speech of the turn; the finished research is the agency's to report.
		expect(h.spoken).toEqual([NOTICE]);
		expect(h.dialogue.answerText(turn.runId!)).toBeNull();
		expect(h.reported()).toContain(DESTINATION);
	} finally {
		await h.close();
	}
});

test("cancelling during the spoken notice never starts the research worker", async () => {
	const h = await researchHarness({ voiceText: REQUEST });
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wav);
		await waitFor(() => h.voice.get(id)?.status === "input_ready");
		await h.voice.commit(id, h.voice.get(id)!.revision);
		await waitFor(() => !!h.voice.get(id)?.audioChunks?.length);
		expect(h.workerContexts).toHaveLength(0);
		await h.voice.cancel(id);
		const runId = h.voice.get(id)!.runId!;
		expect((await h.dialogue.waitForTerminal(runId))?.status).toBe("cancelled");
		expect(h.workerContexts).toHaveLength(0);
		expect(h.reported()).toBe("");
	} finally {
		await h.close();
	}
});

test("an unspoken notice cannot authorize the research worker", async () => {
	const h = await researchHarness({
		voiceText: REQUEST,
		speechFailure: true,
	});
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wav);
		await waitFor(() => h.voice.get(id)?.status === "input_ready");
		await h.voice.commit(id, h.voice.get(id)!.revision);
		await waitFor(() => h.voice.get(id)?.status === "failed");
		expect(h.workerContexts).toHaveLength(0);
		expect(h.reported()).toBe("");
		expect(h.voice.get(id)?.audioChunks).toEqual([]);
	} finally {
		await h.close();
	}
});
