import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type {
	SpecialistPort,
	SpecialistSet,
	ToolchainRoutingPort,
} from "../../domains/dialogue";
import type {
	AdapterRegistry,
	SessionWorkAdapter,
} from "../../domains/tool-runtime";
import type { SchemaProvider } from "./toolchain-adapters";

/** Saved items a session may start from (the adapter's own list, at most this many). */
const MAX_TARGETS = 50;
/** A schema failure the specialist is told about: this many issues of this many characters at most. */
const MAX_ISSUES = 8;
const ISSUE_CHARS = 200;

/** Where, what kind and which type was expected; the model's input values stay out (a record's path may name a key the model wrote). */
function issueLines(error: z.ZodError): string[] {
	return error.issues.slice(0, MAX_ISSUES).map((issue) => {
		const expected =
			"expected" in issue && typeof issue.expected === "string"
				? issue.expected
				: "origin" in issue && typeof issue.origin === "string"
					? issue.origin
					: null;
		const path = issue.path.map(String).join(".") || "(root)";
		const suffix = ` ${issue.code}${expected ? ` expected=${expected}` : ""}`;
		return path.slice(0, ISSUE_CHARS - suffix.length) + suffix;
	});
}

/**
 * Dialogue's access to session toolchains and their domain work (spec toolchain-specialist-dialogue §4.1).
 * Dialogue never names a domain: every call goes to the adapter the binding names, through its `session`
 * work and its registered operations.
 */
export function createSpecialistPort(deps: {
	routing: Pick<ToolchainRoutingPort, "sessionSetInTransaction">;
	registry: AdapterRegistry;
	schemas: Pick<SchemaProvider, "get">;
	clock: () => string;
}): SpecialistPort {
	const { routing, registry, schemas, clock } = deps;
	const adapterOf = (ref: string) => {
		const adapter = registry.get(ref);
		if (!adapter) throw new Error("capability_unavailable");
		return adapter;
	};
	/** The adapter's session work; throws when the binding's adapter does not implement it. */
	const sessionOf = (ref: string): SessionWorkAdapter => {
		const session = adapterOf(ref).session;
		if (!session) throw new Error("capability_unavailable");
		return session;
	};
	return {
		setInTransaction(db: Database, toolchainRevisionId: string): SpecialistSet {
			if (!routing.sessionSetInTransaction)
				throw new Error("capability_unavailable");
			const set = routing.sessionSetInTransaction(db, toolchainRevisionId);
			sessionOf(set.adapterRef);
			return set;
		},
		targetChoicesInTransaction(db, set, include) {
			if (!set.targetSchemaRef) return [];
			const adapter = adapterOf(set.adapterRef);
			const choices =
				adapter.choicesInTransaction?.(db, set.targetSchemaRef) ?? [];
			const base = choices.slice(0, MAX_TARGETS);
			// The item on screen is offered even when it is older than the most recent ones: the adapter
			// confirms it is a real saved item; the oldest choice makes room.
			if (
				include &&
				!base.some((choice) => choice.ref === include) &&
				adapter.session?.hasTargetInTransaction(db, include)
			)
				return [
					{
						ref: include,
						label:
							choices.find((choice) => choice.ref === include)?.label ??
							include,
					},
					...base,
				].slice(0, MAX_TARGETS);
			return base;
		},
		openWorkInTransaction: (db, set, input) =>
			sessionOf(set.adapterRef).openInTransaction(db, input),
		// A missing adapter means the work cannot be read: it is absent, not an error.
		workStateInTransaction: (db, adapterRef, workRef) =>
			registry.get(adapterRef)?.session?.stateInTransaction(db, workRef) ??
			null,
		beginTurnInTransaction: (db, adapterRef, workRef, runId) =>
			sessionOf(adapterRef).beginTurnInTransaction(db, workRef, runId),
		// Ending a turn must never fail a run's end: with no adapter there is nothing to release.
		endTurnInTransaction: (db, adapterRef, workRef, runId) =>
			registry
				.get(adapterRef)
				?.session?.endTurnInTransaction(db, workRef, runId),
		endWorkInTransaction: (db, adapterRef, workRef, mode) =>
			sessionOf(adapterRef).endInTransaction(db, workRef, mode),
		parseInvocation(set, toolId, args) {
			const tool = set.tools.find((t) => t.id === toolId);
			if (!tool) return { ok: false, code: "specialist_tool_unknown" };
			const schema = schemas.get(tool.inputSchemaRef);
			if (!schema) return { ok: false, code: "unsupported_schema" };
			const parsed = schema.safeParse(args ?? {});
			return parsed.success
				? {
						ok: true,
						operationName: tool.operationName,
						input: parsed.data as Record<string, unknown>,
					}
				: {
						ok: false,
						code: "specialist_invalid_arguments",
						detail: issueLines(parsed.error),
					};
		},
		invokeInTransaction(db, set, input) {
			// Only an operation of the session's own set; the work and turn are the host's, not the model's.
			if (!set.tools.some((t) => t.operationName === input.operationName))
				throw new Error("specialist_tool_unknown");
			const result = adapterOf(set.adapterRef).invokeInTransaction(db, {
				operationName: input.operationName,
				input: input.input,
				requestId: input.requestId,
				issuedAt: clock(),
				origin: {
					kind: "specialist",
					sessionId: input.sessionId,
					runId: input.runId,
					conversationId: input.conversationId,
					workRef: input.workRef,
				},
			});
			return { answerContext: result.answerContext ?? null };
		},
		afterCommit: (adapterRef) => registry.get(adapterRef)?.afterCommit?.(),
	};
}
