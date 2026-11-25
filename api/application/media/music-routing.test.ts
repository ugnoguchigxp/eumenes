import { expect, test } from "bun:test";
import type { AgencyLayerPort } from "../../domains/dialogue/contracts";
import { musicFixture } from "./music.fixture";
import {
	candidatesOf,
	findToolchain,
	isUtteranceRound,
	UNAVAILABLE_TEXT,
	utteranceOf,
	type ConversationMessage,
	type Step,
} from "../toolchain/conversation-script.fixture";
import { answerUtterance } from "./conversation-turn.fixture";
import {
	assignmentAgenda,
	ended,
	executions,
	until,
	type Fixture,
} from "./assignment.fixture";
import {
	toolchainPassages,
	type VectorSpace,
} from "../../domains/capabilities";

const space: VectorSpace = {
	modelId: "fixture-embedding",
	revision: "r1",
	artifactDigest: "d1",
	dimension: 2,
};
let musicFunction = "";
const question = "日曜日の朝にぴったりな音楽を作って";

/** The model's path for a request: search for the toolchain, then hand the user's words to the agent as its assignment. */
const assignAfterSearch =
	(toolchain: string) =>
	(messages: ConversationMessage[]): Step => {
		// The assignment was accepted: the conversation tells it in words.
		if (
			messages.some((m) => m.role === "tool" && m.content.includes("delegated"))
		)
			return { text: "承知しました。" };
		const candidates = candidatesOf(messages);
		if (!candidates) return { calls: [findToolchain(utteranceOf(messages))] };
		const chosen = candidates.find((candidate) => candidate.id === toolchain);
		return chosen
			? {
					calls: [
						{
							name: "delegate",
							args: { toolchain: chosen.id, request: utteranceOf(messages) },
						},
					],
				}
			: { text: UNAVAILABLE_TEXT };
	};

test("the current music request reaches generation after unrelated Web and image history", async () => {
	const f = musicFixture("success");
	const embeddedQueries: string[] = [];
	let agenda: Fixture | undefined;
	// The conversation's runs are served by the agenda: the delegation is assigned to the agent.
	const agency = {
		assign: (input) => agenda!.host.dialoguePort.assign!(input),
		servesRepliesInTransaction: (db, conversationId) =>
			agenda!.host.dialoguePort.servesRepliesInTransaction!(db, conversationId),
	} as AgencyLayerPort;
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			// The utterance's generation offers the conversation's fixed tools; the toolchain is found by search, not offered.
			if (isUtteranceRound(args[2])) {
				const names = args[2]!.tools!.map((t) => t.function.name);
				expect(names).toContain("find_toolchain");
				expect(names).toContain("delegate");
				expect(names).not.toContain(musicFunction);
			}
			const turn = answerUtterance(
				args[2],
				args[0],
				args[2]?.onToolCalls,
				assignAfterSearch("music.create"),
			);
			return turn !== undefined ? turn : f.model.answer(...args);
		},
	};
	const a = await assignmentAgenda({
		harness: {
			model,
			agency,
			musicGateway: f.gateway,
			imageGateway: f.gateway,
			// The Web research toolchain the conversation can select (`web.note`) is registered; this run never uses it.
			webNote: {
				turn: async () => {
					throw new Error("web_note_unused");
				},
			},
			uiCompositions: true,
			timers: true,
			history: true,
			embed: async (texts) => {
				embeddedQueries.push(...texts);
				return { vectors: texts.map(() => [1, 0]), space };
			},
		},
	});
	agenda = a;
	const h = a.h;
	try {
		const active = h.store.read((db) =>
			h.toolchain.capabilities.toolchainsInTransaction(db),
		);
		musicFunction = active.find((d) => d.id === "music.create")!.functionName!;
		await h.store.write((db) => {
			h.toolchain.capabilities.saveToolchainVectorsInTransaction(
				db,
				space,
				active.flatMap((d) =>
					toolchainPassages(d).map((text, item) => ({
						revisionId: d.revisionId,
						text,
						item,
						vector: d.id === "music.create" ? [1, 0] : [0, 1],
					})),
				),
			);
			for (const id of ["web.note", "image.create"]) {
				const d = active.find((d) => d.id === id)!;
				h.toolchain.history.recordSelectionInTransaction(db, {
					runId: `previous-${id}`,
					conversationId: "ao",
					retrieval: "embedding",
					candidates: [],
					historyRefs: [],
					decision: "toolchain",
					toolchainId: id,
					toolchainRevisionId: d.revisionId,
					functionName: d.functionName,
					request: "前の調査と画像制作",
					query: { space, vector: [1, 0] },
				});
			}
		});
		await a.start();
		for (const [role, text] of [
			["user", "休日をイメージした画像を作って"],
			["assistant", "前の画像制作は失敗しました。"],
		] as const)
			await h.conversation.append({
				id: crypto.randomUUID(),
				runId: null,
				conversationId: "ao",
				role,
				text,
				createdAt: new Date().toISOString(),
			});
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "ao",
			text: question,
		});
		expect(response.ok).toBe(true);
		const { id } = await response.json();
		const run = await h.dialogue.waitForTerminal(id, { timeoutMs: 5000 });
		expect(run?.status).toBe("completed");
		// The music is the agent's assignment, started from the user's words: the run does not wait for it.
		await until(a, () => ended(a));
		expect(executions(a)).toHaveLength(1);
		expect(h.music!.list("ao")[0]?.state).toBe("completed");
		const selection = h.toolchain.history.getSelection(id)!;
		// The conversation's search found it by the embedding; the earlier Web and image choices do not lead it.
		expect(selection).toMatchObject({ retrieval: "embedding" });
		expect(selection.candidates.some((c) => c.fromHistory)).toBe(false);
		// Only the search's query is embedded for the record (the request), never the earlier requests.
		expect(embeddedQueries).toEqual([question]);
		expect(
			selection.candidates.find((c) => c.toolchainId === "music.create")!.rank,
		).toBe(1);
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		await a.close();
	}
});
