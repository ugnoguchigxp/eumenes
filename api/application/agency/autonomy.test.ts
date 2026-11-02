import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import {
	createAgencyStatePort,
	autonomousResearchSource,
} from "../../domains/dialogue";
import { createAgencyHost } from "./host";
import { updated, wireOp, choice, baseSettings } from "./host.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import type { LlmPort } from "eumenes-agency";

// The real registry, queue, research worker and result contract; only models/network are fixtures.
test("autonomous intent dispatches real research, receives a result, survives restart and is revoked on forget", async () => {
	const h = await harness();
	const port = createAgencyStatePort({
		agents: h.toolchain.agents,
		toolchains: h.routing,
		now: Date.now,
	});
	const catalog = h.store.read(port.catalogInTransaction);
	expect(catalog.length).toBeGreaterThan(0);
	const card = catalog.find((c) => c.id.includes("web"))!;
	expect(card).toBeDefined();
	const llm: LlmPort = {
		async complete(request) {
			const d = JSON.parse(request.prompt);
			let value: unknown;
			if (request.purpose === "update") {
				const returned = d.observations.find(
					(o: { kind: string }) => o.kind === "work.returned",
				);
				const open = d.state.candidates.some(
					(c: { state: string }) => c.state !== "closed",
				);
				const intent = d.state.intents[0];
				value = updated({
					ops: open
						? []
						: [
								...(!intent
									? [
											wireOp("intent.add", {
												localId: "g",
												state: "adopted",
												text: "気になる気象の仕組みを理解する",
												reason: "会話からの問い",
												completionCondition: "資料から説明できる",
												resumeCondition: "調査可能",
												withdrawCondition: "関心の撤回",
												hours: 1,
												evidenceRefs: ["autonomy-user"],
											}),
										]
									: []),
								wireOp("candidate.add", {
									localId: "c",
									intentRef: intent?.id ?? "g",
									kind: returned ? "share" : "tool",
									text: returned
										? "調べた資料から分かったことがあります。"
										: "問いを調べる",
									toolName: returned ? null : "delegate",
									toolInput: returned
										? null
										: JSON.stringify({
												revisionId: card.id,
												question: "東京の天気を確認し根拠を示す",
											}),
									applyWhen: "静かな機会",
									hours: 1,
									evidenceRefs: [returned?.id ?? "autonomy-user"],
								}),
							],
				});
			} else {
				const c = d.candidates[0];
				value = {
					...choice("wait"),
					...(c?.kind === "tool"
						? {
								action: "tool",
								candidateRef: { id: c.id, revision: c.revision },
								evidenceRefs: ["autonomy-user"],
							}
						: {}),
				};
			}
			return {
				value: request.schema.parse(value),
				model: "fixture",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	const create = () =>
		createAgencyHost({
			store: h.store,
			conversation: h.conversation,
			inference: { foregroundBusy: () => false },
			state: port,
			settings: {
				get: () => ({
					agency: { ...baseSettings, idleSec: 0 },
					general: { agentName: "Eumenes", userName: "", persona: "butler" },
				}),
				inTransaction: () => ({
					agency: { ...baseSettings, idleSec: 0 },
					general: { agentName: "Eumenes", userName: "", persona: "butler" },
				}),
				onChange: () => () => {},
			},
			memory: {
				status: () => ({ enabled: true, healthy: true }),
				list: () => [],
			},
			createLlm: () => llm,
			conversationBusy: () => false,
			recordSpokeInTransaction: () => {},
		});
	let host = create();
	host.start();
	try {
		await h.store.write((db) => {
			h.conversation.appendInTransaction(db, {
				id: "autonomy-user",
				conversationId: "agency-test",
				role: "user",
				runId: null,
				text: "雲の形が変わる理由が気になる",
				createdAt: new Date().toISOString(),
			});
			h.conversation.appendInTransaction(db, {
				id: "autonomy-reply",
				conversationId: "agency-test",
				role: "assistant",
				text: "雲の観察は面白いですね。",
				createdAt: new Date().toISOString(),
				runId: "fixture-reply",
			});
		});
		await waitFor(
			() =>
				host
					.inspect("agency-test")
					?.snapshot.observations.some((o) => o.kind === "work.returned") ===
				true,
			{ timeout: 10000 },
		).catch((error) => {
			console.error(
				JSON.stringify({
					state: host
						.inspect("agency-test")
						?.snapshot.state.intents.map((i) => ({
							id: i.id,
							state: i.state,
							workRef: i.workRef,
						})),
					works: h.store.read((db) =>
						db
							.query(
								"SELECT root_id,task_id,returned,revoked FROM dialogue_agency_work",
							)
							.all(),
					),
					tasks: h.store.read((db) =>
						db
							.query(
								"SELECT kind,state,error_code,model_calls,tool_calls FROM agent_tasks",
							)
							.all(),
					),
				}),
			);
			throw error;
		});
		const snapshot = host.inspect("agency-test")!.snapshot;
		if (snapshot.state.intents[0]?.lastReturn?.status !== "succeeded")
			console.error(
				JSON.stringify(
					h.store.read((db) =>
						db
							.query(
								"SELECT kind,state,error_code,model_calls FROM agent_tasks",
							)
							.all(),
					),
				),
			);
		expect(snapshot.state.intents[0]?.lastReturn?.status).toBe("succeeded");
		expect(
			h.store
				.read((db) =>
					host.dialoguePort.stateForContextInTransaction!(db, "agency-test"),
				)
				.join(" "),
		).toContain("気になる気象");
		const row = h.store.read((db) =>
			db
				.query(
					"SELECT root_id FROM dialogue_agency_work WHERE conversation_id=?",
				)
				.get("agency-test"),
		) as { root_id: string };
		expect(
			h.store.read((db) =>
				autonomousResearchSource(db, row.root_id, Date.now()),
			),
		).toBeNull();
		expect(
			h.toolchain.agents.list(row.root_id).find((t) => t.kind === "coordinator")
				?.status,
		).toBe("completed");
		expect(
			h.store.read((db) =>
				db.query("SELECT id FROM dialogue_runs WHERE id=?").get(row.root_id),
			),
		).toBeNull();
		await host.close();
		host = create();
		host.start();
		expect(
			host.inspect("agency-test")!.snapshot.state.intents[0]?.lastReturn
				?.status,
		).toBe("succeeded");
		expect(
			h.store.read((db) =>
				db.query("SELECT count(*) AS n FROM dialogue_agency_work").get(),
			),
		).toEqual({ n: 1 });
		await h.store.write((db) =>
			port.forgetInTransaction(db, {
				messageIds: ["autonomy-user"],
				itemIds: [],
			}),
		);
		expect(
			h.store.read((db) =>
				autonomousResearchSource(db, row.root_id, Date.now()),
			),
		).toBeNull();
		expect(h.store.read(port.recordsInTransaction)).toHaveLength(0);
		expect(
			h.store.read((db) =>
				h.toolchain.agents.reportInTransaction(
					db,
					h.toolchain.agents.list(row.root_id)[0]!.id,
				),
			),
		).toBeNull();
	} finally {
		await host.close();
	}
}, 20000);
