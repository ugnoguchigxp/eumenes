import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as browserMigrations } from "../../domains/browser";
import {
	FakeDriver,
	fakeBrave,
	until,
	WEB,
} from "../../domains/browser/test/fakes";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../domains/conversation";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import type { Config } from "../../infrastructure/config";
import { openStore } from "../../infrastructure/sqlite";
import {
	browserAnnouncement,
	browserDirectories,
	browserRequests,
	buildBrowser,
} from "./browser-composition";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});

function setup(extra: Partial<Parameters<typeof buildBrowser>[1]> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-composition-"));
	const dbPath = join(dir, "data", "eumenes.sqlite3");
	const store = openStore(dbPath, [
		...queueMigrations,
		...conversationMigrations,
		...browserMigrations,
	]);
	const queue = createQueue(store, { pollMs: 5 });
	const conversation = createConversationService(store);
	const driver = new FakeDriver();
	const paths: Array<string | undefined> = [];
	const assembly = buildBrowser({ dbPath, origin: WEB } as Config, {
		core: { store, queue },
		conversation,
		createDriver(path) {
			paths.push(path);
			return driver;
		},
		...extra,
	});
	queue.start();
	cleanup.push(async () => {
		await assembly.close();
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	/** A real executable file under its own folder: the Brave setting only accepts existing files. */
	const brave = (name: string) => {
		const folder = join(dir, name);
		mkdirSync(folder);
		return fakeBrave(folder);
	};
	return { dir, dbPath, store, conversation, assembly, driver, paths, brave };
}

test("MCP output and captures live in two managed folders next to the database", () => {
	expect(browserDirectories("/var/eumenes/data/eumenes.sqlite3")).toEqual({
		outputDir: "/var/eumenes/data/browser/mcp",
		captureDir: "/var/eumenes/data/browser/captures",
	});
});

test("a connection builds the driver with the path saved at that moment", async () => {
	const { assembly, paths, driver, brave } = setup();
	const { service } = assembly;
	const one = brave("one");
	const two = brave("two");
	await expect(service.connect()).rejects.toThrow("browser_not_configured");
	await service.setting.save(one);
	await service.connect();
	await until(() => service.connection().state === "connected");
	expect(paths).toEqual([one]);
	await service.disconnect();
	await service.setting.save(two);
	await service.connect();
	await until(() => service.connection().state === "connected");
	expect(paths).toEqual([one, two]);
	expect(driver.connectCount).toBe(2);
});

test("closing the assembly stops the child and records nothing", async () => {
	const { assembly, driver, brave } = setup();
	await assembly.service.setting.save(brave("one"));
	await assembly.service.connect();
	await until(() => assembly.service.connection().state === "connected");
	await assembly.close();
	expect(driver.calls).toContain("disconnect");
	await Bun.sleep(20);
	// The row still says connected: the next start settles it as a backend restart.
	expect(assembly.service.connection().state).toBe("connected");
});

test("a completion is added to its conversation once, under a stable id", async () => {
	const { store, conversation } = setup();
	const announce = browserAnnouncement(conversation);
	const notice = {
		id: "browser-capture:1:local_ready",
		conversationId: "c1",
		message: "ブラウザの画像を保存しました。",
		at: "2026-10-18T09:00:00.000Z",
	};
	await store.write((db) => {
		announce(db, notice);
		announce(db, notice);
	});
	const messages = store.read((db) =>
		conversation.messagesInTransaction(db, "c1"),
	);
	expect(messages.map((m) => [m.id, m.role, m.text])).toEqual([
		[
			"browser-notice:browser-capture:1:local_ready",
			"assistant",
			"ブラウザの画像を保存しました。",
		],
	]);
});

const idle = async () => undefined;
const inference = {
	releaseTaskSession: idle,
	countControlTokens: () => null,
	savedLlmContextWindow: () => null,
};

test("tasks can be started only where the model calls are assembled", async () => {
	const without = setup();
	await without.assembly.service.setting.save(without.brave("one"));
	await without.assembly.service.connect();
	await until(
		() => without.assembly.service.connection().state === "connected",
	);
	await expect(
		without.assembly.service.startTask({
			owner: "o",
			conversationId: "c1",
			origin: "screen",
			requestId: crypto.randomUUID(),
			request: "開く",
		}),
	).rejects.toThrow("browser_task_runner_missing");
	const wired = setup({ inference, capabilities: () => null });
	await wired.assembly.service.setting.save(wired.brave("one"));
	await wired.assembly.service.connect();
	await until(() => wired.assembly.service.connection().state === "connected");
	const task = await wired.assembly.service.startTask({
		owner: "o",
		conversationId: "c1",
		origin: "screen",
		requestId: crypto.randomUUID(),
		request: "開く",
	});
	// The registry is read when the first step runs; without one the task fails with a safe code.
	await until(
		() =>
			wired.assembly.service.taskStatus("o", task.taskId).state === "failed",
	);
	expect(wired.assembly.service.taskStatus("o", task.taskId).errorCode).toBe(
		"capability_unavailable",
	);
});

test("the adapter reads only a saved user message of the conversation", async () => {
	const { store, conversation } = setup();
	const requests = browserRequests(conversation);
	await store.write((db) => {
		conversation.appendInTransaction(db, {
			id: "u1",
			conversationId: "c1",
			role: "user",
			text: "このタブで探して",
			createdAt: "2026-10-18T09:00:00.000Z",
			runId: null,
		});
		conversation.appendInTransaction(db, {
			id: "a1",
			conversationId: "c1",
			role: "assistant",
			text: "了解しました",
			createdAt: "2026-10-18T09:00:01.000Z",
			runId: null,
		});
	});
	store.read((db) => {
		expect(requests.userMessageInTransaction(db, "u1")).toBe(
			"このタブで探して",
		);
		expect(requests.userMessageInTransaction(db, "a1")).toBeNull();
		expect(requests.userMessageInTransaction(db, "missing")).toBeNull();
	});
});
