import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";
import type {
	EnqueueRequest,
	TerminalRequestFinished,
	TerminalRequestView,
} from "./contracts";
import type { RequestRow } from "./repository";

/** Most changed files recorded per request. */
export const MAX_FILES = 200;

const uuidLike = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const enqueueRequestSchema = z
	.strictObject({
		attemptId: uuidLike,
		owner: z.union([
			z.literal("direct"),
			z.string().regex(/^kanban:.{1,200}$/),
		]),
		target: z.enum(["new", "conversation", "current"]),
		claudeSessionId: uuidLike.optional(),
		mode: z.enum(["work", "commit"]),
		projectId: z.string().min(1).max(80),
		prompt: z.string().min(1).max(8000),
		task: z.string().min(1).max(40),
		origin: z.enum(["board", "conversation"]),
		conversationId: z.string().min(1).max(200).optional(),
		exclusiveGroup: z.literal("kanban").optional(),
	})
	.refine(
		(r) => r.target !== "conversation" || r.claudeSessionId !== undefined,
		{
			message: "claude_session_required",
			path: ["claudeSessionId"],
		},
	);

/** What the same request id must carry again to count as a replay. */
export const requestDigest = (request: EnqueueRequest) =>
	sha256Hex(
		JSON.stringify([
			request.owner,
			request.target,
			request.claudeSessionId ?? null,
			request.mode,
			request.projectId,
			request.prompt,
			request.task,
			request.origin,
			request.conversationId ?? null,
			request.exclusiveGroup ?? null,
		]),
	);

/**
 * Claude Code shows a long pasted request as `<pasted_content id="…">…</pasted_content id="…">`
 * in the hook's prompt; the wrapper is not part of the request.
 */
const WRAPPER_OPEN = /^\s*<pasted_content\b[^>]*>/;
const WRAPPER_CLOSE = /<\/pasted_content\b[^>]*>\s*$/;
const normalize = (text: string) =>
	text
		.replace(WRAPPER_OPEN, "")
		.replace(WRAPPER_CLOSE, "")
		.replace(/\s+/g, " ")
		.trim();
/** The prompt Claude Code received is the request that was sent (whitespace and wrapper aside). */
export const sameTurn = (submitted: string, sent: string) =>
	normalize(submitted) === normalize(sent);

const realCwd = (cwd: string) => {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
};
/** A path inside the project, relative to it; undefined for anything outside. */
export function projectRelative(cwd: string, file: string): string | undefined {
	const absolute = resolve(cwd, file);
	for (const base of [cwd, realCwd(cwd)]) {
		const path = relative(base, absolute);
		if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) return path;
	}
	return undefined;
}

/** Adds a file to a request's list: deduplicated, at most `MAX_FILES`. */
export function addFile(files: string[], path: string): boolean {
	if (files.length >= MAX_FILES || files.includes(path)) return false;
	files.push(path);
	return true;
}

export function toView(
	row: RequestRow,
	files: readonly string[] = row.files,
): TerminalRequestView {
	return {
		id: row.id,
		state: row.state,
		...(row.reason ? { reason: row.reason } : {}),
		owner: row.owner,
		target: row.target,
		mode: row.mode,
		projectId: row.projectId,
		task: row.task,
		origin: row.origin,
		...(row.conversationId ? { conversationId: row.conversationId } : {}),
		...(row.claudeSessionId ? { claudeSessionId: row.claudeSessionId } : {}),
		...(row.terminalSessionId
			? { terminalSessionId: row.terminalSessionId }
			: {}),
		...(row.promptId ? { promptId: row.promptId } : {}),
		...(row.lastReport ? { lastReport: row.lastReport } : {}),
		files: [...files],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function toFinished(row: RequestRow): TerminalRequestFinished {
	return {
		attemptId: row.id,
		state: row.state as TerminalRequestFinished["state"],
		...(row.reason ? { reason: row.reason } : {}),
		owner: row.owner,
		origin: row.origin,
		...(row.conversationId ? { conversationId: row.conversationId } : {}),
		task: row.task,
		lastReport: row.lastReport ?? "",
		files: row.files,
	};
}
