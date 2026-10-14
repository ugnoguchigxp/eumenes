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

export const hookPayloadSchema = z.object({
	hook_event_name: z.enum([
		"UserPromptSubmit",
		"Stop",
		"Notification",
		"PostToolUse",
	]),
	/** UserPromptSubmit: the submitted request (matches a handed-over task to its turn). */
	prompt: z.string().optional(),
	last_assistant_message: z.string().optional(),
	/** Notification: `permission_prompt` / `elicitation_dialog` wait for the person. */
	notification_type: z.string().optional(),
});
export type HookPayload = z.infer<typeof hookPayloadSchema>;

/** Notifications that wait for the person; `idle_prompt` (left idle after a turn) is not one. */
export const waitsForPerson = (payload: HookPayload) =>
	payload.notification_type === undefined ||
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

/**
 * Writes the settings that add the hooks to a private file (0600) and returns its path. The
 * token stays out of the process arguments; the command is built only from the checked URL, the
 * session UUID and a hex token, so the shell Claude Code runs it in sees no user text.
 */
export function writeHookSettings(
	baseUrl: string,
	sessionId: string,
	token: string,
): string {
	const command = `curl -q -s -m 5 --noproxy '*' -X POST -H 'Content-Type: application/json' -H '${HOOK_TOKEN_HEADER}: ${token}' --data-binary @- '${baseUrl}${HOOK_PATH}/${sessionId}' >/dev/null 2>&1 || true`;
	const entry = [{ hooks: [{ type: "command", command }] }];
	const path = join(
		tmpdir(),
		`eumenes-claude-hooks-${randomBytes(12).toString("hex")}.json`,
	);
	writeFileSync(
		path,
		JSON.stringify({
			hooks: {
				UserPromptSubmit: entry,
				Stop: entry,
				Notification: entry,
				PostToolUse: entry,
			},
		}),
		{ mode: 0o600, flag: "wx" },
	);
	return path;
}

export const removeHookSettings = (path: string | undefined) => {
	if (path) rmSync(path, { force: true });
};
