import { expect, test } from "bun:test";
import { z } from "zod";
import {
	setup,
	observation,
	proposal,
	receipt,
} from "../domains/coding-supervision/test/fixture";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../domains/scheduler";
import { createDelegatedTasks } from "./delegated-tasks";
import { superviseCodingExecution } from "./coding-supervision";
import { createApp } from "./app";
import { createClient } from "../../client";
import {
	createConversationService,
	migration as conversationMigration,
} from "../domains/conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../domains/dialogue";
import {
	createVoiceDialogue,
	migration as voiceMigration,
} from "../domains/voice-dialogue";
import type { LarmPort } from "../domains/larm";

test("the existing 60-second Scheduler monitor feeds supervision through the public task execution port", async () => {
	let delegated!: ReturnType<typeof createDelegatedTasks>,
		scheduler!: ReturnType<typeof createScheduler>;
	let reads = 0;
	const h = await setup({
		migrations: [schedulerMigration],
		tasksFactory: (c) => {
			scheduler = createScheduler(c.store, c.queue, { now: c.now });
			c.workflow.observe = async () =>
				observation({
					turnFinished: false,
					childrenStopped: false,
					evidenceComplete: false,
				});
			delegated = createDelegatedTasks({
				store: c.store,
				queue: c.queue,
				scheduler,
				enabled: true,
				now: c.now,
				changedInTransaction: c.changed,
				execution: superviseCodingExecution({
					store: c.store,
					tasks: () => delegated.tasks,
					supervision: c.supervision,
					workflow: c.workflow,
					base: {
						available: () => true,
						dispatch: async () => ({ accepted: true }),
						observe: async () => {
							reads++;
						},
						stop: async () => ({ stopped: true }),
					},
				}),
			});
			return delegated.tasks;
		},
	});
	try {
		await h.drain();
		expect(reads).toBe(0);
		h.advance(60000);
		await scheduler.tick();
		await h.drain();
		expect(reads).toBe(1);
		expect(h.calls()).toBe(0);
		h.advance(60000);
		await scheduler.tick();
		await h.drain();
		expect(reads).toBe(2);
		expect(h.calls()).toBe(0);
		const t = h.tasks.get(h.taskId).task;
		await h.tasks.stop(h.taskId, {
			requestId: crypto.randomUUID(),
			expectedRevision: t.revision,
			intent: "cancel",
		});
		await h.drain();
		h.advance(60000);
		await scheduler.tick();
		await h.drain();
		expect(reads).toBe(2);
		expect(h.tasks.get(h.taskId).task.state).toBe("cancelled");
		expect(h.reports.list(h.taskId).items.at(-1)?.kind).toBe("cancelled");
	} finally {
		delegated.close();
		await scheduler.close();
	}
});

test("supervision releases the shared inference slot while waiting on a CLI step", async () => {
	const h = await setup();
	let finish!: (r: ReturnType<typeof receipt>) => void;
	h.execute(
		(_i) =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	h.decision(proposal("run_checks"));
	await h.observe();
	for (let n = 0; n < 100 && !finish; n++) {
		await h.queue.tick();
		await Bun.sleep(2);
	}
	expect(h.steps).toHaveLength(1);
	expect(h.queue.stats().resources["inference.llm"]?.inUse).toBe(0);
	let foreground = false;
	h.queue.registerHandler({
		kind: "fixture.foreground",
		payloadVersions: [1],
		schema: z.strictObject({}),
		recovery: "interrupt",
		resourceKey: "larm.llm",
		prepareInTransaction: () => ({ status: "ready", input: null }),
		execute: async () => {
			foreground = true;
			return true;
		},
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
	await h.queue.enqueue({
		scope: "foreground",
		kind: "fixture.foreground",
		payload: {},
		dedupeKey: "first",
		lane: "interactive",
	});
	await h.queue.tick();
	for (let n = 0; n < 100 && !foreground; n++) await Bun.sleep(2);
	expect(foreground).toBe(true);
	finish(receipt(h.steps[0]!));
	await h.drain();
});

test("HTTP/client authenticate report and supervisor reads and omit private CLI text", async () => {
	const h = await setup({
		migrations: [
			schedulerMigration,
			conversationMigration,
			dialogueMigration,
			queueLinkMigration,
			voiceMigration,
		],
	});
	const scheduler = createScheduler(h.store, h.queue),
		conversation = createConversationService(h.store);
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => "fixture",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const dialogue = createDialogueService({
			store: h.store,
			queue: h.queue,
			conversation,
			larm,
		}),
		voice = createVoiceDialogue(h.store, dialogue, larm),
		token = "fixture-supervision-token";
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		tasks: h.tasks,
		codingSupervision: h.supervision,
		taskReports: h.reports,
		queue: h.queue,
		scheduler,
		conversation,
		dialogue,
		voice,
		larm,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
	});
	try {
		await h.observe(observation({ excerpt: "private CLI content" }));
		await h.drain();
		const client = createClient(`http://127.0.0.1:${server.port}`, token);
		const view = await client.taskSupervisor(h.taskId);
		expect(view?.decisionsUsed).toBe(1);
		expect(JSON.stringify(view)).not.toContain("private CLI content");
		expect(view).not.toHaveProperty("observation");
		expect((await client.taskReports(h.taskId)).items).toHaveLength(1);
		expect(
			(await app.request(`/api/tasks/${h.taskId}/supervisor`)).status,
		).toBe(401);
		expect(
			(
				await app.request(`/api/tasks/${h.taskId}/reports?after=-1`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(400);
		const t = h.tasks.get(h.taskId).task;
		await h.tasks.forget(h.taskId, {
			requestId: crypto.randomUUID(),
			expectedRevision: t.revision,
		});
		expect(
			(
				await app.request(`/api/tasks/${h.taskId}/reports`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(410);
	} finally {
		server.stop(true);
		await voice.close();
		await dialogue.close();
		await scheduler.close();
	}
});
