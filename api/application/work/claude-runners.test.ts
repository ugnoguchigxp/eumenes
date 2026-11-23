import { afterEach, expect, mock, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	claudeRunnerClient,
	type ClaudeDaemonConfig,
} from "../../domains/coding";
import { buildClaudeRunners } from "./claude-runners";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync("/tmp/eum-claude-runners-"));
	directories.push(root);
	const checkout = join(root, "conversation");
	const goalCheckout = join(root, "goal");
	const data = join(root, "data");
	for (const dir of [checkout, goalCheckout, data]) mkdirSync(dir);
	return {
		root,
		checkout,
		goalCheckout,
		data,
		dbPath: join(data, "store.sqlite"),
	};
}

function factories() {
	return {
		socket: mock(claudeRunnerClient),
		daemon: mock(({ root, workspace }: ClaudeDaemonConfig) => ({
			...claudeRunnerClient(join(root, "claude.sock"), workspace),
			probe: mock(async () => true),
		})),
		installed: mock(() => true),
	};
}

test("autostart keeps the existing runner and uses a separate protected daemon for a registered checkout", async () => {
	const { checkout, goalCheckout, data, dbPath } = fixture();
	const clients = factories();
	const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
		{ dbPath, env: {} },
		checkout,
		[{ ref: "goal", root: goalCheckout }],
		clients,
	);
	expect(clients.socket).not.toHaveBeenCalled();
	expect(clients.daemon.mock.calls[0]?.[0]).toEqual({
		root: join(data, "claude-code-runner"),
		workspace: checkout,
		protectedPaths: [
			data,
			join(checkout, ".env"),
			join(checkout, ".env.local"),
		],
	});
	const goal = clients.daemon.mock.calls[1]![0];
	expect(dirname(goal.root)).toBe(data);
	expect(goal.root).not.toBe(join(data, "claude-code-runner"));
	expect(goal.workspace).toBe(goalCheckout);
	expect(goal.protectedPaths).toEqual([
		data,
		join(checkout, ".env"),
		join(checkout, ".env.local"),
		join(goalCheckout, ".env"),
		join(goalCheckout, ".env.local"),
	]);
	expect(clients.daemon).toHaveBeenCalledTimes(2);
	expect(claudeRunner).not.toBe(goalClaudeRunners.get("goal"));
	expect(claudeRunner?.probe).toHaveBeenCalledTimes(1);
	expect(goalClaudeRunners.get("goal")?.probe).toHaveBeenCalledTimes(1);
	const reopened = factories();
	await buildClaudeRunners(
		{ dbPath, env: {} },
		checkout,
		[{ ref: "goal", root: goalCheckout }],
		reopened,
	);
	expect(reopened.daemon.mock.calls[1]?.[0].root).toBe(goal.root);
});

test("the same physical checkout shares one daemon and one probe", async () => {
	const { root, checkout, dbPath } = fixture();
	const alias = join(root, "alias");
	symlinkSync(checkout, alias);
	const clients = factories();
	const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
		{ dbPath, env: {} },
		checkout,
		[{ ref: "goal", root: alias }],
		clients,
	);
	expect(claudeRunner).toBeDefined();
	expect(claudeRunner).toBe(goalClaudeRunners.get("goal"));
	expect(clients.daemon).toHaveBeenCalledTimes(1);
	expect(claudeRunner?.probe).toHaveBeenCalledTimes(1);
});

test("multiple references share a canonical runner but distinct checkouts keep separate runners", async () => {
	const { root, checkout, goalCheckout, dbPath } = fixture();
	const second = join(root, "second");
	mkdirSync(second);
	const alias = join(root, "alias");
	symlinkSync(goalCheckout, alias);
	const clients = factories();
	const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
		{ dbPath, env: {} },
		checkout,
		[
			{ ref: "first", root: goalCheckout },
			{ ref: "alias", root: alias },
			{ ref: "second", root: second },
		],
		clients,
	);
	expect(goalClaudeRunners.get("first")).toBe(goalClaudeRunners.get("alias"));
	expect(goalClaudeRunners.get("second")).not.toBe(
		goalClaudeRunners.get("first"),
	);
	expect(goalClaudeRunners.get("second")).not.toBe(claudeRunner);
	expect(clients.daemon).toHaveBeenCalledTimes(3);
});

test("an unready explicit runner keeps its own workspace identity for later probes", async () => {
	const { root, checkout, goalCheckout, dbPath } = fixture();
	const second = join(root, "second");
	mkdirSync(second);
	const clients = factories();
	let serviceWorkspace: string | null = null;
	const socket = join(root, "external.sock");
	clients.socket.mockImplementation((socket, workspace) => {
		let ready = false;
		return {
			...claudeRunnerClient(socket, workspace),
			ready: () => ready,
			probe: async () => (ready = workspace === serviceWorkspace),
		};
	});
	const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
		{ dbPath, env: { EUMENES_CLAUDE_WORK_RUNNER_SOCKET: socket } },
		checkout,
		[
			{ ref: "first", root: goalCheckout },
			{ ref: "second", root: second },
		],
		clients,
	);
	const first = goalClaudeRunners.get("first")!;
	const other = goalClaudeRunners.get("second")!;
	expect(first.ready()).toBe(false);
	serviceWorkspace = goalCheckout;
	expect(await first.probe()).toBe(true);
	expect(await other.probe()).toBe(false);
	expect(await claudeRunner?.probe()).toBe(false);
	expect(clients.daemon).not.toHaveBeenCalled();
});

test("an explicit socket still verifies the workspace and never autostarts a daemon", async () => {
	const { root, checkout, goalCheckout, dbPath } = fixture();
	const socket = join(root, "external.sock");
	const server = Bun.serve({
		unix: socket,
		fetch: () =>
			Response.json({ ready: true, supervised: true, workspace: goalCheckout }),
	});
	try {
		chmodSync(socket, 0o600);
		const clients = factories();
		const { claudeRunner, goalClaudeRunners } = await buildClaudeRunners(
			{ dbPath, env: { EUMENES_CLAUDE_WORK_RUNNER_SOCKET: socket } },
			checkout,
			[{ ref: "goal", root: goalCheckout }],
			clients,
		);
		expect(claudeRunner?.ready()).toBe(false);
		expect(goalClaudeRunners.get("goal")?.ready()).toBe(true);
		expect(goalClaudeRunners.get("goal")?.supportsSupervised()).toBe(true);
		expect(clients.socket.mock.calls).toEqual([
			[socket, checkout],
			[socket, goalCheckout],
		]);
		expect(clients.daemon).not.toHaveBeenCalled();
		expect(clients.installed).not.toHaveBeenCalled();
	} finally {
		await server.stop(true);
	}
});

test("disabled, in-memory, and unavailable autostart start neither daemon", async () => {
	const { checkout, goalCheckout, dbPath } = fixture();
	for (const [config, installed] of [
		[{ dbPath, env: { EUMENES_CLAUDE_WORK_RUNNER_AUTOSTART: "0" } }, true],
		[{ dbPath: ":memory:", env: {} }, true],
		[{ dbPath, env: {} }, false],
	] as const) {
		const clients = factories();
		clients.installed.mockReturnValue(installed);
		expect(
			await buildClaudeRunners(
				config,
				checkout,
				[{ ref: "goal", root: goalCheckout }],
				clients,
			),
		).toEqual({
			claudeRunner: undefined,
			goalClaudeRunners: new Map(),
		});
		expect(clients.socket).not.toHaveBeenCalled();
		expect(clients.daemon).not.toHaveBeenCalled();
	}
});
