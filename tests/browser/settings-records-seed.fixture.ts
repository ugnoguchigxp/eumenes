// Isolated browser fixture only: seed through the owning domain before the API owns the writer.
import { openStore } from "../../api/infrastructure/sqlite";
import { migrations, legacyOrder } from "../../api/application/migrations";
import { createToolchainHistory } from "../../api/domains/toolchain-history";
import { seedUsageFixture } from "../../api/domains/inference/test/usage.fixture";

const store = openStore(process.argv[2]!, migrations, { legacyOrder });
let offset = 0;
const history = createToolchainHistory(
	store,
	() => Date.now() - offset++ * 1000,
);
await store.write((db) => {
	for (let i = 0; i < 55; i++) {
		const runId = `fixture-run-${i}`;
		history.recordSelectionInTransaction(db, {
			runId,
			conversationId: "fixture",
			retrieval: "hybrid",
			decision: "toolchain",
			toolchainId: "web.search",
			toolchainRevisionId: "toolchain:web.search@1",
			functionName: `fixture_search_${String(i).padStart(3, "0")}`,
			request: `固定試験の依頼 ${i}`,
			historyRefs: ["past"],
			candidates: [
				{
					toolchainId: "web.search",
					revisionId: "toolchain:web.search@1",
					functionName: "web_search",
					rank: 1,
					ftsRank: 0.1,
					similarity: 0.8,
					fromHistory: true,
				},
			],
		});
		history.settleSelectionInTransaction(db, runId, { outcome: "answered" });
	}
	history.saveRecipeInTransaction(db, "web.search", {
		signature: "試験の取得手順",
		url: "https://example.com/weather",
		readHint: "天気の本文",
	});
	const suspended = history.saveRecipeInTransaction(db, "web.search", {
		signature: "停止中の取得手順",
		url: "https://example.com/other",
		readHint: "本文",
	});
	for (let i = 0; i < 3; i++)
		history.recordRecipeResultInTransaction(db, suspended, false);
	for (let i = 0; i < 25; i++)
		history.saveRecipeInTransaction(db, "web.search", {
			signature: `保存手順-${String(i).padStart(2, "0")}`,
			url: `https://example.com/page/${i}`,
			readHint: "試験の本文",
		});
});
await seedUsageFixture(store);
await store.close();
