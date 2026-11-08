import { expect, test } from "bun:test";
import type { LlmPort } from "eumenes-agency";
import { createAgencyStatePort } from "../../domains/dialogue";
import type { AgencyLayerPort } from "../../domains/dialogue/contracts";
import {
	setup,
	reply,
	IMAGE,
	choice as routeChoice,
} from "../../domains/dialogue/test/generation.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { createAgencyHost } from "./host";
import { baseSettings, choice, updated } from "./host.fixture";
import { saveItem } from "../../domains/memory/test/memory.fixture";

for (const withCompletedWork of [false, true]) {
	test(`a forgotten input cannot re-enter shared context with completed work=${withCompletedWork}`, async () => {
		let layer: AgencyLayerPort | undefined;
		const h = await setup({
			memory: true,
			agency: {
				isCurrentInputInTransaction: (...args) =>
					layer?.isCurrentInputInTransaction?.(...args) ?? true,
				inputForContextInTransaction: (...args) =>
					layer?.inputForContextInTransaction?.(...args) ?? {
						sources: [],
						complete: true,
					},
				stateForContextInTransaction: (...args) =>
					layer?.stateForContextInTransaction?.(...args) ?? [],
				workChangedInTransaction: () => {},
			},
		});
		const memory = h.memory!;
		const state = createAgencyStatePort({ memory, now: Date.now });
		let selections = 0;
		const requests: Array<{ prompt: string; sources: readonly string[] }> = [];
		const llm: LlmPort = {
			async complete(request) {
				requests.push({
					prompt: request.prompt,
					sources: request.input?.sources ?? [],
				});
				if (request.purpose === "select") selections++;
				return {
					value: request.schema.parse(
						request.purpose === "update" ? updated() : choice("wait"),
					),
					model: "fixture",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					latencyMs: 1,
				};
			},
		};
		const settings = {
			agency: baseSettings,
			general: {
				agentName: "Eumenes",
				userName: "",
				persona: "butler" as const,
			},
		};
		const makeHost = () =>
			createAgencyHost({
				store: h.store,
				conversation: h.conversation,
				memory,
				state,
				settings: {
					get: () => settings,
					inTransaction: () => settings,
					onChange: () => () => {},
				},
				inference: { foregroundBusy: () => false },
				conversationBusy: (db, id) =>
					h.dialogue.conversationHasActiveRunInTransaction(db, id),
				captureContext: (id) =>
					h.store.read((db) => {
						const captured = h.dialogue.conversationTaskInTransaction(
							db,
							id,
							"",
							{
								requireProvenance: true,
							},
						);
						return captured
							? {
									messages: captured.messages,
									input: captured.input ?? { sources: [], complete: false },
								}
							: null;
					}),
				createLlm: () => llm,
				recordSpokeInTransaction: (db, input) =>
					h.dialogue.recordSpontaneousInTransaction(db, input),
				setTimer: () => 1,
				clearTimer: () => {},
			});
		let host = makeHost();
		layer = host.dialoguePort;
		memory.registerForgetPurge(
			(db, input) => host.forgetInTransaction(db, input),
			(db, input) => host.planForgetInTransaction(db, input),
		);
		host.start();
		try {
			let workInputId: string | undefined;
			if (withCompletedWork) {
				h.state.steps.push(routeChoice({ choice: IMAGE.id }));
				const run = await h.say("古い制作の成果を画像にしてください", "queued");
				workInputId = run.inputMessageId;
				await h.finishImage(run.id, {
					state: "completed",
					title: "古い制作の成果",
				});
				await settle();
				expect(h.archived()).toHaveLength(1);
			}
			const earlierSelections = selections;
			h.state.steps.push(...reply("古い話を受け取りました。"));
			await h.say("古い観測だけに属する話題です。");
			await waitFor(
				() => selections === earlierSelections + 1 && !host.status("main").busy,
			);
			await settle();
			const row = h.store.read((db) =>
				state.observationsInTransaction(db, "main").find((o) => {
					const source = h.conversation.sourceInTransaction(
						db,
						o.observationId,
					);
					return (
						source.state === "available" &&
						source.message.role === "user" &&
						(!workInputId || o.observationId === workInputId)
					);
				}),
			)!;
			expect(row).toBeDefined();
			const topic = await saveItem(h.store, memory, {
				conversationId: "main",
				messageId: row.observationId,
				kind: "preference",
				semanticKey: "old.topic",
				text: "古い観測に基づく好み",
			});
			expect(
				await memory.forget({
					conversationId: "main",
					messageIds: [],
					itemIds: [],
					derived: { "memory.records": [row.ref.id] },
				}),
			).toMatchObject({ completed: true });
			expect(
				h.store.read((db) =>
					h.conversation.sourceInTransaction(db, row.observationId),
				).state,
			).toBe("available");
			expect(host.inspect("main")?.snapshot.forgottenRefs).toContain(
				row.observationId,
			);
			h.store.read((db) => {
				const source = h.conversation.sourceInTransaction(
					db,
					row.observationId,
				);
				expect(source.state === "available" && source.message.role).toBe(
					"user",
				);
				const input = memory.referenceInputs.captureInTransaction(db, {
					messageIds: [row.observationId],
				});
				expect(
					host.dialoguePort.isCurrentInputInTransaction?.(db, input, "main"),
				).toBe(false);
				expect(
					host.dialoguePort.isCurrentInputInTransaction?.(
						db,
						input,
						"independent",
					),
				).toBe(true);
			});
			await host.close();
			host = makeHost();
			layer = host.dialoguePort;
			host.start();
			await settle();
			const prefix = h.store.read((db) =>
				h.dialogue.conversationTaskInTransaction(db, "main", "", {
					requireProvenance: true,
				}),
			)!;
			expect(prefix.messages.map((m) => m.content).join("\n")).not.toContain(
				"古い観測だけに属する話題",
			);
			expect(prefix.input?.sources).not.toContain(row.observationId);
			if (withCompletedWork) {
				const work = h.archived()[0]!;
				expect(prefix.messages.map((m) => m.content).join("\n")).not.toContain(
					`t${work.ref} `,
				);
				expect(h.archived()).toHaveLength(1);
			}
			expect(prefix.messages.map((m) => m.content).join("\n")).not.toContain(
				"古い話を受け取りました",
			);
			const before = selections;
			h.state.steps.push(...reply("今の話を受け取りました。"));
			const fresh = await h.say("今は別の景色を眺めるのが楽しみです。");
			await waitFor(() => selections > before && !host.status("main").busy);
			expect(requests.at(-1)?.prompt).not.toContain("古い観測に基づく好み");
			expect(requests.at(-1)?.sources).not.toContain(row.observationId);
			expect(memory.list().find((item) => item.id === topic.id)?.status).toBe(
				"active",
			);
			expect(
				h.store.read((db) =>
					memory.referenceInputs.readRunInTransaction(db, fresh.id),
				)?.sources,
			).not.toContain(row.observationId);
			expect(
				host
					.inspect("main")
					?.snapshot.observations.some((o) => o.text.includes("別の景色")),
			).toBe(true);
		} finally {
			await host.close();
			await h.close();
		}
	}, 15000);
}
