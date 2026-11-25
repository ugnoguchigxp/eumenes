import { expect, test } from "bun:test";
import { workerPacket } from "./toolchain.fixture";
import { assignmentFixture } from "./assignment.fixture";

const REQUEST = "先月話した京都旅行の行き先を会話履歴から調べて";
const DESTINATION = "東福寺";

const researchOptions = {
	history: true,
	control(messages: Parameters<typeof workerPacket>[0]) {
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
};

test("research is the agent's assignment: the worker runs without any announcement and the agent reports the finished research", async () => {
	const f = await assignmentFixture(researchOptions);
	const { h } = f;
	try {
		await h.conversation.append({
			id: crypto.randomUUID(),
			conversationId: f.conversationId,
			role: "user",
			text: `京都旅行の行き先は${DESTINATION}に決めました。`,
			createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			runId: null,
		});
		const { source } = await f.assign(REQUEST, "history.research");
		// The user's run carries no announcement of a hand-over.
		const final = await (await h.request(`/api/runs/${source.runId}`)).json();
		expect(final.announcement ?? null).toBeNull();
		await f.settled();
		expect(f.executions()).toMatchObject([{ status: "completed" }]);
		expect(f.reported()).toContain(DESTINATION);
		expect(h.workerContexts.length).toBeGreaterThan(0);
		// The agent reports the research as a note; the assignment is no longer open.
		await f.until(() => f.notes().length === 1);
		expect(f.items()).toHaveLength(0);
	} finally {
		await f.close();
	}
});
