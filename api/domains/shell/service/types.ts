import type { SqliteStore } from "../../../infrastructure/sqlite";
import type {
	SpawnPty,
	Pty,
	Listener,
	TerminalSize,
} from "../../../infrastructure/pty";
import type { ProjectResolver, SessionView } from "../contracts";
import type { createOutput } from "./output";
export type ShellOptions = {
	store?: SqliteStore;
	cwd?: string;
	projects?: ProjectResolver;
	shell?: string | null;
	spawn?: SpawnPty;
	onChange?: () => void;
	now?: () => Date;
	limit?: number;
	backlogBytes?: number;
	streamsPerSession?: number;
	heartbeatMs?: number;
	sweepMs?: number;
	killAfterMs?: number;
	stopConfirmMs?: number;
};
export type Session = SessionView & {
	attemptId?: string;
	pty: Pty;
	size: TerminalSize;
	backlog: Uint8Array[];
	backlogSize: number;
	listeners: Set<Listener>;
	exit: Promise<void>;
	output: ReturnType<typeof createOutput>;
	stopping?: Promise<boolean>;
};
