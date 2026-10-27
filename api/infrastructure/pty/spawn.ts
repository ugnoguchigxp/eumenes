import type { SpawnPty } from "./types";

/**
 * The person's login session: identity, paths, locale and the SSH agent. A login shell cannot
 * rebuild these itself (macOS sets `TMPDIR` and `SSH_AUTH_SOCK` per session).
 */
const SESSION = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"TMPDIR",
	"TZ",
	"LANG",
	"SSH_AUTH_SOCK",
	"__CF_USER_TEXT_ENCODING",
]);
const inherited = (key: string) => SESSION.has(key) || key.startsWith("LC_");

/**
 * Only the login session passes from the server's environment. Everything else stays in the
 * server: LARM tokens, cloud keys and `EUMENES_*` settings (including what Bun loaded from
 * `.env`), color settings, and the markers of a Claude Code session that launched the server.
 * A tool started in the PTY reads its own configuration (e.g. `~/.claude/settings.json`).
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

/**
 * Spawns through Bun's PTY support (POSIX only). The child sees a real xterm-256color terminal.
 * `overrides` are set on top of the login session (e.g. a pager for captured output).
 */
export function bunSpawnPty(
	cwd: string | undefined,
	overrides: Readonly<Record<string, string>> = {},
): SpawnPty {
	return ({ command, size, cwd: requested, onData }) => {
		const proc = Bun.spawn([...command], {
			cwd: requested ?? cwd,
			env: { ...childEnv(process.env), ...overrides },
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
