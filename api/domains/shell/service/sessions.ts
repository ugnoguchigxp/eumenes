import {
	appendBacklog,
	bunSpawnPty,
	outputStream,
	type TerminalSize,
} from "../../../infrastructure/pty";
import type { SessionView } from "../contracts";
import { createOutput } from "./output";
import type { Session, ShellOptions } from "./types";

export function createSessions(
	options: ShellOptions,
	shell: string | null,
	changed: () => void,
) {
	const entries = new Map<string, Session>();
	const spawn = options.spawn ?? bunSpawnPty(options.cwd);
	const runSpawn =
		options.spawn ??
		bunSpawnPty(options.cwd, {
			...process.env,
			PAGER: "cat",
			GIT_PAGER: "cat",
		});
	const now = () => (options.now?.() ?? new Date()).toISOString();
	const find = (id: string) => {
		const s = entries.get(id);
		if (!s) throw new Error("shell_not_found");
		return s;
	};
	function launch(
		id: string,
		title: string,
		kind: "shell" | "run",
		command: readonly string[],
		size: TerminalSize,
		cwd?: string,
	) {
		const previous = entries.get(id);
		if (!shell) throw new Error("shell_unavailable");
		if (
			[...entries.values()].filter((s) => s.status === "running").length >=
			(options.limit ?? 4)
		)
			throw new Error("shell_limit_reached");
		const s = {
			id,
			title,
			kind,
			status: "running",
			run: (previous?.run ?? 0) + 1,
			size,
			startedAt: now(),
			backlog: [],
			backlogSize: 0,
			listeners: new Set(),
			output: createOutput(),
		} as unknown as Session;
		s.pty = (kind === "run" ? runSpawn : spawn)({
			command,
			cwd,
			size,
			onData(bytes) {
				s.output.add(bytes);
				const copy = appendBacklog(
					s,
					bytes,
					options.backlogBytes ?? 512 * 1024,
				);
				for (const listener of s.listeners) listener.data(copy);
			},
		});
		entries.set(id, s);
		s.exit = s.pty.exited.then((code) => {
			try {
				s.pty.close();
			} finally {
				s.output.finish();
				s.status = "exited";
				s.exitCode = code;
				s.endedAt = now();
				for (const listener of s.listeners) listener.end();
				s.listeners.clear();
				changed();
			}
		});
		// Resource release failures cannot leave an exit or a stop waiting forever.
		s.exit = s.exit.catch(() => {
			changed();
		});
		changed();
		return s;
	}
	const view = (s: Session): SessionView => ({
		id: s.id,
		title: s.title,
		kind: s.kind,
		status: s.status,
		run: s.run,
		startedAt: s.startedAt,
		...(s.endedAt ? { endedAt: s.endedAt } : {}),
		...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
	});
	function terminate(s: Session): Promise<boolean> {
		if (s.stopping) return s.stopping;
		if (s.status === "exited") return Promise.resolve(true);
		const stopping = (async () => {
			s.pty.kill("SIGTERM");
			const kill = setTimeout(() => {
				if (s.status === "running") s.pty.kill("SIGKILL");
			}, options.killAfterMs ?? 5000);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					s.exit.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(
							() => resolve(false),
							options.stopConfirmMs ?? 10_000,
						);
					}),
				]);
			} finally {
				clearTimeout(kill);
				clearTimeout(timer);
			}
		})();
		s.stopping = stopping;
		return stopping;
	}
	return {
		entries,
		find,
		view,
		terminate,
		start(size: TerminalSize, title = "CLI") {
			// One screen shell; concurrent auto-open requests reconnect to the same session.
			const current = [...entries.values()].find((s) => s.kind === "shell");
			return current
				? view(current)
				: view(
						launch(
							crypto.randomUUID(),
							title,
							"shell",
							[shell!, "-l"],
							size,
							options.cwd,
						),
					);
		},
		restart(id: string, size: TerminalSize) {
			const s = find(id);
			if (s.kind === "run") throw new Error("shell_run_not_restartable");
			if (s.status === "running") throw new Error("shell_running");
			return view(
				launch(id, s.title, "shell", [shell!, "-l"], size, options.cwd),
			);
		},
		launchRun(id: string, task: string, command: string, cwd: string) {
			const size = [...entries.values()].find((s) => s.kind === "shell")
				?.size ?? { cols: 120, rows: 32 };
			const s = launch(
				id,
				task,
				"run",
				[shell!, "-l", "-c", command],
				size,
				cwd,
			);
			for (const old of entries.values())
				if (old.kind === "run" && old !== s && old.status === "exited")
					entries.delete(old.id);
			return s;
		},
		input(id: string, data: string) {
			const s = find(id);
			if (s.status !== "running") throw new Error("shell_not_running");
			s.pty.write(data);
		},
		resize(id: string, size: TerminalSize) {
			const s = find(id);
			if (s.status !== "running") return;
			s.pty.resize(size);
			s.size = size;
		},
		stream(id: string, signal: AbortSignal) {
			const s = find(id);
			if (s.listeners.size >= (options.streamsPerSession ?? 4))
				throw new Error("shell_stream_capacity");
			return outputStream(s, signal, options.heartbeatMs ?? 15_000);
		},
		closeAll() {
			for (const s of entries.values()) {
				for (const l of s.listeners) l.end();
				s.listeners.clear();
				if (s.status === "running") s.pty.kill();
			}
			entries.clear();
		},
	};
}
