import type { createClient } from "../../client";

export type Client = ReturnType<typeof createClient>;

/** Parsed command line shared by every command. `positional` excludes the command name. */
export type CliArgs = {
	historyOptions?: {
		from?: string;
		until?: string;
		speaker?: "user" | "assistant";
	};
	historyBefore?: number;
	historyAfter?: number;
	command: string;
	positional: string[];
	json: boolean;
	wait: boolean;
	fresh: boolean;
	stable: boolean;
	readPages: boolean;
	explicitRequestId: string | undefined;
	conversationId: string;
	listCursor: string | undefined;
	listLimit: number | undefined;
};

export type CliIo = {
	client: Client;
	/** Writes a result to stdout in the format selected by `--json`. */
	show(value: unknown): void;
	/** Writes a diagnostic line to stderr. */
	error(message: string): void;
};

/** Runs one command and resolves with its exit code. Failures are thrown. */
export type CommandRun = (args: CliArgs, io: CliIo) => Promise<number>;

export const USAGE =
	"usage: bun cli/index.ts status|requirements list|requirements show <id>|requirements import <id> <file.json> <state-token-or-new>|requirements disable <id> <token>|requirements enable <id> <token>|web search|web read|web run|web cancel|web cache|web clear|research-routes ...|memory ...|send [text] [--wait] [--json] [--request-id UUID]|history [id]|history-search [query] [--from ISO --until ISO --speaker user|assistant --cursor UUID --limit N]|history-read <messageRef> [--before N --after N --cursor UUID]|run <id>|cancel <id>";
