import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
	hook_event_name: z.enum(["UserPromptSubmit", "Stop", "Notification"]),
	last_assistant_message: z.string().optional(),
});
export type HookPayload = z.infer<typeof hookPayloadSchema>;

export const newHookToken = () => randomBytes(32).toString("hex");

const digest = (value: string) => createHash("sha256").update(value).digest();
export const sameToken = (a: string, b: string) =>
	timingSafeEqual(digest(a), digest(b));

/**
 * Settings JSON adding the three hooks. The command is built only from the loopback URL, the
 * session UUID and a hex token, so the shell Claude Code runs it in sees no user text.
 */
export function hookSettings(
	baseUrl: string,
	sessionId: string,
	token: string,
): string {
	const command = `curl -s -m 5 -X POST -H 'Content-Type: application/json' -H '${HOOK_TOKEN_HEADER}: ${token}' --data-binary @- '${baseUrl}${HOOK_PATH}/${sessionId}' >/dev/null 2>&1 || true`;
	const entry = [{ hooks: [{ type: "command", command }] }];
	return JSON.stringify({
		hooks: { UserPromptSubmit: entry, Stop: entry, Notification: entry },
	});
}
