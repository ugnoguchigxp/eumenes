import type { SpawnPty } from "./types";

/** Color settings of the server's own (non-terminal) output; the child gets a full-color xterm. */
const SERVER_ONLY = new Set(["NO_COLOR", "FORCE_COLOR"]);
/**
 * Markers of a Claude Code session that started this server (e.g. `bun run dev` run by an agent).
 * A screen session is the person's own top-level session, so it must not look like its child.
 */
const PARENT_SESSION = new Set([
	"CLAUDECODE",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EXECPATH",
]);
const PARENT_SESSION_PREFIXES = [
	"EUMENES_",
	"CLAUDE_CODE_MESSAGING_",
	"CLAUDE_CODE_SESSION_",
];
const inherited = (key: string) =>
	!SERVER_ONLY.has(key) &&
	!PARENT_SESSION.has(key) &&
	!PARENT_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * The server's environment without Eumenes' own secrets (API token, keys, database), the
 * server's color settings, and the markers of a Claude Code session that launched the server.
 */
export function childEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...Object.fromEntries(
			Object.entries(env).filter(([key]) => inherited(key)),
		),
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};
}

/** Spawns through Bun's PTY support (POSIX only). The child sees a real xterm-256color terminal. */
export function bunSpawnPty(
	cwd: string | undefined,
	env: Record<string, string | undefined> = process.env,
): SpawnPty {
	return ({ command, size, cwd: requested, onData }) => {
		const proc = Bun.spawn([...command], {
			cwd: requested ?? cwd,
			env: childEnv(env),
			terminal: {
				cols: size.cols,
				rows: size.rows,
				name: "xterm-256color",
				data: (_terminal, bytes) => onData(bytes),
			},
		});
		return {
			write: (data) => proc.terminal?.write(data),
			resize: ({ cols, rows }) => proc.terminal?.resize(cols, rows),
			kill: (signal) => {
				proc.kill(signal);
				if (!signal) proc.terminal?.close();
			},
			close: () => proc.terminal?.close(),
			exited: proc.exited.then(
				() => proc.exitCode,
				() => null,
			),
		};
	};
}
