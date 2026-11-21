/** Live embeddings with an isolated Eumenes catalog and the normal conversation search. */
import { createLarmPlayground } from "../api/domains/larm";
import {
	candidatesOf,
	findToolchain,
} from "../api/application/toolchain/conversation-script.fixture";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import type { HarnessOptions } from "../api/application/toolchain/toolchain-harness-options.fixture";
import { stockFetch } from "../api/application/stock/stock.fixture";
import { weatherFetch } from "../api/application/weather/weather.fixture";
import { environment } from "../api/domains/compute/test/compute.fixture";
import { drawingFixture } from "../api/domains/excalidraw/test/connection.fixture";
import { createGitObservation } from "../api/domains/git-observation";
import { waitFor } from "../api/infrastructure/wait-for";
import { configureLogging } from "../api/infrastructure/logger";
import { vectorSpaceKey } from "../api/infrastructure/vector";
import { createLiveLarm } from "./live-larm";
import {
	diverseCases,
	smokeCases,
	type EmbeddingSearchCase,
} from "./toolchain-embedding-cases.fixture";

function diverseFixtures(): HarnessOptions {
	function unexpectedOperation(): never {
		throw new Error("unexpected_operation_in_embedding_search");
	}
	const unexpectedFetch: typeof fetch = Object.assign(unexpectedOperation, {
		preconnect: unexpectedOperation,
	});
	return {
		memory: true,
		pipelines: true,
		webResearch: true,
		webNote: { turn: unexpectedOperation },
		stock: { fetch: stockFetch().fetch },
		ocrFetcher: unexpectedFetch,
		recognitionFetcher: unexpectedFetch,
		drawingConnection: drawingFixture().connection,
		drawingFetch: unexpectedFetch,
		computePort: {
			binding: "fixture",
			discover: async () => ({
				url: "http://compute.test/v1/compute",
				description: "CPU",
				environment,
			}),
			submit: unexpectedOperation,
			get: unexpectedOperation,
			cancel: unexpectedOperation,
			delete: unexpectedOperation,
			artifact: unexpectedOperation,
		},
		appDevelopment: {
			git: createGitObservation("/unused", {
				list: unexpectedOperation,
				remote: unexpectedOperation,
			}),
		},
		markdown: {
			available: () => true,
			binding: () => "fixture",
			capabilities: unexpectedOperation,
			list: unexpectedOperation,
			read: unexpectedOperation,
			save: unexpectedOperation,
		},
	};
}

if (!process.argv.includes("--live"))
	throw new Error(
		"usage: bun scripts/toolchain-embedding-live.ts --live [--diverse]",
	);
const diverse = process.argv.includes("--diverse");
const cases: readonly EmbeddingSearchCase[] = diverse
	? [...smokeCases, ...diverseCases]
	: smokeCases;

