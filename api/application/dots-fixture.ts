import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasks } from "../domains/tasks";
import type { CreateTask } from "../domains/tasks/contracts";
import { createTaskReports } from "../domains/task-reports";
import { createCapabilities } from "../domains/capabilities";
import { createQueue } from "../domains/queue";
import { createEvents, createSecretBox, type Command } from "../domains/dots";
import { createConversationService } from "../domains/conversation";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { createDotsTasks } from "./dots-tasks";
export async function dotsFixture(now: () => number = Date.now) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dots-")),
		path = join(dir, "db");
	const store = openStore(path, migrations),
		capabilities = createCapabilities(store, new Set(["dots"])),
		queue = createQueue(store);
	const conversation = createConversationService(store);
	const reports = createTaskReports({ store, tasks: () => tasks, now });
	const deliveries: Array<{ body: string; headers: Record<string, string> }> =
		[];
	const secretBox = createSecretBox(join(dir, "keys"));
	const events = createEvents({
		store,
		queue,
		now,
		...secretBox,
		post: async (_url, body, headers) => {
			deliveries.push({ body, headers });
			const p = JSON.parse(body);
			return {
				status: 200,
				body:
					p.type === "verification"
						? JSON.stringify({ challenge: p.challenge })
						: "{}",
				retryAfter: null,
			};
		},
	});
	const dots = createDotsTasks({
		store,
		conversation,
		now,
		tasks: () => tasks,
		reports,
		capabilities: () => capabilities,
		commandPrepared: events.enqueueInTransaction,
	});
	const tasks = createTasks(store, {
		now,
		kinds: [dots.kind],
		changedInTransaction: dots.redactInTransaction,
		purgeInTransaction: (db, t) => {
			reports.purgeInTransaction(db, t.id);
			dots.purgeInTransaction(db, t.id);
		},
	});
	await capabilities.seed();
	const connection = await dots.config.configure({
		id: "dots",
		expectedRevision: 0,
		title: "fixture",
		enabled: true,
		oauth: null,
	});
	await dots.config.configure({
		id: "other",
		expectedRevision: 0,
		title: "other",
		enabled: true,
		oauth: null,
	});
	const project = await dots.config.configureProject({
		ref: "project",
		connectionRef: "dots",
		expectedRevision: 0,
		title: "fixture",
		nativeProjectId: "codex-project",
		hostId: "local",
		environment: "local",
		enabled: true,
	});
	const input = (): CreateTask => ({
		requestId: crypto.randomUUID(),
		kind: "orchestration",
		version: 1,
		title: "fixture work",
		request: "Implement the requested change",
		completionConditions: ["Tests pass"],
		startMode: "start",
		grant: {
			connectionRef: "dots",
			projectRef: "project",
			operations: ["read", "create_session", "edit", "check"],
			expiresAt: new Date(now() + 3600000).toISOString(),
			maxSessions: 3,
		},
	});
	const command = (taskId: string, kind?: Command["kind"]) => {
		const ids = dots.commands.list("dots", 0, 100).items;
		for (const { commandId } of [...ids].reverse()) {
			try {
				const c = dots.getCommand("dots", commandId);
				if (c.taskId === taskId && (!kind || c.kind === kind)) return c;
			} catch {}
		}
		throw new Error("fixture_command_missing");
	};
	const report = (
		c: Command,
		sourceSequence: number,
		kind: string,
		extra: Record<string, unknown> = {},
	) => ({
		reportId: crypto.randomUUID(),
		commandId: c.commandId,
		taskId: c.taskId,
		authorityEpoch: c.authorityEpoch,
		executionGeneration: c.executionGeneration,
		sourceSequence,
		kind,
		summary: "fixture report",
		...extra,
	});
	const session = {
		threadId: "session-1",
		projectId: "codex-project",
		hostId: "local",
		parentThreadId: null,
	};
	return {
		dir,
		path,
		store,
		queue,
		capabilities,
		conversation,
		reports,
		events,
		dots,
		tasks,
		connection,
		project,
		deliveries,
		input,
		command,
		report,
		session,
		async close() {
			await queue.close();
			capabilities.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
