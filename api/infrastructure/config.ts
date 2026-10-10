import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveLarmToken } from "./auth-config";

/**
 * The single typed reading of the process environment (ARC-12). `loadConfig`
 * runs once at startup; everything else receives values from the result.
 *
 * Rules
 * - An empty or whitespace-only string means "unset" (the shell idiom `VAR= cmd` clears a value).
 * - A malformed value fails startup with `config_invalid:<NAME>`; the value is
 *   never put in the message, so a bad secret cannot leak through the error.
 * - Flags accept 1/true/on and 0/false/off (case-insensitive) and nothing else.
 * - The result holds credentials (`apiToken`, `larmToken`, `worldCursorSecret`,
 *   `env`): never hand a Config to a logger.
 *
 * `env` is the raw snapshot, kept for Settings, whose credential references
 * (`envRef`) name arbitrary variables at runtime, and for `LARM_*` /
 * `EUMENES_TTS_VOICE` / `EUMENES_KEY_DIR` / `EUMENES_SECRET_KEY` /
 * `EUMENES_ENV_REF_ALLOWLIST`, which Settings reads itself.
 */
export type WorldMode = "off" | "protect" | "on";

const text = z.string().optional();
const flag = (fallback: boolean) =>
	z
		.preprocess(
			(value) =>
				typeof value === "string" ? value.trim().toLowerCase() : value,
			z.enum(["1", "true", "on", "0", "false", "off"]).optional(),
		)
		.transform((value) =>
			value === undefined ? fallback : ["1", "true", "on"].includes(value),
		);
/** off (default) | protect | on; 0/false mean off and 1/true mean on. */
const worldMode = z
	.preprocess(
		(value) => {
			if (typeof value !== "string") return value;
			const raw = value.trim().toLowerCase();
			if (raw === "0" || raw === "false") return "off";
			if (raw === "1" || raw === "true") return "on";
			return raw;
		},
		z.enum(["off", "protect", "on"]).optional(),
	)
	.transform((value): WorldMode => value ?? "off");

/** Strict decimal digits only: no sign, exponent, hex, or fraction. */
const integer = (max?: number) =>
	z
		.string()
		.trim()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(
			max === undefined
				? z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
				: z.number().int().min(0).max(max),
		)
		.optional();

const schema = z.object({
	EUMENES_DB: text,
	EUMENES_LOG_FILE: text,
	EUMENES_LOG_LEVEL: text,
	EUMENES_HOST: text,
	EUMENES_PORT: integer(65_535),
	EUMENES_ORIGIN: text,
	EUMENES_ATTITUDE_DATASET: text,
	EUMENES_MEMORY_JOURNAL: text,
	EUMENES_WORLD_JOURNAL: text,
	EUMENES_CODING_RUNNER_CONFIG: text,
	EUMENES_WORLD: worldMode,
	EUMENES_WORLD_POLL_MS: integer(),
	EUMENES_WORLD_CURSOR_SECRET: text,
	EUMENES_TOOLCHAIN_ENABLED: flag(true),
	EUMENES_HISTORY_TOOLS_ENABLED: flag(true),
	EUMENES_WEB_RESEARCH_TOOLS_ENABLED: flag(true),
	EUMENES_DELEGATED_TASKS_ENABLED: flag(false),
	EUMENES_API_TOKEN: text,
});

export type Config = {
	dbPath: string;
	/** Undefined when the file log is disabled (`EUMENES_LOG_FILE=-`). */
	logFile: string | undefined;
	logLevel: string | undefined;
	host: string;
	port: number;
	origin: string;
	/** Explicit credential only; Settings-independent resolution stays in auth-config. */
	apiToken: string | undefined;
	larmToken: string | undefined;
	attitudeDatasetPath: string;
	memoryJournalPath: string;
	/** Undefined: the World journal sits beside the Memory journal. */
	worldJournalPath: string | undefined;
	codingRunnerConfig: string | undefined;
	worldMode: WorldMode;
	/** Already clamped to the 1000 ms floor. */
	worldPollMs: number | undefined;
	worldCursorSecret: string | undefined;
	toolchainEnabled: boolean;
	historyToolsEnabled: boolean;
	webResearchToolsEnabled: boolean;
	delegatedTasksEnabled: boolean;
	env: Readonly<Record<string, string | undefined>>;
};

/** Shared with `worldModeFromEnv`: undefined/empty is off, a typo throws. */
export function parseWorldMode(raw: string | undefined): WorldMode {
	const parsed = schema.shape.EUMENES_WORLD.safeParse(
		raw === undefined || raw.trim() === "" ? undefined : raw,
	);
	if (!parsed.success) throw new Error("world_mode_invalid");
	return parsed.data;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
	const present = Object.fromEntries(
		Object.entries(env).filter(
			([, value]) => value !== undefined && value.trim() !== "",
		),
	);
	const parsed = schema.safeParse(present);
	if (!parsed.success)
		throw new Error(
			`config_invalid:${String(parsed.error.issues[0]?.path[0])}`,
		);
	const v = parsed.data;
	const dbPath = v.EUMENES_DB ?? "./data/eumenes.sqlite3";
	const dataDir = dirname(dbPath);
	return {
		dbPath,
		logFile:
			v.EUMENES_LOG_FILE === "-"
				? undefined
				: (v.EUMENES_LOG_FILE ?? join(dataDir, "logs/api.jsonl")),
		logLevel: v.EUMENES_LOG_LEVEL,
		host: v.EUMENES_HOST ?? "127.0.0.1",
		port: v.EUMENES_PORT ?? 8787,
		origin: v.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
		apiToken: v.EUMENES_API_TOKEN,
		larmToken: resolveLarmToken(present),
		attitudeDatasetPath:
			v.EUMENES_ATTITUDE_DATASET ??
			join(dataDir, "attitude-dataset/dataset.sqlite3"),
		memoryJournalPath:
			v.EUMENES_MEMORY_JOURNAL ?? join(dataDir, "memory-forget-journal.jsonl"),
		worldJournalPath: v.EUMENES_WORLD_JOURNAL,
		codingRunnerConfig: v.EUMENES_CODING_RUNNER_CONFIG,
		worldMode: v.EUMENES_WORLD,
		worldPollMs:
			v.EUMENES_WORLD_POLL_MS === undefined
				? undefined
				: Math.max(1000, v.EUMENES_WORLD_POLL_MS),
		worldCursorSecret: v.EUMENES_WORLD_CURSOR_SECRET,
		toolchainEnabled: v.EUMENES_TOOLCHAIN_ENABLED,
		historyToolsEnabled: v.EUMENES_HISTORY_TOOLS_ENABLED,
		webResearchToolsEnabled: v.EUMENES_WEB_RESEARCH_TOOLS_ENABLED,
		delegatedTasksEnabled: v.EUMENES_DELEGATED_TASKS_ENABLED,
		env,
	};
}

/** The only place the process environment is read. */
export const loadProcessConfig = (): Config => loadConfig(process.env);