configureLogging({ level: "silent" });
const larm = createLiveLarm();
const gateway = createLarmPlayground({ audience: "same-host" });
let host: Awaited<ReturnType<typeof harness>> | undefined;
let passages = 0;
try {
	host = await harness({
		...(diverse ? diverseFixtures() : {}),
		liveRouting: true,
		embed: (texts, type, signal) => {
			if (
				type === "passage" &&
				!(texts.length === 1 && texts[0] === "toolchain")
			)
				passages += texts.length;
			return larm.embed!(texts, type, signal);
		},
		timers: true,
		schedules: true,
		history: true,
		musicGateway: () => gateway,
		imageGateway: () => gateway,
		weather: {
			fetch: weatherFetch().fetch,
		},
		firstRound(_tools, question, messages) {
			return candidatesOf(messages)
				? { text: "担当の候補を確認しました。" }
				: { calls: [findToolchain(question)] };
		},
	});
	const app = host;
	await app.toolchain.weather?.maintain();
	await app.toolchain.stock?.maintain();
	if (app.memory && !app.memory.status().enabled)
		await app.memory.setEnabled(true);
	const space = await app.toolchain.refreshVectors();
	if (!space?.embeddingSpace || passages === 0)
		throw new Error("live_embedding_index_unavailable");
	const pending = app.store.read((db) =>
		app.toolchain.capabilities.pendingToolchainVectorsInTransaction(db, space),
	);
	if (pending.length) throw new Error("live_embedding_index_incomplete");
	console.log(
		JSON.stringify({ indexedPassages: passages, dimension: space.dimension }),
	);

	const routeInTransaction = app.routing.routeInTransaction;
	const searches = new Map<string, Parameters<typeof routeInTransaction>[1]>();
	app.routing.routeInTransaction = (db, input) => {
		searches.set(input.runId, input);
		return routeInTransaction(db, input);
	};
	const availableTools = new Set<string>();
	let passed = 0;
	let offered = 0;
	let first = 0;
	let embeddingRuns = 0;
	for (const [caseId, situation, expected, text] of cases) {
		const response = await app.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: crypto.randomUUID(),
			text,
		});
		if (response.status !== 202)
			throw new Error(`live_search_http_${response.status}`);
		const { id } = (await response.json()) as { id: string };
		await waitFor(
			() =>
				["completed", "failed", "cancelled"].includes(
					app.dialogue.get(id)?.status ?? "",
				),
			{ timeout: 15_000 },
		);
		const record = app.toolchain.history.getSelection(id);
		const search = searches.get(id);
		searches.delete(id);
		for (const tool of search?.available ?? []) availableTools.add(tool);
		const candidateIds =
			record?.candidates.map((candidate) => candidate.toolchainId) ?? [];
		const rank = candidateIds.indexOf(expected) + 1;
		const available = search?.available.has(expected) ?? false;
		const status = app.dialogue.get(id)?.status;
		const embedded =
			status === "completed" && record?.retrieval === "embedding";
		let miss:
			| {
					rawRank: number | null;
					slotsIncluded: boolean;
					scoreGap: number | null;
			  }
			| undefined;
		if (search?.query && !rank && available) {
			const { space, vector } = search.query;
			const available = (toolId: string) => search.available.has(toolId);
			const capabilities = app.toolchain.capabilities;
			miss = app.store.read((db) => {
				const [ranking] = capabilities.rankPastRequestsInTransaction(db, {
					queries: [{ spaceKey: vectorSpaceKey(space), values: vector }],
					available,
				});
				const ranked = capabilities.toolchainCandidatesInTransaction(db, {
					text,
					vector: { space, values: vector },
					available,
					limit: 8,
					strict: true,
				});
				const highest = ranked[0]?.score.similarity;
				const expectedScore = ranked.find((card) => card.id === expected)?.score
					.similarity;
				return {
					rawRank: (ranking?.ranked.indexOf(expected) ?? -1) + 1 || null,
					slotsIncluded: ranking?.offered.includes(expected) ?? false,
					scoreGap:
						highest == null || expectedScore == null
							? null
							: Number((highest - expectedScore).toFixed(4)),
				};
			});
		}
		const hit = embedded && available && rank > 0;
		embeddingRuns += Number(embedded);
		offered += Number(hit);
		first += Number(hit && rank === 1);
		passed += Number(hit && (diverse || rank === 1));
		console.log(
			JSON.stringify({
				caseId,
				situation,
				expected,
				status,
				available,
				rank: rank || null,
				...miss,
				retrieval: record?.retrieval,
				candidateIds,
			}),
		);
	}
	console.log(
		JSON.stringify({
			passed,
			total: cases.length,
			offered,
			first,
			embeddingRuns,
			availableTools: [...availableTools].sort(),
		}),
	);
	if (
		diverse &&
		(!availableTools.has("app.develop") || availableTools.has("ui.compose"))
	)
		throw new Error("live_search_app_development_catalog_mismatch");
	if (passed !== cases.length) process.exitCode = 1;
} finally {
	await host?.close();
	await larm.close();
}
