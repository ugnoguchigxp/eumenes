import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	agencyMigration,
	agencyActionsMigration,
	dispatchClockMigration,
	claimAgencyDispatch,
	saveAgency,
	agencyRecords,
	agencyEpoch,
	revokeAgency,
	insertAgencyWork,
	autonomousResearchSource,
	autonomousActionSource,
} from "../repository/agency";
import { createAgencyStatePort } from "../service/agency-state";
function fixture() {
	const db = new Database(":memory:");
	db.exec(agencyMigration);
	db.exec(dispatchClockMigration);
	db.exec(agencyActionsMigration);
	const record = {
		conversationId: "c",
		epoch: 0,
		scope: "s",
		snapshot: {
			state: {
				revision: 1,
				intents: [{ id: "i1", state: "adopted", workRef: "a1" }],
			},
		},
		idle: null,
		settingsDigest: "settings",
		sourceRefs: ["u1", "memory:m1"],
	};
	saveAgency(db, record, 1);
	return { db, record };
}
test("forget fences late checkpoints and removes their saved bodies", () => {
	const { db, record } = fixture();
	try {
		const p = createAgencyStatePort({ now: () => 2 });
		expect(
			p.forgetInTransaction(db, { messageIds: [], itemIds: ["m1"] }),
		).toEqual(["c"]);
		expect(agencyEpoch(db, "c")).toBe(1);
		expect(saveAgency(db, record, 3)).toBe(false);
		expect(agencyRecords(db)).toEqual([]);
	} finally {
		db.close();
	}
});
test("only an actual current autonomous work authorizes research and expiry revokes it", () => {
	const { db } = fixture();
	try {
		expect(autonomousResearchSource(db, "made-up", 1)).toBeNull();
		insertAgencyWork(db, {
			root_id: "root",
			conversation_id: "c",
			epoch: 0,
			ticket_id: "a1",
			intent_id: "i1",
			candidate_id: "c1",
			question: "問い",
			toolchain_revision_id: "toolchain:x@1",
			deadline: 10,
			source_refs_json: '["u1"]',
		});
		expect(autonomousResearchSource(db, "root", 2)).toMatchObject({
			origin: "autonomous",
			request: "問い",
		});
		expect(autonomousResearchSource(db, "root", 2)).not.toHaveProperty(
			"messageId",
		);
		expect(autonomousActionSource(db, "root", 2)).toBeNull();
		expect(autonomousResearchSource(db, "root", 10)).toBeNull();
		revokeAgency(db, "c");
		expect(autonomousResearchSource(db, "root", 3)).toBeNull();
	} finally {
		db.close();
	}
});

test("a worker failure at ready_for_answer returns failure instead of waiting for a nonexistent report", () => {
	const { db } = fixture();
	try {
		insertAgencyWork(db, {
			root_id: "failed-root",
			conversation_id: "c",
			epoch: 0,
			ticket_id: "a1",
			intent_id: "i1",
			candidate_id: "c1",
			question: "問い",
			toolchain_revision_id: "toolchain:x@1",
			deadline: 10,
			source_refs_json: '["u1"]',
		});
		db.query(
			"UPDATE dialogue_agency_work SET task_id='task' WHERE root_id='failed-root'",
		).run();
		const agents = {
			getInTransaction: () => ({
				status: "ready_for_answer",
				errorCode: "permission_revoked",
			}),
			reportInTransaction: () => null,
			prepareAnswerInTransaction: () => ({}),
			completeAnswerInTransaction: () => {},
		} as unknown as import("../../agent-runtime").AgentRuntime;
		const p = createAgencyStatePort({ agents, now: () => 2 });
		expect(p.resultsInTransaction(db)).toMatchObject([
			{ status: "failed", workStatus: "failed", summary: "permission_revoked" },
		]);
		p.returnedInTransaction(db, "failed-root");
		expect(p.resultsInTransaction(db)).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("evidence invalidated before adoption is rejected and the pending answer ends", () => {
	const { db } = fixture();
	let failed = 0;
	let completed = 0;
	try {
		insertAgencyWork(db, {
			root_id: "invalidated-root",
			conversation_id: "c",
			epoch: 0,
			ticket_id: "a1",
			intent_id: "i1",
			candidate_id: "c1",
			question: "問い",
			toolchain_revision_id: "toolchain:x@1",
			deadline: 10,
			source_refs_json: '["u1"]',
		});
		db.query(
			"UPDATE dialogue_agency_work SET task_id='task' WHERE root_id='invalidated-root'",
		).run();
		const agents = {
			getInTransaction: () => ({ status: "ready_for_answer", errorCode: null }),
			reportInTransaction: () => ({
				coverage: "complete",
				summary: "失効した結果",
			}),
			prepareAnswerInTransaction: () => {
				throw new Error("evidence_invalidated");
			},
			completeAnswerInTransaction: () => {
				completed++;
			},
			failAnswerInTransaction: () => {
				failed++;
			},
		} as unknown as import("../../agent-runtime").AgentRuntime;
		const p = createAgencyStatePort({ agents, now: () => 2 });
		expect(p.resultsInTransaction(db)).toMatchObject([
			{
				status: "failed",
				workStatus: "failed",
				summary: "agency_result_invalidated",
			},
		]);
		expect(p.returnedInTransaction(db, "invalidated-root")).toBe(false);
		expect(failed).toBe(1);
		expect(completed).toBe(0);
		expect(p.resultsInTransaction(db)).toEqual([]);
	} finally {
		db.close();
	}
});

test("actual dispatch time is atomic with the effect and survives subsequent checkpoints", () => {
	const { db, record } = fixture();
	try {
		expect(() =>
			db.transaction(() => {
				expect(claimAgencyDispatch(db, "c", 0, 10, 60000)).toBe(true);
				throw new Error("write_failed");
			})(),
		).toThrow("write_failed");
		expect(claimAgencyDispatch(db, "c", 0, 12, 60000)).toBe(true);
		saveAgency(db, record, 100);
		expect(claimAgencyDispatch(db, "c", 0, 60011, 60000)).toBe(false);
		expect(claimAgencyDispatch(db, "c", 1, 60012, 60000)).toBe(false);
		expect(claimAgencyDispatch(db, "c", 0, 60012, 60000)).toBe(true);
	} finally {
		db.close();
	}
});
