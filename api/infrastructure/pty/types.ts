export type TerminalSize = { cols: number; rows: number };

/** A spawned PTY process. Its output arrives through `onData` given at spawn. */
export type Pty = {
	write(data: string): void;
	resize(size: TerminalSize): void;
	/**
	 * Without a signal: ends the process and closes the terminal. With one: only sends the
	 * signal (the exit is awaited through `exited`).
	 */
	kill(signal?: "SIGTERM" | "SIGKILL"): void;
	/** Releases the PTY after the process exited. */
	close(): void;
	/** Resolves with the process exit code (null when it was signalled). */
	exited: Promise<number | null>;
};
export type SpawnPty = (request: {
	command: readonly string[];
	size: TerminalSize;
	/** Working directory of the project; the default of the spawner when absent. */
	cwd?: string;
	onData(bytes: Uint8Array): void;
}) => Pty;
