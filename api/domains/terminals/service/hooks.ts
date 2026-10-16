import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Claude Code reports its own progress through hooks given at launch (`--settings`), so the host
 * never parses the screen. Each run gets a fresh token that only reports for that session; the
 * API token never reaches the child.
 */
export const HOOK_PATH = "/hooks/terminals";
export const HOOK_TOKEN_HEADER = "x-eumenes-hook-token";
/** The last answer kept for the report; longer text is cut. */
export const LAST_MESSAGE_CHARS = 4000;

/** Hooks the host listens to, in the order they are written into the settings file. */
const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PostToolUse",
	"Notification",
	"Stop",
] as const;

export const hookPayloadSchema = z.object({
	hook_event_name: z.enum(HOOK_EVENTS),
	/** Claude Code's conversation id; must be the one the PTY was launched with. */
	session_id: z.string().optional(),
	/** One turn: UserPromptSubmit, PostToolUse, Notification and Stop of it share this value. */
	prompt_id: z.string().optional(),
	/** UserPromptSubmit: the submitted request (matches a handed-over request to its turn). */
	prompt: z.string().optional(),
	last_assistant_message: z.string().optional(),
	/** Notification: `permission_prompt` / `elicitation_dialog` wait for the person. */
	notification_type: z.string().optional(),
	/** SessionStart: `startup`, `resume`, `clear` or `compact`. */
	source: z.string().optional(),
	/** PostToolUse: the tool and its input (only file paths are read from it). */
	tool_name: z.string().optional(),
	tool_input: z.unknown().optional(),
});
export type HookPayload = z.infer<typeof hookPayloadSchema>;

/** Tools whose file path is recorded as a change of the request. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** The file an edit tool changed, as Claude Code reported it (absolute or project-relative). */
export function editedPath(payload: HookPayload): string | undefined {
	if (!payload.tool_name || !EDIT_TOOLS.has(payload.tool_name))
		return undefined;
	const input = payload.tool_input;
	if (typeof input !== "object" || input === null) return undefined;
	const { file_path, notebook_path } = input as Record<string, unknown>;
	const path = file_path ?? notebook_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** Notifications that wait for the person; `idle_prompt` (left idle after a turn) is not one. */
export const waitsForPerson = (payload: HookPayload) =>
	payload.notification_type === "permission_prompt" ||
	payload.notification_type === "elicitation_dialog";

export const newHookToken = () => randomBytes(32).toString("hex");

const digest = (value: string) => createHash("sha256").update(value).digest();
export const sameToken = (a: string, b: string) =>
	timingSafeEqual(digest(a), digest(b));

/** Only a loopback URL with a real port may receive hooks (it is also put in a shell command). */
export function hookBaseUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(
		value,
	)
		? value
		: undefined;
}

/** Git writes a `work` session of a Kanban card must not make (the person commits after review). */
const GIT_WRITE_DENY = ["Bash(git commit *)", "Bash(git push *)"];

/** The 0600 file next to a settings file that holds the token header (`curl -H @file`). */
export const headerFileOf = (settingsPath: string) =>
	settingsPath.replace(/\.json$/, ".header");
/** A path as one shell word (single quotes; an embedded quote is closed and escaped). */
const shellWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Writes the settings that add the hooks to a private file (0600) and returns its path. The
 * token is not in the process arguments, neither Claude Code's nor `curl`'s (`ps` shows both):
 * it is a header line in a second 0600 file next to the settings, which `curl -H @<file>` reads.
 * Both files are removed together (`removeHookSettings`). The command is built only from the
 * checked URL, the session UUID and the file's path, so the shell Claude Code runs it in sees no
 * user text. `denyGitWrites` adds `permissions.deny` for `git commit` and `git push`.
 */
export function writeHookSettings(
	baseUrl: string,
	sessionId: string,
	token: string,
	denyGitWrites = false,
): string {
	const path = join(
		tmpdir(),
		`eumenes-claude-hooks-${randomBytes(12).toString("hex")}.json`,
	);
	const header = headerFileOf(path);
	writeFileSync(header, `${HOOK_TOKEN_HEADER}: ${token}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	try {
		const command = `curl -q -s -m 5 --noproxy '*' -X POST -H 'Content-Type: application/json' -H @${shellWord(header)} --data-binary @- '${baseUrl}${HOOK_PATH}/${sessionId}' >/dev/null 2>&1 || true`;
		const entry = [{ hooks: [{ type: "command", command }] }];
		writeFileSync(
			path,
			JSON.stringify({
				hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, entry])),
				...(denyGitWrites ? { permissions: { deny: GIT_WRITE_DENY } } : {}),
			}),
			{ mode: 0o600, flag: "wx" },
		);
	} catch (error) {
		rmSync(header, { force: true });
		throw error;
	}
	return path;
}

export const removeHookSettings = (path: string | undefined) => {
	if (!path) return;
	rmSync(path, { force: true });
	rmSync(headerFileOf(path), { force: true });
};
