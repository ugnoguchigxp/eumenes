import { replaceResourceUrisIn } from "../../domains/dialogue";
import type { Database } from "bun:sqlite";
import {
	RESOURCES_FIND_LIMIT_DEFAULT,
	resourcesTool,
	type ResourcesToolInput,
} from "../../domains/capabilities";
import type { ConversationResourcePort } from "../../domains/dialogue";
import type { ResourceRegistry } from "../../domains/resources";
import type { ScreenAction, ScreenService } from "../../domains/screen";
import type { DomainAdapter, InstantResult } from "../../domains/tool-runtime";
import { jstDay } from "../../infrastructure/jst-time";
import { getLogger } from "../../infrastructure/logger";
import type { SqliteStore } from "../../infrastructure/sqlite";

export const RESOURCES_ADAPTER_REF = "adapter:resources@1";
export const RESOURCES_OPERATION = "resources.manage";

/**
 * The longest text of a `read` answer, in characters. The owner shortens a resource to about 600 tokens
 * (spec §5); this only keeps one answer inside what an instant answer may carry.
 */
export const RESOURCES_READ_TEXT_MAX_CHARS = 1500;
/** The longest whole answer (the JSON) this adapter hands back. */
export const RESOURCES_ANSWER_MAX_CHARS = 1900;
const TRUNCATED = "…（以下省略）";

const log = getLogger("resources");

/** The conversation an instant call belongs to (the host passes it as the fourth argument of `run`). */
export type InstantContext = { conversationId: string };

export type ResourcesToolDeps = {
	registry: ResourceRegistry;
	ledger: ConversationResourcePort;
	screen: Pick<ScreenService, "issueInTransaction">;
	store: Pick<SqliteStore, "read" | "write">;
	now?: () => number;
};

/** What the adapter offers a bundle check without a running service. */
export const describeResourcesAdapter = () => ({
	owner: "resources",
	operations: new Map([
		[
			RESOURCES_OPERATION,
			{ inputSchemaRef: "builtin:resourcesTool", effect: "write" as const },
		],
	]),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:resources@1",
	instant: true,
});

/** The model reads resources by number only: a URI inside a label or a read text is never shown (plan §2.3). */
const asAnswer = (body: Record<string, unknown>): InstantResult => ({
	ok: true,
	answer: JSON.stringify(replaceResourceUrisIn(body, () => "リソース")),
});
const notFound = () => asAnswer({ ok: false, code: "item_not_found" });

/** `MM-DD` in Japan this year, `YYYY-MM-DD` otherwise. */
function dayLabel(iso: string, nowMs: number): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso.slice(0, 10);
	const day = jstDay(ms);
	return day.slice(0, 4) === jstDay(nowMs).slice(0, 4) ? day.slice(5) : day;
}

/** The search bounds as instants: `since` from the start of its day, `until` to the end of its day (Japan). */
const sinceOf = (day: string) =>
	new Date(`${day}T00:00:00+09:00`).toISOString();
const untilOf = (day: string) =>
	new Date(`${day}T23:59:59.999+09:00`).toISOString();

/** The text cut so the whole answer fits; the answer says it was cut. */
function readAnswer(
	item: string,
	kind: string,
	text: string,
): Record<string, unknown> {
	const make = (body: string, truncated: boolean) => ({
		ok: true,
		item,
		kind,
		text: body,
		...(truncated ? { truncated: true } : {}),
	});
	let body = text;
	let truncated = false;
	if (body.length > RESOURCES_READ_TEXT_MAX_CHARS) {
		body = `${body.slice(0, RESOURCES_READ_TEXT_MAX_CHARS - TRUNCATED.length)}${TRUNCATED}`;
		truncated = true;
	}
	let answer = make(body, truncated);
	const over = JSON.stringify(answer).length - RESOURCES_ANSWER_MAX_CHARS;
	if (over > 0) {
		body = `${body.slice(0, Math.max(0, body.length - TRUNCATED.length - over))}${TRUNCATED}`;
		answer = make(body, true);
	}
	return answer;
}

/**
 * The `resources` toolchain's adapter (spec resource-uri-implementation-plan §8): finds what Eumenes made and
 * the history, shows it on a screen, plays it, and reads it. The conversation names a resource by its number
 * (`a<n>`) only; the URI stays here. Every outcome, a refusal included, is the answer the model reads, so a
 * refusal's code and details reach it.
 */
