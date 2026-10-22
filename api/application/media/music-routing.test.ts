import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { musicFixture } from "./music.fixture";
import {
	isAnalysisRound,
	isCompletionCheck,
} from "../../domains/dialogue/test/analysis.fixture";
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
const question = "日曜日の朝にぴったりな音楽を作って";

test("the current music request reaches generation after unrelated Web and image history", async () => {
	const f = musicFixture("success", { question });
	let offered: string[] = [];
	const embeddedQueries: string[] = [];
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			// The handover round offers the chosen function; the analysis and the completion check are not selections.
			if (
				args[2]?.tools?.length &&
				!isAnalysisRound(args[2].tools) &&
				!isCompletionCheck(args[2].tools)
			) {
				offered = args[2].tools.map((t) => t.function.name);
				expect(offered).toContain("music");
				expect(offered[0]).toBe("music");
			}
			return f.model.answer(...args);
		},
	};
	const h = await harness({
		model,
		musicGateway: f.gateway,
		imageGateway: f.gateway,
		uiCompositions: true,
		timers: true,
		history: true,
		embed: async (texts) => {
			embeddedQueries.push(...texts);
			return { vectors: texts.map(() => [1, 0]), space };
		},
	});
	try {
		const active = h.store.read((db) =>
			h.toolchain.capabilities.toolchainsInTransaction(db),
		);
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
			for (const id of ["web.search", "image.create"]) {
				const d = active.find((d) => d.id === id)!;
				h.toolchain.history.recordSelectionInTransaction(db, {
					runId: `previous-${id}`,
					conversationId: "main",
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
		for (const [role, text] of [
			["user", "休日をイメージした画像を作って"],
			["assistant", "前の画像制作は失敗しました。"],
		] as const)
			await h.conversation.append({
				id: crypto.randomUUID(),
				runId: null,
				conversationId: "main",
				role,
				text,
				createdAt: new Date().toISOString(),
			});
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: question,
		});
		expect(response.ok).toBe(true);
		const { id } = await response.json();
		const run = await h.dialogue.waitForTerminal(id, { timeoutMs: 5000 });
		expect(run?.status).toBe("completed");
		expect(h.music!.list("main")[0]?.state).toBe("completed");
		const selection = h.toolchain.history.getSelection(id)!;
		expect(selection).toMatchObject({
			retrieval: "embedding",
			toolchainId: "music.create",
		});
		expect(selection.historyRefs.length).toBeGreaterThan(0);
		// Only the first round's search query is embedded (the fixture's), never the earlier requests.
		expect(embeddedQueries).toEqual(["今回の依頼を実行する担当"]);
		expect(
			selection.candidates.find((c) => c.toolchainId === "music.create")!.rank,
		).toBe(1);
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		await h.close();
	}
});
