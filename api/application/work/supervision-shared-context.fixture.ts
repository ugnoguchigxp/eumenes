import { expect } from "bun:test";
import type {
	SupervisionEvidence,
	SupervisionNote,
} from "../../domains/development-supervision/contracts";
import { saveItem } from "../../domains/dialogue/test/memory-seed";
import { createGoalsService } from "../../domains/goals";
import {
	createConversationSourceAdapter,
	createWorldDocuments,
	createWorldService,
} from "../../domains/world";
import {
	adoptPlan,
	claim,
	currentRef,
	PURPOSE,
	registerClaim,
	request,
	TEST_CURSOR_SECRET,
} from "../../domains/world/test/fixture";
import type { harness } from "../toolchain/toolchain.fixture";
import { GOALS_ACCESS } from "../world/goals-assembly";

const memoryText = "集計の検証は固定入力二件で照合する";
const goalText = "固定入力の件数が集計結果に反映されることを確認する";
const assertionId = "aggregate-regression-dependency";

export async function seedSupervisionSharedContext(
	h: Awaited<ReturnType<typeof harness>>,
	goals: ReturnType<typeof createGoalsService>,
) {
	const memory = h.memory!;
	const clock = Date.now();
	const messageId = crypto.randomUUID();
	const conversationId = "development-notes";
	await h.conversation.append({
		id: messageId,
		conversationId,
		role: "user",
		text: `${memoryText}。集計関数の確認には件数の回帰試験が必要。目標は${goalText}。`,
		createdAt: new Date(clock).toISOString(),
		runId: null,
	});
	const item = await saveItem(h.store, memory, {
		conversationId,
		messageId,
		quote: memoryText,
		kind: "constraint",
		semanticKey: "aggregate-fixture-check",
		text: memoryText,
	});
	const service = createWorldService({
		store: h.store,
		policyRevision: memory.policyRevisionInTransaction,
		sources: [
			createConversationSourceAdapter(h.conversation, {
				allowedPurposes: [PURPOSE, "dialogue.read"],
				cursorSecret: TEST_CURSOR_SECRET,
			}),
		],
	});
	await service.markInitialSyncComplete();
	await service.setEnabled(true);
	const apply = async (operation: ReturnType<typeof request>) => {
		expect((await service.apply({ ...operation, clock })).status).toBe(
			"applied",
		);
	};
	for (const [id, displayName] of [
		["aggregate-function", "集計関数"],
		["row-count-regression", "件数の回帰試験"],
	] as const) {
		await apply(
			request(`create-${id}`, {
				kind: "entity.register",
				entity: { id, displayName, aliases: [], externalRefs: [] },
			}),
		);
	}
	await apply(
		registerClaim(
			"relation-register",
			claim(assertionId, [currentRef(h, messageId)], {
				subjectId: "aggregate-function",
				predicate: "depends_on",
				payload: {
					kind: "relation",
					relation: "depends_on",
					objectId: "row-count-regression",
				},
				condition: {
					kind: "explicitly_unconditional",
					adoptionEvidenceId: `ev-${assertionId}-0`,
				},
				recordedAt: clock,
			}),
		),
	);
	await apply(
		request("relation-adopt", {
			kind: "assertion.transition",
			plan: adoptPlan(assertionId, 1),
		}),
	);
	const goal = await h.store.write((db) =>
		goals.adoptInTransaction(db, GOALS_ACCESS, {
			scopeKey: GOALS_ACCESS.scopeKeys[0],
			desiredState: goalText,
			source: { namespace: "conversation", kind: "message", id: messageId },
		}),
	);
	return {
		world: {
			store: h.store,
			service,
			documents: createWorldDocuments(h.store, service),
		},
		expected: [
			{
				kind: "memory",
				id: item.id,
				revision: String(item.revision),
				body: memoryText,
			},
			{
				kind: "world",
				id: assertionId,
				revision: "2",
				body: '"predicate":"depends_on"',
			},
			{
				kind: "goal",
				id: goal.id,
				revision: String(goal.revision),
				body: goalText,
			},
		] as const,
	};
}

export type SharedContextFixture = Awaited<
	ReturnType<typeof seedSupervisionSharedContext>
>;

export function checkSupervisionSharedContext(
	{ expected }: SharedContextFixture,
	notes: readonly Pick<SupervisionNote, "evidence" | "text">[],
) {
	return expected.map(({ kind, id, revision, body }) => {
		const note = notes.find((entry) => entry.evidence.id === id);
		expect(note?.evidence).toMatchObject({ kind, id, revision });
		expect(note!.evidence.ref).toContain(id);
		expect(note!.evidence.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(note!.text).toContain(body);
		return note!.evidence;
	});
}

export function sourceCitation(evidence: SupervisionEvidence) {
	if (!("revision" in evidence)) throw new Error("unversioned fixture source");
	return `${evidence.ref} (rev ${evidence.revision}, SHA-256 ${evidence.digest})`;
}
