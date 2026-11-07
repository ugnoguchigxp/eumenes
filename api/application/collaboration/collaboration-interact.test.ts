import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createBrowser, createBrowserInteract } from "../../domains/browser";
import {
	FakeEncoder,
	FakeFiles,
	fakeResolver,
} from "../../domains/browser/test/fakes";
import {
	InteractFakeDriver,
	done,
	part,
} from "../../domains/browser/test/interact.fixture";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { waitFor } from "../../infrastructure/wait-for";
import { registerBrowserEffects } from "../browser/browser-effects";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

test("interact pilot stays unavailable by default; an enabled fixture returns capture approval and its result to the same specialist and forget erases it", async () => {
	const driver = new InteractFakeDriver(),
		files = new FakeFiles();
	const request = "https://example.com の画面を撮影して、一緒に確認して";
	let step = 0;
	const traces: string[] = [];
	const observations: any[] = [];
	let service!: ReturnType<typeof createBrowserInteract>;
	const h = await harness({
		memory: true,
		pipelines: true,
		browser: (store, queue) => {
			const legacy = createBrowser({
				store,
				queue,
				driver: new InteractFakeDriver(),
				files: new FakeFiles(),
				encoder: new FakeEncoder(),
				webOrigins: [],
				resolveHost: fakeResolver(),
			});
			let guard: (db: Database, source: unknown) => boolean = () => false;
			service = createBrowserInteract({
				store,
				queue,
				now: Date.now,
				createDriver: () => driver,
				files,
				encoder: new FakeEncoder(),
				resolveHost: fakeResolver(),
				webOrigins: [],
				skill: {
					ref: "skill:browser.interact.operator@1",
					digest: `sha256:${"a".repeat(64)}`,
				},
				reviewInstructions: "Use actual evidence",
				validSource: (db, source) =>
					guard(db, (source as { source: unknown }).source),
				infer: async (input) =>
					input.purpose === "completion_review"
						? JSON.stringify({
								outcome: "achieved",
								explanation: "capture confirmed",
							})
						: ++step === 1
							? part("page.capture", { range: "viewport", item: null })
							: done(input),
			});
			return {
				service: legacy,
				effects: registerBrowserEffects({ queue, service: legacy }),
				requests: { userMessageInTransaction: () => null },
				interact: {
					...service,
					setCollaborationSourceGuard: (next) => {
						guard = next;
					},
				},
			};
		},
		discoveryTarget: () => "collaborate_interact",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate((c) => c.id === "collaboration.interact", request, {
				announcement: "画面を確認します。",
				impact: "create",
			})(messages),
		specialist: (messages) => {
			traces.push(messages.map((m) => m.content).join("\n"));
			const ref = JSON.parse(messages[1]!.content.split("REFERENCE=")[1]!);
			if (ref.currentWork.hostEvent) {
				observations.push(ref.currentWork.hostEvent);
				return {
					action: "reply",
					text: ref.currentWork.hostEvent.question
						? "画面を撮影してよいですか。"
						: "画面の撮影を確認しました。",
				};
			}
			const current = ref.currentWork;
			if (current.child?.question)
				return {
					action: "invoke",
					tool: "collaboration.interact.answer",
					arguments: {
						questionId: current.child.question.id,
						childRevision: current.child.revision,
						input: { approved: true },
					},
					text: "承認を伝えました。",
				};
			return {
				action: "invoke",
				tool: "collaboration.interact.start",
				arguments: {
					expectedRevision: current.revision,
					startUrl: "https://example.com",
				},
				text: "画面の確認を始めます。",
			};
		},
	});
	const say = async (text: string) => {
		const r = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		expect(r.status).toBe(202);
		const run = await r.json();
		const end = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 6000 });
		expect(end?.status, JSON.stringify(end)).toBe("completed");
		return end!;
	};
	const available = () =>
		h.store
			.read((db) => h.routing.catalogInTransaction(db))
			.find((c) => c.id === "collaboration.interact")?.runtime.binding
			?.available;
	try {
		expect(available()).toBe(false);
		// Explicit synthetic pilot only. Product availability remains disabled.
		h.toolchain.registry.get(
			"adapter:browser.interact@1",
		)!.availableInTransaction = () => true;
		// The catalog reads an adapter's availability once per synchronous pass; the swap is seen from the next one.
		await Bun.sleep(0);
		expect(available()).toBe(true);
		const initial = await say(request);
		expect(h.dialogue.answerText(initial.id), traces.at(-1)?.slice(-3500)).toBe(
			"画面の確認を始めます。",
		);
		const owner = h.dialogue.specialistSession("main")!;
		await waitFor(() => observations.length === 1, { timeout: 6000 });
		expect(observations[0].question.approval).toBe(true);
		expect(driver.calls).not.toContain("screenshot");
		const childId = observations[0].id;
		await expect(
			h.store.write((db) =>
				service.answerInTransaction(db, CONVERSATION_DEFAULT_PRINCIPAL, {
					runId: childId,
					conversationId: "main",
					questionId: observations[0].question.id,
					generation: observations[0].question.generation,
					expectedRevision: observations[0].revision,
					approved: true,
				}),
			),
		).rejects.toThrow("parent_answer_required");
		await waitFor(
			() => h.dialogue.specialistSession("main")?.activeRunId === null,
			{ timeout: 3000 },
		);
		const answer = await say("撮影してよいです");
		await waitFor(() => observations.length === 2, { timeout: 6000 });
		expect(observations[1].status).toBe("completed");
		expect(h.dialogue.specialistSession("main")?.id).toBe(owner.id);
		expect(driver.calls.filter((c) => c === "screenshot")).toHaveLength(1);
		expect(files.final.size).toBe(1);
		expect(
			h.store
				.read((db) => h.conversation.messagesInTransaction(db, "main"))
				.filter((m) => m.role === "user"),
		).toHaveLength(2);
		await h.memory!.forget({
			conversationId: "main",
			itemIds: [],
			messageIds: [answer.inputMessageId],
		});
		service.afterCommit();
		expect(() =>
			h.store.read((db) =>
				service.statusInTransaction(
					db,
					CONVERSATION_DEFAULT_PRINCIPAL,
					"main",
					childId,
				),
			),
		).toThrow("not_found");
		await waitFor(() => files.final.size === 0, { timeout: 3000 });
	} finally {
		await service.close();
		await h.close();
	}
}, 15000);