export function createResourcesToolAdapter(
	deps: ResourcesToolDeps,
): DomainAdapter {
	const { registry, ledger, screen, store } = deps;
	const now = deps.now ?? Date.now;
	const unsupported = () => {
		throw new Error("unsupported_operation");
	};
	const kindLabel = (kind: string) => registry.kind(kind)?.label ?? kind;

	/** The actions the resource allows (the default first), or its kind's when the item itself is gone. */
	const allowedOf = (db: Database, uri: string, kind: string) => {
		const resolved = registry.resolveInTransaction(db, uri);
		return resolved.ok
			? resolved.resource.actions
			: (registry.kind(kind)?.actions ?? []);
	};

	const refused = (
		db: Database,
		code: string,
		resource: { uri: string; kind: string },
	): InstantResult =>
		code === "action_not_allowed"
			? asAnswer({
					ok: false,
					code,
					kind: kindLabel(resource.kind),
					allowed: allowedOf(db, resource.uri, resource.kind),
				})
			: notFound();

	async function find(
		input: ResourcesToolInput,
		context: InstantContext,
		signal: AbortSignal,
	): Promise<InstantResult> {
		let kinds: string[] | undefined;
		if (input.kind !== undefined) {
			const wanted = input.kind;
			kinds = registry
				.kinds()
				.filter((k) => k.label === wanted || k.kind === wanted)
				.map((k) => k.kind);
			if (kinds.length === 0)
				return asAnswer({
					ok: false,
					code: "kind_unknown",
					kinds: registry.kinds().map((k) => k.label),
				});
		}
		const found = await registry.search(
			{
				text: input.query!,
				limit: input.limit ?? RESOURCES_FIND_LIMIT_DEFAULT,
				...(input.since ? { since: sinceOf(input.since) } : {}),
				...(input.until ? { until: untilOf(input.until) } : {}),
				...(kinds ? { kinds } : {}),
			},
			signal,
		);
		signal.throwIfAborted();
		const nowMs = now();
		const items = await store.write((db) =>
			found.flatMap((hit) => {
				const entered = ledger.enterInTransaction(db, {
					conversationId: context.conversationId,
					uri: hit.uri,
					kind: hit.kind,
					label: hit.label,
					source: "found",
				});
				// What the conversation forgot is not found again.
				if (entered.forgottenAt) return [];
				return [
					{
						item: `a${entered.ref}`,
						kind: kindLabel(hit.kind),
						label: hit.label,
						createdAt: dayLabel(hit.createdAt, nowMs),
					},
				];
			}),
		);
		return asAnswer({ ok: true, items });
	}

	/** `open` or `play`: prepare, issue one screen command and touch the ledger, in one transaction. */
	function show(
		action: ScreenAction,
		item: string,
		context: InstantContext,
	): Promise<InstantResult> {
		return store.write((db) => {
			const resource = ledger.byRefInTransaction(
				db,
				context.conversationId,
				item,
			);
			if (!resource) return notFound();
			const prepared = registry.prepareInTransaction(db, resource.uri, action, {
				conversationId: context.conversationId,
			});
			if (!prepared.ok) return refused(db, prepared.code, resource);
			screen.issueInTransaction(db, {
				conversationId: context.conversationId,
				uri: resource.uri,
				action,
				adapterRef: prepared.adapterRef,
				targetRef: prepared.targetRef,
			});
			ledger.touchInTransaction(db, resource.id);
			return asAnswer({
				ok: true,
				item,
				action,
				kind: kindLabel(resource.kind),
			});
		});
	}

	async function read(
		item: string,
		context: InstantContext,
		signal: AbortSignal,
	): Promise<InstantResult> {
		const step = store.read((db) => {
			const resource = ledger.byRefInTransaction(
				db,
				context.conversationId,
				item,
			);
			if (!resource) return { done: notFound() };
			// Resolving and checking the action is synchronous; only the owner's read waits.
			return {
				resource,
				read: registry.read(db, resource.uri, signal),
			};
		});
		if (step.done) return step.done;
		const outcome = await step.read;
		signal.throwIfAborted();
		if (!outcome.ok)
			return outcome.code === "action_not_allowed"
				? asAnswer({
						ok: false,
						code: "action_not_allowed",
						kind: kindLabel(step.resource.kind),
						allowed: await store.read((db) =>
							allowedOf(db, step.resource.uri, step.resource.kind),
						),
					})
				: notFound();
		await store.write((db) => ledger.touchInTransaction(db, step.resource.id));
		return asAnswer(
			readAnswer(item, kindLabel(step.resource.kind), outcome.text),
		);
	}

	return {
		ref: RESOURCES_ADAPTER_REF,
		describe: describeResourcesAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction: unsupported,
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
		instant: {
			async run(
				operationName,
				raw,
				signal,
				context?: InstantContext,
			): Promise<InstantResult> {
				if (operationName !== RESOURCES_OPERATION)
					return { ok: false, code: "unsupported_operation" };
				const parsed = resourcesTool.safeParse(raw);
				if (!parsed.success) return { ok: false, code: "invalid_input" };
				if (!context) return { ok: false, code: "conversation_required" };
				const input = parsed.data;
				try {
					const result =
						input.operation === "find"
							? await find(input, context, signal)
							: input.operation === "read"
								? await read(input.item!, context, signal)
								: await show(input.operation, input.item!, context);
					log.info("resources.used", { operationId: input.operation });
					return result;
				} catch (error) {
					// A cancelled run is not a failure of the lookup.
					signal.throwIfAborted();
					log.warn(
						"resources.failed",
						{ operationId: input.operation, reason: "resources_failed" },
						error,
					);
					return { ok: false, code: "resources_failed" };
				}
			},
		},
	};
}
