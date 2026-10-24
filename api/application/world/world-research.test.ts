import { expect, test } from "bun:test";
import {
	type Packet,
	boot,
	invoke,
	finish,
	CLAIM_TEXT,
	SCOPE,
	QUESTION,
	happy,
} from "./world-research.fixture";
import { fit, sourceOf, summaryOf } from "./world-research-readings";

/**
 * A message that carries the saved report's projection. The fixed host rules of every answer name the
 * `world_claim` kind in prose, so only a source object of that kind (escaped inside the stringified messages) counts.
 */
const projectsWorldClaim = (message: string) =>
	message.includes('\\"kind\\":\\"world_claim\\"');

test("a World question delegates to route world: the sub-agent finds the target, reads claims as sources and the report is projected", async () => {
	const h = await boot(happy);
	expect(
		h.store.read((db) =>
			h.routing.catalogInTransaction(db).map((c) => c.runtime.route),
		),
	).toContain("world");
	const { run, done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(h.offered.join("")).toContain("world.query");
	// The worker input is only the question, the detail and the original request: no URL.
	const first = h.packets[0]!;
	expect(Object.keys(first.task).sort()).toEqual(["detail", "question"]);
	expect(first.originalRequest).toBe(QUESTION);
	expect(first.task.urls).toBeUndefined();
	// world.find lists the target (by id and name) and the matching adopted goal in its notes.
	const found = h.packets[1]!.operations[0]!;
	expect(found.tool).toBe("world.find");
	expect(found.notes!.entities).toEqual([
		{ id: "svc-1", name: "音声サービス", aliases: ["ボイス"] },
	]);
	expect(found.notes!.goals).toHaveLength(1);
	expect(found.notes!.goals[0]).toMatchObject({
		desiredState: "音声サービスを10月に公開する",
	});
	// world.query readings are world claims written with the target's name.
	const reading = h.packets[2]!.observations.find((o) => o.basis === "world")!;
	expect(reading.title).toBe("Worldの記録（本人の報告）");
	expect(reading.origin).toBe("user_report");
	expect(reading.excerpts.map((e) => e.quote).join("")).toContain(
		"対象: 音声サービス",
	);
	expect(h.packets[2]!.operations[1]!.notes).toMatchObject({
		mode: "snapshot",
		completeness: "complete",
	});
	// The conversation model sees the projection of the saved report, not the reading.
	const projected = h.parentMessages.find(projectsWorldClaim);
	expect(projected).toBeDefined();
	// Only the source id, kind and origin cross to the parent: no claim id or revision.
	expect(projected).toContain("sourceId");
	expect(projected).toContain("user_report");
	expect(projected).not.toContain("claim-1");
	expect(projected).not.toContain("sourceRef");
	expect(projected).not.toContain("svc-1");
	expect(projected).not.toContain("launch_month");
	expect(h.dialogue.answerText(run.id)).toContain("調べた結果");
	const report = h.store.read(
		(db) =>
			db.query("SELECT report_json FROM agent_reports").get() as {
				report_json: string;
			},
	);
	expect(JSON.parse(report.report_json).sources[0]).toMatchObject({
		kind: "world_claim",
		sourceRef: "claim-1",
		sourceRevision: "2",
		basis: "world",
		scopeRef: SCOPE.scopeKey,
	});
});

test("a claim retracted while the research ran keeps the report from being adopted", async () => {
	const h = await boot([
		happy[0]!,
		happy[1]!,
		async (packet, hooks) => {
			const report = finish(packet, CLAIM_TEXT);
			await hooks.retractClaim();
			return report;
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(
		h.store.read((db) =>
			db.query("SELECT error_code FROM agent_tasks WHERE kind='worker'").get(),
		),
	).toEqual({ error_code: "evidence_invalidated" });
	// No accepted report: the conversation model never sees the projection.
	expect(h.parentMessages.find(projectsWorldClaim)).toBeUndefined();
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM agent_reports").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
});

test("a target World does not know is reported as not found, with no readings", async () => {
	const h = await boot([
		() => invoke("world.find", { names: ["存在しない対象"] }),
		(packet) => {
			expect(packet.operations[0]!.notes!.entities).toEqual([]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "Worldにその対象の記録はありません。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("存在しない対象について教えて");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("World off: the World investigation is not offered", async () => {
	const h = await boot([], { world: false });
	expect(
		h.store.read((db) =>
			h.routing.catalogInTransaction(db).map((c) => c.runtime.route),
		),
	).not.toContain("world");
});

test("a query the World refuses comes back as a machine failure code, not as a reading", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "relevance", entityId: "unknown-id" }),
		(packet) => {
			const op = packet.operations[0]!;
			expect(op.state).toBe("succeeded");
			expect(op.failures).toEqual([{ url: "world", code: "not_available" }]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "照会できませんでした。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("謎の対象に関係の深いものは？");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("a snapshot given one entityId (the live mistake) reads that single start point", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "snapshot", entityId: "svc-1" }),
		(packet) => {
			expect(packet.operations[0]!.failures).toEqual([]);
			return finish(packet, CLAIM_TEXT);
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(
		h.packets[1]!.observations.some((o) => o.basis === "world"),
	).toBeTrue();
});

test("an input that does not fit the mode comes back as invalid_input with the fields to repair", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "influence", entityIds: ["svc-1"] }),
		(packet) => {
			const op = packet.operations[0]!;
			expect(op.state).toBe("succeeded");
			expect(op.failures).toEqual([{ url: "world", code: "invalid_input" }]);
			expect(op.notes!.invalidFields.length).toBeGreaterThan(0);
			return {
				action: "finish",
				report: {
					outcome: "failed",
					summary: "照会できませんでした。",
					claims: [],
					limitations: ["照会の入力が合わなかった"],
				},
			};
		},
	]);
	const { done } = await h.ask("音声サービスを変えると何に影響する？");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("a finish whose claims omit evidence is rejected and repaired: the references e1.. were offered and the skill says how to cite them", async () => {
	// The live failure shape: the sub-agent read the World, then finished with claims that carry no evidence.
	let rejected: Packet["lastResult"];
	let offered: unknown;
	const h = await boot([
		happy[0]!,
		happy[1]!,
		(packet) => {
			offered = {
				evidence: (packet as unknown as { evidence?: unknown }).evidence,
				references: packet.observations.flatMap((o) =>
					o.excerpts.map((e) => e.reference),
				),
			};
			return {
				action: "finish",
				report: {
					outcome: "answered",
					summary: "音声サービスの提供開始は10月と記録されています。",
					claims: [{ text: "音声サービスの提供開始は10月" }],
					limitations: [],
				},
			};
		},
		(packet) => {
			rejected = packet.lastResult;
			return finish(packet, CLAIM_TEXT);
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	// The readings were offered as references the claim could cite.
	expect(offered).toMatchObject({ references: ["e1"] });
	// The rejection names the missing field, and the repair step is accepted with the reference.
	expect(rejected?.issues).toContainEqual(
		expect.objectContaining({
			validationPath: "report.claims.0.evidence",
			validationCode: "invalid_type",
		}),
	);
	expect(workerError(h)).toEqual({ error_code: null });
	expect(readReport(h).sources[0]).toMatchObject({ kind: "world_claim" });
	// The skill the sub-agent was given tells it to cite excerpt references and what to do without any.
	const instructions = h.workerMessages[2]!;
	expect(instructions).toContain("evidence を省かない");
	expect(instructions).toContain(
		"claims を空の配列 [] にして outcome を not_found",
	);
	expect(instructions).toContain(
		"dN は資料の番号であり、根拠参照 (eN) ではない",
	);
});

test("a query that returns no readings: the sub-agent has no references and finishes with not_found and no claims", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["静かな機器"] }),
			(packet) =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: [packet.operations[0]!.notes!.entities[0].id],
					depth: 0,
				}),
			(packet) => {
				expect(packet.observations).toEqual([]);
				expect(
					(packet as unknown as { evidence?: unknown[] }).evidence ?? [],
				).toEqual([]);
				return {
					action: "finish",
					report: {
						outcome: "not_found",
						summary: "Worldにその対象についての記録はありません。",
						claims: [],
						limitations: ["対象は記録されているが、主張がまだ無い"],
					},
				};
			},
		],
		{
			seed: async ({ apply }) => {
				await apply("quiet-1", {
					kind: "entity.register",
					entity: {
						id: "quiet-1",
						displayName: "静かな機器",
						aliases: [],
						externalRefs: [],
					},
				});
			},
		},
	);
	const { done } = await h.ask("静かな機器について何が分かっている？");
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: null });
	expect(h.packets[2]!.operations[1]!.notes).toMatchObject({
		mode: "snapshot",
	});
});

