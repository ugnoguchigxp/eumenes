import { acceptReport } from "../service/accept-report";
import { get } from "../repository";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore } from "../../../infrastructure/sqlite";
import {
	acquisitionMigration,
	createAgentRuntime,
	migration,
	type AcquisitionPlanPort,
	type AcquisitionObservationResult,
} from "..";

const bodyText = "SENTINEL_TARGET 27";
const visible = [
	{
		sourceId: "s1",
		viewId: crypto.randomUUID(),
		url: "https://example.com/a",
		title: "INJECTION_TITLE",
		basis: "page" as const,
		fetchedAt: new Date().toISOString(),
		truncated: false,
		body: bodyText,
	},
];

function setup(
	opts: {
		port?: Partial<AcquisitionPlanPort>;
		withPort?: boolean;
		legacySchema?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-acq-"));
	const store = openStore(join(dir, "db"), [migration, acquisitionMigration]);
	const calls: string[] = [];
	let observation: AcquisitionObservationResult = {
		kind: "valid",
		proofId: "proof-1",
		canonicalReportPatch: {
			summary: "27",
			claims: [
				{
					text: "27",
					evidence: [{ sourceId: "s1", quote: "SENTINEL_TARGET 27" }],
				},
			],
			limitations: [],
		},
		safeProjection: {
			summary: "値は27",
			claims: [{ text: "27", sourceIds: ["s1"] }],
			limitations: [],
		},
		projectionDigest: "d".repeat(64),
	};
	let adoption: { kind: "allowed" } | { kind: "rejected"; code: string } = {
		kind: "allowed",
	};
	const port: AcquisitionPlanPort = {
		resolveInTransaction: () => ({
			kind: "search-first",
			proposalToken: "p-1",
			query: "q",
			language: "ja",
			region: "JP",
		}),
		bindInTransaction: (_db, i) => {
			calls.push(`bind:${i.proposalToken}:${i.childOwner.taskId}`);
			return {
				kind: "bound",
				bindingToken: "b-1",
				packageRevisionId: "pkg",
				initialAction: {
					kind: "host-lookup",
					query: "q",
					language: "ja",
					region: "JP",
				},
			};
		},
		validateInTransaction: () => ({ kind: "allowed" }),
		recordObservationInTransaction: (_db, i) => {
			calls.push(`observe:${JSON.stringify(i.facts)}`);
			return observation;
		},
		validateAdoptionInTransaction: () => adoption,
		releaseInTransaction: (_db, i) => {
			calls.push(`release:${i.bindingToken}`);
			return { kind: "released" };
		},
		...opts.port,
	};
	const runtime = createAgentRuntime({
		store,
		capabilities: {} as never,
		tools: {
			observationsInTransaction: () => [],
			validateEvidenceInTransaction: () => true,
			cancelInTransaction: () => [],
			deleteDataInTransaction: () => {},
			summaryInTransaction: () => [],
			close: () => {},
		} as never,
		inference: {
			acceptInTransaction: () => true,
			rejectControlInTransaction: () => {},
		} as never,
		queue: {
			registerHandler: () => {},
			cancelInTransaction: () => {},
			enqueueInTransaction: () => ({ job: { id: "job-2" } }),
		} as never,
		acquisition: opts.withPort === false ? undefined : port,
	});
	return {
		store,
		runtime,
		port: opts.withPort === false ? undefined : port,
		calls,
		setObservation: (o: AcquisitionObservationResult) => (observation = o),
		setAdoption: (a: typeof adoption) => (adoption = a),
	};
}

function seedTree(db: Database, withReport = false) {
	const now = Date.now();
	db.query(
		"INSERT INTO agent_tasks(id,kind,root_run_id,input_json,state,phase,deadline,created_at,updated_at) VALUES('root','coordinator','run-1',?,'waiting_child','select',?,?,?)",
	).run(JSON.stringify({ question: "q" }), now + 60000, now, now);
	db.query(
		"INSERT INTO agent_tasks(id,kind,root_run_id,parent_task_id,input_json,state,phase,deadline,created_at,updated_at,current_step) VALUES('child','worker','run-1','root','{}','running','research',?,?,?,1)",
	).run(now + 60000, now, now);
	db.query(
		"INSERT INTO agent_steps(id,task_id,ordinal,state,job_id) VALUES('step-1','child',1,'running','job-1')",
	).run();
	if (withReport) return;
}

async function finish(h: ReturnType<typeof setup>, facts: unknown = { v: 27 }) {
	return h.store.write((db) => {
		const t = get(db, "child")!;
		acceptReport(
			db,
			t,
			{
				facts,
				report: {
					version: 2,
					outcome: "answered",
					summary: "26",
					claims: [
						{
							text: "26 INJECT",
							evidence: [
								{ sourceId: "s1", viewId: visible[0]!.viewId, excerptId: "e0" },
							],
						},
					],
					limitations: [],
					exploration: ["提示範囲"],
				},
			},
			{ visible },
			{
				tools: {
					observationsInTransaction: () => [],
					validateEvidenceInTransaction: () => true,
				} as never,
				prepared: undefined,
				canRead: false,
				now: Date.now,
				acquisition: h.port,
				storedBinding: (task) => h.runtime.bindingInTransaction(db, task.id),
				invocationDigests: () => [],
			},
		);
		db.query(
			"UPDATE agent_tasks SET state='completed',phase='completed',report_state='available' WHERE id='child'",
		).run();
		db.query(
			"UPDATE agent_tasks SET state='ready_for_answer',phase='answer',report_state='available',report_task_id='child' WHERE id='root'",
		).run();
		db.query(
			"INSERT OR IGNORE INTO agent_events(id,task_id,root_run_id,kind,state,created_at) VALUES('ready','root','run-1','ready','pending',?)",
		).run(Date.now());
		return "applied";
	});
}

async function readyForAnswer(h: ReturnType<typeof setup>) {
	await h.store.write((db) => seedTree(db));
	await h.store.write((db) => {
		h.runtime.resolveAcquisitionInTransaction(db, "root", 1);
		h.runtime.bindAcquisitionInTransaction(db, "root", "child");
	});
	await finish(h);
}

test("A01 root proposal is stored, then bound to a child owned by the same root", async () => {
	const h = setup();
	await h.store.write((db) => seedTree(db));
	await h.store.write((db) => {
		const proposal = h.runtime.resolveAcquisitionInTransaction(db, "root", 1);
		expect(proposal.kind).toBe("search-first");
		const bound = h.runtime.bindAcquisitionInTransaction(db, "root", "child");
		expect(bound.bindingToken).toBe("b-1");
		expect(bound.lookupProvenance).toBeNull();
		expect(
			h.runtime.byRootInTransaction(db, "run-1")!.acquisition_plan_json,
		).toContain("p-1");
	});
	expect(h.calls).toEqual(["bind:p-1:child"]);
	expect(h.runtime.get("child")!.acquisitionMode).toBe("search");
	// A task of another root cannot be bound.
	await h.store.write((db) => {
		db.query(
			"INSERT INTO agent_tasks(id,kind,root_run_id,parent_task_id,state,phase,deadline,created_at,updated_at) VALUES('other','worker','run-2','root','running','research',?,0,0)",
		).run(Date.now() + 1000);
		expect(() =>
			h.runtime.bindAcquisitionInTransaction(db, "root", "other"),
		).toThrow("task_cancelled");
	});
});

test("A01 without a port nothing changes: bind refuses and resolve is unmatched", async () => {
	const h = setup({ withPort: false });
	await h.store.write((db) => {
		seedTree(db);
		expect(h.runtime.resolveAcquisitionInTransaction(db, "root", 1)).toEqual({
			kind: "unmatched",
		});
		expect(() =>
			h.runtime.bindAcquisitionInTransaction(db, "root", "child"),
		).toThrow("acquisition_unavailable");
	});
});

test("A01 port-less finish keeps the legacy 4-column report and projection shape (NULL new columns)", async () => {
	const h = setup({ withPort: false });
	await h.store.write((db) => seedTree(db));
	await h.store.write((db) => {
		db.query("UPDATE agent_tasks SET kind='worker' WHERE id='child'").run();
	});
	expect(await finish(h)).toBe("applied");
	await h.store.read((db) => {
		const row = db
			.query("SELECT * FROM agent_reports WHERE task_id='child'")
			.get() as Record<string, unknown>;
		expect(row.safe_projection_json).toBeNull();
		expect(row.safe_projection_digest).toBeNull();
		expect(row.acquisition_binding_json).toBeNull();
		expect(JSON.parse(row.report_json as string).summary).toBe("26");
	});
});

test("A01 bound finish stores the host-verified canonical report and safe projection, not the model's text", async () => {
	const h = setup();
	await h.store.write((db) => seedTree(db));
	await h.store.write((db) => {
		h.runtime.resolveAcquisitionInTransaction(db, "root", 1);
		h.runtime.bindAcquisitionInTransaction(db, "root", "child");
	});
	expect(await finish(h, { v: 27 })).toBe("applied");
	expect(h.calls).toContain('observe:{"v":27}');
	await h.store.read((db) => {
		const row = db
			.query("SELECT * FROM agent_reports WHERE task_id='child'")
			.get() as Record<string, string>;
		expect(JSON.parse(row.report_json!).summary).toBe("27");
		expect(row.report_json).not.toContain("26 INJECT");
		const projection = JSON.parse(row.safe_projection_json!);
		expect(projection.summary).toBe("値は27");
		expect(projection.sources[0]).toEqual({
			sourceId: "s1",
			url: "https://example.com/a",
			basis: "page",
			fetchedAt: expect.any(String),
		});
		expect(JSON.stringify(projection)).not.toContain("SENTINEL_TARGET");
		expect(row.safe_projection_digest).toBe("d".repeat(64));
		expect(JSON.parse(row.acquisition_binding_json!)).toEqual({
			bindingToken: "b-1",
			proofId: "proof-1",
		});
	});
});

test("A01 prepareAnswer uses the stored safe projection and rechecks cached authority at adoption", async () => {
	const h = setup();
	await readyForAnswer(h);
	const ticket = await h.store.write((db) =>
		h.runtime.prepareAnswerInTransaction(db, "run-1"),
	);
	expect(JSON.parse(ticket.projection!).summary).toBe("値は27");
	expect(ticket.projectionDigest).toBe("d".repeat(64));
	expect(ticket.acquisitionBindingToken).toBe("b-1");
	expect(
		await h.store.write((db) => h.runtime.validAnswerInTransaction(db, ticket)),
	).toBe(true);
	h.setAdoption({ kind: "rejected", code: "route_disabled" });
	expect(
		await h.store.write((db) => h.runtime.validAnswerInTransaction(db, ticket)),
	).toBe(false);
	await h.store.write((db) => {
		expect(() => h.runtime.prepareAnswerInTransaction(db, "run-1")).toThrow(
			"route_disabled",
		);
	});
});

test("A01 adopted evidence survives completion's revision bump; deletion or a changed report refuses it", async () => {
	const h = setup();
	await readyForAnswer(h);
	const ticket = await h.store.write((db) =>
		h.runtime.prepareAnswerInTransaction(db, "run-1"),
	);
	await h.store.write((db) =>
		h.runtime.completeAnswerInTransaction(db, ticket),
	);
	const evidence = await h.store.write((db) =>
		h.runtime.getAdoptedEvidenceInTransaction(db, {
			rootRunId: "run-1",
			ticketId: ticket.eventId,
			reportEpoch: ticket.reportEpoch!,
		}),
	);
	expect(evidence).toMatchObject({
		childTaskId: "child",
		bindingToken: "b-1",
		projectionDigest: "d".repeat(64),
	});
	expect(
		await h.store.write((db) =>
			h.runtime.validateAdoptedEvidenceInTransaction(db, evidence!),
		),
	).toBe(true);
	// wrong epoch / unknown ticket
	expect(
		await h.store.write((db) =>
			h.runtime.getAdoptedEvidenceInTransaction(db, {
				rootRunId: "run-1",
				ticketId: "nope",
				reportEpoch: 0,
			}),
		),
	).toBeNull();
	await h.store.write((db) =>
		h.runtime.deleteTaskDataInTransaction(db, "run-1"),
	);
	expect(
		await h.store.write((db) =>
			h.runtime.validateAdoptedEvidenceInTransaction(db, evidence!),
		),
	).toBe(false);
	expect(h.calls).toContain("release:b-1");
});

test("A01 a cancelled tree releases its binding", async () => {
	const h = setup();
	await h.store.write((db) => seedTree(db));
	await h.store.write((db) => {
		h.runtime.resolveAcquisitionInTransaction(db, "root", 1);
		h.runtime.bindAcquisitionInTransaction(db, "root", "child");
		h.runtime.cancelTreeInTransaction(db, "run-1");
	});
	expect(h.calls).toContain("release:b-1");
});

test("A01 acquisitionMigration upgrades a legacy DB: old 4-column rows keep the legacy projection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-acq-up-"));
	const path = join(dir, "db");
	const old = openStore(path, [migration]);
	await old.write((db) => {
		seedTree(db);
		db.query("INSERT INTO agent_reports VALUES('child',?,?,1)").run(
			JSON.stringify({
				summary: "s",
				claims: [],
				limitations: [],
				sources: [],
				coverage: "complete",
				verification: "evidence_linked",
			}),
			"x",
		);
	});
	await old.close();
	const upgraded = openStore(path, [migration, acquisitionMigration]);
	await upgraded.read((db) => {
		const row = db.query("SELECT * FROM agent_reports").get() as Record<
			string,
			unknown
		>;
		expect(row.safe_projection_json).toBeNull();
		expect(db.query("SELECT action_origin FROM agent_steps").get()).toEqual({
			action_origin: "model",
		});
	});
});
