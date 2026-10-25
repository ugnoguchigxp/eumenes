import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { parseResourceUri } from "../../resources";
import type { ChildExecution, Source, ToolRuntime } from "../../tool-runtime";

/**
 * Resource URIs in a sub-agent's execution (resource-uri plan §6). A sub-agent may name a URI only when the
 * host handed it to the execution (`ExecutionReference` of kind `resource`) or one of the execution's own tools
 * returned it. The same set bounds `resource_read`, the `finish.links` and any tool argument declared
 * `format: "eumenes-uri"`.
 */
export const RESOURCE_READ_TOOL = "resource.read";
export const RESOURCE_READS_MAX = 8;
export const RESOURCE_LINKS_MAX = 8;
/** A read is shortened by its owner; this only bounds what a task keeps. */
const READ_TEXT_MAX = 4000;
/** A URI inside prose: the kind, an encoded id and an optional action, ending where the URI characters end. */
const URI_PATTERN =
	/eumenes:\/\/[A-Za-z0-9._~%-]+\/[A-Za-z0-9._~%!*'-]+(?:\?[A-Za-z0-9=&_-]*)?/gi;
const SCAN_DEPTH = 6;

export type ResourceReadOutcome =
	| { ok: true; text: string }
	| { ok: false; code: string };

/** What the host provides to read a resource by URI (the registry's `read`); the runtime never opens a store. */
export interface ResourceReadPort {
	read(uri: string, signal: AbortSignal): Promise<ResourceReadOutcome>;
}

export type StoredRead = { uri: string } & ResourceReadOutcome;
type StoredResources = { reads: StoredRead[]; links: string[] };

/** The optional `links` of every `finish` action. */
export const finishLinks = z
	.array(z.string().min(1).max(512))
	.max(RESOURCE_LINKS_MAX)
	.optional()
	.describe(
		"この作業のtoolが返したURIのうち、作ったリソースのURI（0〜8件）。依頼に添えられたURIを使って作り直した・編集した場合は新しいURI。toolの結果に出ていないURIは書かない。",
	);

/** The resources state a task row holds. */
export function parseResources(
	json: string | null | undefined,
): StoredResources {
	const stored = (json ? JSON.parse(json) : {}) as Partial<StoredResources>;
	return { reads: stored.reads ?? [], links: stored.links ?? [] };
}
export function loadResources(db: Database, taskId: string): StoredResources {
	const row = db
		.query("SELECT resources_json FROM agent_tasks WHERE id=?")
		.get(taskId) as { resources_json: string | null } | null;
	return parseResources(row?.resources_json);
}
export function saveResources(
	db: Database,
	taskId: string,
	change: Partial<StoredResources>,
) {
	const next = { ...loadResources(db, taskId), ...change };
	db.query("UPDATE agent_tasks SET resources_json=? WHERE id=?").run(
		JSON.stringify(next),
		taskId,
	);
}
/** The canonical URIs of the resources handed to an execution. */
export function handedResources(execution: ChildExecution | undefined) {
	const out: Array<{
		uri: string;
		kind: string;
		label: string;
		preview: string;
	}> = [];
	for (const ref of execution?.refs ?? []) {
		if (ref.kind !== "resource") continue;
		const parsed = parseResourceUri(ref.ref);
		if (parsed && !out.some((r) => r.uri === parsed.uri))
			out.push({
				uri: parsed.uri,
				kind: parsed.kind,
				label: ref.label,
				preview: ref.preview,
			});
	}
	return out;
}
/** Every resource URI inside the strings of `value` (arbitrarily nested), into `into`. */
export function collectUris(value: unknown, into: Set<string>, depth = 0) {
	if (typeof value === "string") {
		for (const match of value.match(URI_PATTERN) ?? []) {
			// Sentence punctuation after a URI is not part of its id.
			const parsed = parseResourceUri(match.replace(/[.!*'~]+$/, ""));
			if (parsed) into.add(parsed.uri);
		}
	} else if (depth < SCAN_DEPTH && value && typeof value === "object")
		for (const item of Object.values(value)) collectUris(item, into, depth + 1);
}
/** Page and snippet text from the open web is untrusted and never grants a URI. */
const external = (s: Source) =>
	s.kind === "web_source" || (!s.kind && ["page", "snippet"].includes(s.basis));
/** The URIs a task may name now: the handed ones, those in its tools' results and those in what it has read. */
export function allowedUris(
	db: Database,
	tools: Pick<ToolRuntime, "observationsInTransaction">,
	taskId: string,
	execution: ChildExecution | undefined,
) {
	const allowed = new Set(handedResources(execution).map((r) => r.uri));
	for (const observation of tools.observationsInTransaction(db, taskId)) {
		const { sources, ...rest } = observation as { sources: Source[] };
		collectUris(rest, allowed);
		for (const source of sources)
			if (!external(source)) collectUris(source, allowed);
	}
	for (const read of loadResources(db, taskId).reads) {
		allowed.add(read.uri);
		if (read.ok) collectUris(read.text, allowed);
	}
	return allowed;
}

type JsonSchema = {
	format?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
};
/** The values the arguments hold at `format: "eumenes-uri"` positions of the tool's input schema. */
function uriArguments(
	schema: JsonSchema | undefined,
	value: unknown,
	path: string,
	out: Array<{ path: string; value: unknown }>,
) {
	if (!schema || value === undefined) return;
	if (schema.format === "eumenes-uri") out.push({ path, value });
	if (schema.properties && value && typeof value === "object")
		for (const [key, child] of Object.entries(schema.properties))
			uriArguments(
				child,
				(value as Record<string, unknown>)[key],
				`${path}.${key}`,
				out,
			);
	if (schema.items && Array.isArray(value))
		value.forEach((item) => uriArguments(schema.items, item, path, out));
	for (const option of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])])
		uriArguments(option, value, path, out);
}
const unknownResource = (path: string) =>
	new ValidationFailure("unknown_resource", [
		{ validationPath: path, validationCode: "unknown_resource" },
	]);
/** Rejects (`unknown_resource`) an argument at a `format: "eumenes-uri"` position that is not an allowed URI. */
export function checkUriArguments(
	schema: Record<string, unknown> | null,
	args: unknown,
	allowed: Set<string>,
) {
	const found: Array<{ path: string; value: unknown }> = [];
	uriArguments(
		(schema ?? undefined) as JsonSchema | undefined,
		args,
		"arguments",
		found,
	);
	for (const { path, value } of found) {
		const parsed = typeof value === "string" ? parseResourceUri(value) : null;
		if (!parsed || !allowed.has(parsed.uri)) throw unknownResource(path);
	}
}
/** The canonical, de-duplicated links of a `finish`; rejects (`unknown_resource`) any that is not an allowed URI. */
export function checkLinks(
	links: readonly string[] | undefined,
	allowed: Set<string>,
) {
	const accepted: string[] = [];
	for (const link of links ?? []) {
		const parsed = parseResourceUri(link);
		if (!parsed || !allowed.has(parsed.uri)) throw unknownResource("links");
		if (!accepted.includes(parsed.uri)) accepted.push(parsed.uri);
	}
	return accepted;
}
export const readText = (text: string) => text.slice(0, READ_TEXT_MAX);
/** The links accepted for every task of a child tree, in task order and without duplicates. */
export function linksOfTree(db: Database, rootTaskId: string) {
	const rows = db
		.query(
			"SELECT resources_json FROM agent_tasks WHERE (id=? OR parent_task_id=?) AND resources_json IS NOT NULL ORDER BY created_at, id",
		)
		.all(rootTaskId, rootTaskId) as { resources_json: string }[];
	const links: string[] = [];
	for (const row of rows)
		for (const link of parseResources(row.resources_json).links)
			if (!links.includes(link)) links.push(link);
	return links;
}