const readReport = (h: Awaited<ReturnType<typeof boot>>) =>
	JSON.parse(
		(
			h.store.read(
				(db) =>
					db.query("SELECT report_json FROM agent_reports").get() as {
						report_json: string;
					},
			) as { report_json: string }
		).report_json,
	) as { coverage: string; sources: Array<Record<string, unknown>> };
const workerError = (h: Awaited<ReturnType<typeof boot>>) =>
	h.store.read((db) =>
		db.query("SELECT error_code FROM agent_tasks WHERE kind='worker'").get(),
	);

test("a claim revised (disputed) while the research ran keeps the report from being adopted", async () => {
	const h = await boot([
		happy[0]!,
		happy[1]!,
		async (packet, hooks) => {
			const report = finish(packet, CLAIM_TEXT);
			await hooks.reviseClaim();
			return report;
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
	expect(h.parentMessages.find(projectsWorldClaim)).toBeUndefined();
});

test("a source forgotten while the research ran keeps the report from being adopted, even before World's tombstone is written", async () => {
	// The feed does not run: the forget is accepted (conversation retraction, Memory exclusion) and World's
	// tombstone is still to come. Only the source-resolving re-read can see it.
	const h = await boot(
		[
			happy[0]!,
			happy[1]!,
			async (packet, hooks) => {
				const report = finish(packet, CLAIM_TEXT);
				await hooks.forgetSource(false);
				return report;
			},
		],
		{ feed: false },
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
	expect(h.parentMessages.find(projectsWorldClaim)).toBeUndefined();
});

test("a forgotten source whose World tombstone is already written keeps the report from being adopted", async () => {
	const h = await boot(
		[
			happy[0]!,
			happy[1]!,
			async (packet, hooks) => {
				const report = finish(packet, CLAIM_TEXT);
				await hooks.forgetSource(true);
				return report;
			},
		],
		{ feed: false },
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
});

test("a snapshot cut by World's own budget: the readings stay within the cap, every reading says the read was partial and the report's coverage is partial", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声サービス"] }),
			(packet) =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: [packet.operations[0]!.notes!.entities[0].id],
					depth: 0,
				}),
			(packet) => {
				const reference = packet.observations.flatMap((o) => o.excerpts)[0]!
					.reference;
				expect(
					packet.observations.filter((o) => o.basis === "world").length,
				).toBeLessThanOrEqual(24);
				const notes = packet.operations.at(-1)!.notes!;
				expect(notes.completeness).toBe("partial");
				return {
					action: "finish",
					report: {
						outcome: "answered",
						summary: "音声サービスには多くの記録があります。",
						claims: [
							{ text: "音声サービスの記録は多数ある", evidence: [reference] },
						],
						limitations: ["一部しか読めていない"],
					},
				};
			},
		],
		{
			seed: async ({ apply, assertion }) => {
				for (let i = 0; i < 60; i++)
					await apply(`bulk-${i}`, {
						kind: "assertion.register",
						assertion: assertion(`bulk-${i}`, "svc-1", `p${i}`, `v`),
					});
			},
		},
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	const report = readReport(h);
	expect(report.coverage).toBe("partial");
	expect(report.sources.every((s) => s.acquisitionTruncated === true)).toBe(
		true,
	);
});

test("more than 20 matching targets: world.find lists a few within its byte budget and says it is truncated", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声機器"] }),
			(packet) => {
				const notes = packet.operations[0]!.notes!;
				expect(notes.entities.length).toBeGreaterThan(0);
				expect(notes.entities.length).toBeLessThanOrEqual(20);
				expect(notes.truncated).toBe(true);
				expect(
					new TextEncoder().encode(JSON.stringify(notes)).length,
				).toBeLessThanOrEqual(1500);
				return {
					action: "finish",
					report: {
						outcome: "clarification_required",
						summary: "対象が多く、絞れません。",
						claims: [],
						limitations: [],
					},
				};
			},
		],
		{
			seed: async ({ apply }) => {
				for (let i = 0; i < 30; i++)
					await apply(`dev-${i}`, {
						kind: "entity.register",
						entity: {
							id: `dev-${i}`,
							displayName: `音声機器${i}号`,
							aliases: [
								`ボイス機器${i}`,
								`マイク${i}`,
								`スピーカー${i}`,
								`別名${i}`,
							],
							externalRefs: [],
						},
					});
			},
		},
	);
	const { done } = await h.ask("音声機器について教えて");
	expect(done?.status).toBe("completed");
});

