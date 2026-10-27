import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Connection, Resource } from "../../settings";
import { billingPath } from "../../settings/contracts";
import { isAgentConnection } from "../../settings";
import type { CallSession } from "../contracts";
import type { RequestRow } from "../repository";

/** A call's resolved session lifetime (LLM calls only). */
export type CallSessionRole = {
	sessionRole: "main" | "subagent" | "auxiliary";
	taskId?: string;
	/** An auxiliary call on the conversation's connection, yielding to the conversation. */
	onConversation?: true;
	/** A read-ahead on the conversation's connection: its output ends at its bound by design. */
	readAhead?: true;
	context?: NonNullable<CallSession["context"]>;
	refs?: { messageIds: string[]; itemIds: string[] };
};

/** The session fields a provider call carries (LARM chooses its connection by them). */
export const sessionCallOptions = (session?: CallSessionRole) =>
	session
		? {
				sessionRole: session.sessionRole,
				...(session.taskId ? { taskId: session.taskId } : {}),
				...(session.onConversation ? { onConversation: true as const } : {}),
				...(session.readAhead ? { readAhead: true as const } : {}),
			}
		: {};

const TASK_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;
const REF_LIMIT = 4096;
const refList = (ids: readonly string[] | undefined) => {
	if (
		ids === undefined ||
		ids.length > REF_LIMIT ||
		ids.some((id) => typeof id !== "string" || !id || id.length > 200)
	)
		throw new Error("invalid_session_refs");
	return [...new Set(ids)];
};
const count = (n: unknown) =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 100_000;

/**
 * The session lifetime of one call, independent of the output mode: a missing role is `auxiliary`, `main` is
 * for answer-mode calls only, `subagent` needs a `taskId` (control mode allowed). Only LLM calls have a role.
 */
export function resolveSession(
	row: RequestRow,
	given?: CallSession,
): CallSessionRole | undefined {
	if (
		given?.failureScope &&
		(row.purpose !== "llm" ||
			given.failureScope !== "call" ||
			(given.sessionRole ?? "auxiliary") !== "auxiliary" ||
			row.mode !== "answer")
	)
		throw new Error("invalid_failure_scope");
	if (row.purpose !== "llm") {
		if (given?.sessionRole || given?.taskId || given?.context || given?.refs)
			throw new Error("invalid_session_role");
		return undefined;
	}
	const sessionRole = given?.sessionRole ?? "auxiliary";
	if (
		(given?.onConversation && sessionRole !== "auxiliary") ||
		(given?.prefixTools && !given.onConversation) ||
		(given?.readAhead && !given.onConversation) ||
		(sessionRole === "main" && row.mode !== "answer") ||
		(sessionRole === "subagent") !== !!given?.taskId ||
		(given?.taskId !== undefined && !TASK_ID.test(given.taskId))
	)
		throw new Error("invalid_session_role");
	const context = given?.context;
	if (
		context &&
		(sessionRole !== "main" ||
			!count(context.instructionCount) ||
			!count(context.historyCount))
	)
		throw new Error("invalid_session_context");
	return {
		sessionRole,
		...(given?.taskId ? { taskId: given.taskId } : {}),
		...(given?.onConversation ? { onConversation: true as const } : {}),
		...(given?.readAhead ? { readAhead: true as const } : {}),
		...(context
			? {
					context: {
						instructionCount: context.instructionCount,
						historyCount: context.historyCount,
					},
				}
			: {}),
		...(given?.refs
			? {
					refs: {
						messageIds: refList(given.refs.messageIds),
						itemIds: refList(given.refs.itemIds),
					},
				}
			: {}),
	};
}

type Source = "larm" | "cloud";

/** Who bills an attempt: LARM, or the cloud connection's own path. */
function attemptBillingPath(source: Source, connection?: Connection) {
	if (source === "larm") return "larm";
	return connection ? billingPath(connection) : null;
}

/** Writes the attempt row when an attempt starts: its source, session role and task, and the path that bills it. */
export async function recordAttemptStart(
	store: SqliteStore,
	a: {
		row: RequestRow;
		source: Source;
		selected: { resource: Resource; connection: Connection } | null;
		reason: string | null;
		session?: CallSessionRole;
	},
) {
	const cloud = a.source === "cloud" ? a.selected : null;
	const attemptId = crypto.randomUUID();
	await store.write((db) =>
		db
			.query(
				"INSERT INTO inference_attempts(id,request_id,source,connection_id,resource_id,model,status,reason,started,session_role,task_id,billing_path,refs) VALUES(?,?,?,?,?,?,'running',?,?,?,?,?,?)",
			)
			.run(
				attemptId,
				a.row.id,
				a.source,
				cloud?.connection.id ?? null,
				cloud?.resource.id ?? null,
				cloud ? cloud.resource.model : (a.row.snapshot.larm.profile ?? null),
				a.reason,
				Date.now(),
				a.session?.sessionRole ?? null,
				a.session?.taskId ?? null,
				attemptBillingPath(a.source, a.selected?.connection),
				// Only an agent attempt can be revoked; the references it stood on are what a forget matches.
				a.session?.refs && cloud && isAgentConnection(cloud.connection)
					? JSON.stringify(a.session.refs)
					: null,
			),
	);
	return attemptId;
}
