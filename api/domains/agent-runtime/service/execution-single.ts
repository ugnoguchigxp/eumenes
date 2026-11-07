import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ExecutionReference, ExecutionSource } from "../../tool-runtime";
import { executionRow, executionView, type ExecutionRow, type ParentState } from "../repository/executions";
import type { ExecutionContext } from "./execution-context";
import type { ExecutionOps } from "./execution-store";

/** Executes a capability already selected by its owner, using the shared child lifecycle. */
export function singleExecution(ctx: ExecutionContext, ops: ExecutionOps) {
	return {
		startSelectedInTransaction(db: Database, input: {
			source: ExecutionSource;
			chainRevisionId: string;
			request: string;
			arguments?: Record<string, unknown>;
			references: ExecutionReference[];
			deadline: number;
		}) {
			const port = ctx.port();
			if (!port.validSourceInTransaction(db, input.source)) throw new Error("execution_source_invalid");
			if (input.source.origin === "autonomous" && (input.source.agency?.capabilityRevisionId !== input.chainRevisionId || input.source.request !== input.request)) throw new Error("execution_source_invalid");
			if (!port.cardInTransaction(db, input.chainRevisionId)) throw new Error("toolchain_unavailable");
			if (!input.request.trim() || input.request.length > 8000 || input.references.length > 32 || input.deadline <= ctx.now() + 45_000 || new TextEncoder().encode(JSON.stringify(input)).length > 24_576) throw new Error("execution_input_capacity");
			if (input.references.some((ref) => !port.validReferenceInTransaction(db, input.source, ref))) throw new Error("execution_reference_invalid");
			const key = `selected:${input.source.runId}:${input.source.digest}`;
			const digest = hash(input);
			const prior = db.query("SELECT * FROM agent_executions WHERE start_key=?").get(key) as ExecutionRow | null;
			if (prior) {
				if (!prior.source_json) throw new Error("execution_source_expired");
				if (prior.input_digest !== digest) throw new Error("request_conflict");
				return executionView(prior);
			}
			const id = crypto.randomUUID();
			const state: ParentState = {
				version: 1, single: { chainRevisionId: input.chainRevisionId }, bindingRevisionId: input.chainRevisionId,
				instructions: "", calls: 0, consumed: 0, searches: 0, children: 0, ordinal: 0, questions: 0,
				selecting: false, offered: [], retained: [], refs: input.references, notes: [], pending: null, question: null,
				limits: { parentCalls: 0, childCalls: 1, searches: 0, modelCalls: 13 },
			};
			db.query("INSERT INTO agent_executions(id,start_key,input_digest,conversation_id,source_json,request,state,state_json,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)").run(id,key,digest,input.source.conversationId,JSON.stringify(input.source),input.request,JSON.stringify(state),input.deadline,ctx.now(),ctx.now());
			ops.launch(db, executionRow(db,id)!, state, { chainRevisionId: input.chainRevisionId, request: input.request, arguments: input.arguments, refs: input.references }, crypto.randomUUID());
			return executionView(executionRow(db,id)!);
		},
	};
}