test("a one-character name identifies nothing: world.find lists no target for it", async () => {
	const h = await boot([
		() => invoke("world.find", { names: ["音"] }),
		(packet) => {
			expect(packet.operations[0]!.notes!.entities).toEqual([]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "Worldにその対象の記録はありません。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("音について教えて");
	expect(done?.status).toBe("completed");
});

// --- the readings, without the assembly -----------------------------------

const claim = (over: Record<string, unknown> = {}) =>
	({
		id: "c1",
		revision: 1,
		subjectId: "a",
		predicate: "launch_month",
		origin: "user_report",
		status: "active",
		freshness: "fresh",
		refutations: [],
		condition: { kind: "unspecified" },
		value: { kind: "string", value: "10月" },
		...over,
	}) as never;
const NAMES: Record<string, string> = { a: "音声サービス", b: "LARM" };
const nameOf = (id: string) => NAMES[id];

test("a relation reading says the relation in plain words and never the stored identifier", () => {
	const source = sourceOf(
		claim({
			relation: { kind: "depends_on", objectId: "b" },
			value: undefined,
		}),
		"scope",
		"2026-10-09T00:00:00Z",
		nameOf,
	)!;
	expect(source.body).toContain("依存している");
	expect(source.body).toContain("LARM");
	expect(source.body).not.toContain("depends_on");
	expect(source.truncated).toBe(false);
	expect(source.acquisitionTruncated).toBeUndefined();
});

test("a reading whose target has no resolvable name is not written", () => {
	expect(
		sourceOf(
			claim({ subjectId: "zzz" }),
			"scope",
			"2026-10-09T00:00:00Z",
			nameOf,
		),
	).toBeUndefined();
});

test("a reading whose value was clipped says so, and its digest is stable", () => {
	const long = claim({ value: { kind: "string", value: "あ".repeat(500) } });
	const a = sourceOf(long, "scope", "2026-10-09T00:00:00Z", nameOf)!;
	const b = sourceOf(long, "scope", "2026-10-09T00:00:00Z", nameOf)!;
	expect(a.truncated).toBe(true);
	expect(a.acquisitionTruncated).toBe(true);
	expect(a.viewDigest).toBe(b.viewDigest);
});

test("an incomplete read marks its readings as truncated even when their text is whole", () => {
	const source = sourceOf(
		claim(),
		"scope",
		"2026-10-09T00:00:00Z",
		nameOf,
		true,
	)!;
	expect(source.acquisitionTruncated).toBe(true);
});

test("gap kinds and dependency states are written in plain words, and unnamed targets are left out and counted", () => {
	const gaps = summaryOf(
		{
			mode: "gaps",
			gaps: {
				gaps: [
					{
						kind: "RESOURCE_STATE_UNKNOWN",
						subjectId: "a",
						edgeId: "e1",
						confirmWith: { kind: "entity", id: "b" },
						blocksGoal: true,
					},
					{
						kind: "CONDITION_UNKNOWN",
						subjectId: "zzz",
						edgeId: "e2",
						confirmWith: { kind: "entity", id: "b" },
						blocksGoal: false,
					},
				],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const text = JSON.stringify(gaps.summary);
	expect(text).toContain("使えるかどうかが分かっていない");
	expect(text).not.toContain("RESOURCE_STATE_UNKNOWN");
	expect(gaps.dropped).toBe(1);
	const dependencies = summaryOf(
		{
			mode: "dependencies",
			dependencies: {
				entityId: "a",
				outcome: "unknown",
				reasonCode: "NO_DEPENDENCIES_KNOWN",
				dependencies: [
					{
						entityId: "b",
						depth: 1,
						state: "unavailable",
						viaEdgeId: "e1",
						reasonCode: "CONDITION_UNKNOWN",
					},
				],
				unsatisfied: ["b"],
				unknown: [],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const deps = JSON.stringify(dependencies.summary);
	expect(deps).toContain("使えない");
	expect(deps).not.toMatch(
		/unavailable|CONDITION_UNKNOWN|NO_DEPENDENCIES_KNOWN/,
	);
});

test("a summary over its budget is cut and says so", () => {
	const big = {
		related: Array.from({ length: 200 }, (_, i) => ({
			name: `対象${i}`,
			distance: 1,
		})),
	};
	const fitted = fit(big);
	expect(fitted.truncated).toBe(true);
	expect(
		new TextEncoder().encode(JSON.stringify(fitted.summary)).length,
	).toBeLessThanOrEqual(2600);
	expect((fitted.summary as { truncated?: boolean }).truncated).toBe(true);
	expect(fit({ related: [] }).truncated).toBe(false);
});

test("a result summary points at readings as `document` / `documents`, never as `claims` (the report's own field)", () => {
	const influence = summaryOf(
		{
			mode: "influence",
			influence: {
				direction: "forward",
				entityId: "a",
				paths: [
					{
						nodes: ["a", "b"],
						edges: [{ id: "c1" }],
						effect: "decreases",
						confirmed: false,
					},
				],
				skipped: [],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const path = (influence.summary as { paths: Array<Record<string, unknown>> })
		.paths[0]!;
	expect(path.documents).toEqual(["c1"]);
	expect(JSON.stringify(influence.summary)).not.toContain('"claim');
});
