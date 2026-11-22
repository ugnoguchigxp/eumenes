import { expect, test } from "bun:test";
import type {
	ExecutionSource,
	ExecutionView,
} from "../../domains/tool-runtime";
import { createGoalsService } from "../../domains/goals";
import {
	createConversationSourceAdapter,
	createWorldDocuments,
	createWorldService,
} from "../../domains/world";
import { setupMemory } from "../../domains/memory/test/memory.fixture";
import {
	entityOp,
	memoryPolicyRevision,
	NOW,
	PURPOSE,
	request,
	TEST_CURSOR_SECRET,
	withHarness,
} from "../../domains/world/test/fixture";
import { messageRef, relate } from "../../domains/world/test/query-fixture";
import { GOALS_ACCESS } from "../world/goals-assembly";
import {
	supervisionBuildContext,
	supervisionResearchNote,
} from "./supervision-research";

const source: ExecutionSource = {
	conversationId: "c1",
	runId: "fixture",
	messageId: "request",
	request: "音声サービスの既存の起点を確認してください",
	digest: "verified-request",
};

test("web and inspect findings retain the original checked versions and refuse findings without sources", () => {
	const view: ExecutionView = {
		id: "research",
		conversationId: source.conversationId,
		request: "既存動作の確認",
		deadline: 1000,
		revision: 1,
		status: "completed",
		question: null,
		result: {
			status: "completed",
			summary: "公開仕様を確認",
			fulfilled: [],
			missing: [],
			refs: [],
			answer: "公開資料の既定値は10です。",
		},
	};
	expect(supervisionResearchNote("web.note", view, 10)).toBeNull();
	const published = [
		{
			sourceId: "s1",
			url: "https://example.com/spec",
			title: "仕様",
			fetchedAt: "2026-11-22T00:00:00.000Z",
		},
	];
	view.result!.sources = published;
	const web = supervisionResearchNote("web.note", view, 10);
	expect(web?.evidence).toMatchObject({
		id: view.id,
		kind: "web",
		sources: published,
	});
	expect(web?.at).toBe(Date.parse(published[0]!.fetchedAt));
	view.result!.answer = "公開資料の既定値は20です。";
	expect(
		supervisionResearchNote("web.note", view, 10)?.evidence.digest,
	).not.toBe(web?.evidence.digest);
	const location = {
		path: "src/main.ts",
		symbol: "main",
		commit: "abc",
		startLine: 2,
		endLine: 8,
		digest: "source-bytes-sha256",
	};
	view.status = view.result!.status = "partial";
	view.result!.report = {
		summary: "コードの入口",
		coverage: "partial",
		verification: "evidence_linked",
		claims: [],
		limitations: ["未実行のため件数は未確認"],
		sources: [{ sourceId: "location-1", location }],
	};
	const inspected = supervisionResearchNote("inspect.source", view, 20);
	expect(inspected?.evidence).toMatchObject({
		kind: "source",
		locations: [location],
	});
	expect(inspected?.text).toContain("src/main.ts:2-8 (main)");
	expect(inspected?.text).toContain("未実行のため件数は未確認");
	view.status = "cancelled";
	expect(supervisionResearchNote("inspect.source", view, 20)).toBeNull();
});

test.each(["forgotten", "expired"] as const)(
	"issued Memory evidence from the active conversation is unavailable when %s",
	async (state) => {
		const h = await setupMemory();
		try {
			const item = await h.seed(
				"数値を固定データで照合する",
				"acceptance-fixture",
			);
			const app = supervisionBuildContext({
				memory: h.memory,
				goals: { adoptedForContextInTransaction: () => [] },
				validSourceInTransaction: (_db, src) => src.runId === source.runId,
				validReferenceInTransaction: (db, _src, ref) =>
					h.memory.executionReferenceInTransaction(db, ref) !== null,
			});
			const notes = await h.store.write((db) =>
				app.contextInTransaction(db, source, []),
			);
			const note = notes.find(
				({ evidence }) => evidence.kind === "memory" && evidence.id === item.id,
			);
			expect(note?.text).toContain("数値を固定データで照合する");
			const valid = () =>
				h.store.read((db) =>
					app.validEvidenceInTransaction(db, source, note!.evidence),
				);
			expect(valid()).toBe(true);
			if (state === "forgotten") await h.forget([item.id]);
			else
				h.time.now = new Date(
					Date.parse(h.time.now) + 14 * 86_400_000,
				).toISOString();
			expect(valid()).toBe(false);
		} finally {
			await h.close();
		}
	},
);

test("a scoped World relation and adopted goal carry live revisions, with the relation invalidated when its source is retracted", async () => {
	await withHarness(async (h) => {
		await h.world.apply(entityOp());
		await h.world.apply(
			request("e-gateway", {
				kind: "entity.register",
				entity: {
					id: "gateway",
					displayName: "ゲートウェイ",
					aliases: [],
					externalRefs: [],
				},
			}),
		);
		const ref = await messageRef(h);
		await relate(h, ref, "claim", "svc-1", "gateway", "depends_on");
		const goals = createGoalsService(() => new Date(NOW).toISOString());
		const goal = await h.store.write((db) =>
			goals.adoptInTransaction(db, GOALS_ACCESS, {
				scopeKey: GOALS_ACCESS.scopeKeys[0],
				desiredState: "運用手順を確認する",
				source: { namespace: "conversation", kind: "message", id: ref.id },
			}),
		);
		const world = createWorldService({
			store: h.store,
			policyRevision: memoryPolicyRevision,
			sources: [
				createConversationSourceAdapter(h.conversation, {
					allowedPurposes: [PURPOSE, "dialogue.read"],
					cursorSecret: TEST_CURSOR_SECRET,
				}),
			],
		});
		const app = supervisionBuildContext({
			world: {
				store: h.store,
				service: world,
				documents: createWorldDocuments(h.store, world),
			},
			goals,
			memory: {
				executionReferenceInTransaction: () => null,
				executionReferencesInTransaction: () => [],
				windowForRunInTransaction: () => null,
			},
			validSourceInTransaction: () => true,
			validReferenceInTransaction: () => false,
			now: () => NOW,
		});
		const notes = await h.store.write((db) =>
			app.contextInTransaction(db, source, []),
		);
		const relation = notes.find(({ evidence }) => evidence.kind === "world");
		expect(relation).toMatchObject({
			text: expect.stringContaining("depends_on"),
			evidence: { id: "claim", revision: "2" },
		});
		expect(
			notes.find(({ evidence }) => evidence.kind === "goal")?.evidence,
		).toMatchObject({ id: goal.id, revision: "1" });
		const valid = () =>
			h.store.readSnapshot((db) =>
				app.validEvidenceInTransaction(db, source, relation!.evidence),
			);
		expect(valid()).toBe(true);
		await h.conversation.retract({ messageId: ref.id });
		expect(valid()).toBe(false);
	});
});
