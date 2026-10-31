import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { SpawnPty } from "../../../infrastructure/pty";
import { migrations, createShell } from "..";
import type { ShellOptions } from "../service/types";
import type { EnqueueRun } from "../contracts";
export function fakePty(ignore = false) {
	const spawned: Array<{
		command: readonly string[];
		cwd?: string;
		writes: string[];
		signals: string[];
		data(text: string): void;
		exit(code: number | null): void;
	}> = [];
	const spawn: SpawnPty = ({ command, cwd, onData }) => {
		let exit!: (code: number | null) => void;
		const exited = new Promise<number | null>((resolve) => {
			exit = resolve;
		});
		const entry = {
			command,
			cwd,
			writes: [] as string[],
			signals: [] as string[],
			data: (text: string) => onData(new TextEncoder().encode(text)),
			exit,
		};
		spawned.push(entry);
		return {
			write: (data) => entry.writes.push(data),
			resize: () => {},
			kill: (signal) => {
				entry.signals.push(signal ?? "close");
				if (!ignore || !signal) exit(null);
			},
			close: () => {},
			exited,
		};
	};
	return { spawn, spawned };
}
export function harness(options: ShellOptions = {}, pty = fakePty()) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-shell-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "CREATE TABLE queue_stub(id TEXT)" },
		...migrations,
	]);
	const shell = createShell({
		store,
		cwd: dir,
		shell: "/bin/sh",
		spawn: pty.spawn,
		sweepMs: 5,
		killAfterMs: 5,
		stopConfirmMs: 20,
		...options,
	});
	const view = (id: string) =>
		store.read((db) => shell.runInTransaction(db, id));
	return {
		dir,
		store,
		shell,
		pty,
		view,
		enqueue: (input: EnqueueRun) =>
			store.write((db) => shell.enqueueRunInTransaction(db, input)),
		async close() {
			shell.closeAll();
			await Bun.sleep(0);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export const request = (over: Partial<EnqueueRun> = {}): EnqueueRun => ({
	attemptId: crypto.randomUUID(),
	projectId: "eumenes",
	command: "printf test",
	task: "確認",
	origin: "execution",
	conversationId: "main",
	...over,
});
