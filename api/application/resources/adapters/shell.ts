import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import {
	RESOURCE_LABEL_MAX,
	formatResourceUri,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../../domains/resources";
import type { ShellRun, ShellService } from "../../../domains/shell";

export const SHELL_RESOURCE_KIND = "code.task";
/** The `code.task` ids of shell runs are `shell:<run id>`; other owners of the kind use their own prefix. */
export const SHELL_RESOURCE_PREFIX = "shell";
const SHELL_SCREEN_REF = "artifact:cli.workspace@1";
const READ_TOKENS = 500;
const COMMAND_CHARS = 300;

export const shellResourceId = (runId: string) =>
	`${SHELL_RESOURCE_PREFIX}:${runId}`;

const runIdOf = (id: string) =>
	id.startsWith(`${SHELL_RESOURCE_PREFIX}:`)
		? id.slice(SHELL_RESOURCE_PREFIX.length + 1)
		: null;

const oneLine = (text: string, max: number) =>
	text.replace(/\s+/g, " ").trim().slice(0, max);

/** The run id a finished work's result names: the run receipt (`attemptId`) or the run itself (`id`). */
function resultRunId(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const record = result as Record<string, unknown>;
	for (const value of [
		record.attemptId,
		record.id,
		(record.output as Record<string, unknown> | null | undefined)?.id,
	])
		if (typeof value === "string" && value) return value;
	return null;
}

function summary(run: ShellRun): string {
	const head = [
		`task: ${run.task}`,
		`command: ${oneLine(run.command, COMMAND_CHARS)}`,
		`state: ${run.state}${run.exitCode === undefined || run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`,
	].join("\n");
	const room = READ_TOKENS - estimateTextTokens(`${head}\noutput:\n`);
	let tail = run.output.slice(-4000);
	while (tail && estimateTextTokens(tail) > room)
		tail = tail.slice(Math.ceil(tail.length / 5));
	return tail ? `${head}\noutput:\n${tail}` : head;
}

/**
 * The shell part of kind `code.task`: command runs recorded in `shell_runs`. Compose it with the other
 * owners of the kind (`combineKindAdapters`). Search sees the shell's recent runs only (the shell
 * service's own window), never a copy.
 */
export function createShellResourceAdapter(deps: {
	store: SqliteStore;
	shell: Pick<ShellService, "runInTransaction" | "recentInTransaction">;
}): ResourceAdapter {
	const refOf = (run: ShellRun): ResourceRef => ({
		uri: formatResourceUri(SHELL_RESOURCE_KIND, shellResourceId(run.id)),
		kind: SHELL_RESOURCE_KIND,
		label: run.task.slice(0, RESOURCE_LABEL_MAX),
		createdAt: run.createdAt,
	});
	const lookup = (db: Database, id: string) => {
		const runId = runIdOf(id);
		return runId ? deps.shell.runInTransaction(db, runId) : null;
	};
	return {
		kind: SHELL_RESOURCE_KIND,
		fromResultInTransaction(db, result) {
			const runId = resultRunId(result);
			const run = runId ? deps.shell.runInTransaction(db, runId) : null;
			return run ? [refOf(run)] : [];
		},
		getInTransaction(db, id): ResourceView | null {
			const run = lookup(db, id);
			if (!run) return null;
			return {
				...refOf(run),
				adapterRef: SHELL_SCREEN_REF,
				targetRef: run.sessionId ?? run.id,
				actions: ["open", "read"],
				preview: oneLine(run.command, RESOURCE_LABEL_MAX),
			};
		},
		async search(query) {
			const text = query.text.trim().toLowerCase();
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return deps.store
				.read((db) => deps.shell.recentInTransaction(db))
				.filter((run) => {
					const at = Date.parse(run.createdAt);
					if (since !== null && at < since) return false;
					if (until !== null && at > until) return false;
					return (
						!text ||
						`${run.task}\n${run.command}\n${run.output}`
							.toLowerCase()
							.includes(text)
					);
				})
				.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
				.slice(0, query.limit)
				.map(refOf);
		},
		async read(id) {
			const run = deps.store.read((db) => lookup(db, id));
			if (!run) throw new Error("item_not_found");
			return { text: summary(run) };
		},
	};
}
