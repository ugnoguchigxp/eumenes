import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import { submitInput, type ComputePort, type JobView } from "../contracts";
import { owned, patch, row, savedEnvironment, view } from "../repository";
import type { Step } from "./handlers";
export function createCommands(deps: {
	port: () => ComputePort | null;
	enqueue: (db: Database, id: string, step: Step) => void;
	cancelInTransaction: (db: Database, owner: string, id: string) => unknown;
}) {
	const { enqueue, cancelInTransaction } = deps;
	return function commandInTransaction(
		db: Database,
		owner: string,
		conversationId: string,
		origin: "conversation" | "task" | "screen",
		operation: string,
		input: unknown,
		requestId: string,
		deadline?: number,
		authorization?: unknown,
	) {
		if (operation === "python_submit") {
			const parsed = submitInput.safeParse(input);
			if (!parsed.success) throw new Error("invalid_request");
			input = parsed.data;
		}
		const inputJson = canonicalJson(input, {
			omitUndefined: true,
			keyOrder: "codeUnit",
		});
		const previous = db
			.query("SELECT * FROM compute_commands WHERE request_id=?")
			.get(requestId) as {
			owner: string;
			conversation_id: string;
			operation: string;
			input_json: string;
			result_json: string;
		} | null;
		if (previous) {
			if (
				previous.owner !== owner ||
				previous.conversation_id !== conversationId ||
				previous.operation !== operation ||
				previous.input_json !== inputJson
			)
				throw new Error("request_conflict");
			return {
				value: JSON.parse(previous.result_json) as {
					action: string;
					jobId: string;
					job?: JobView;
					artifactId?: string;
				},
				replay: true,
			};
		}
		let value: {
			action: string;
			jobId: string;
			job?: JobView;
			artifactId?: string;
		};
		if (operation === "python_submit") {
			const parsed = submitInput.safeParse(input);
			if (!parsed.success) throw new Error("invalid_request");
			const body = parsed.data;
			const port = deps.port();
			const env = savedEnvironment(db, port?.binding);
			if (!port || !env) throw new Error("compute_service_unavailable");
			const limits = env.environment.limits;
			if (
				Buffer.byteLength(body.code) > limits.maxCodeBytes ||
				Buffer.byteLength(JSON.stringify(body.inputs)) > limits.maxInputBytes ||
				body.timeoutSec > limits.maxTimeoutSec
			)
				throw new Error("limit_exceeded");
			const active = db
				.query(
					"SELECT 1 FROM compute_jobs WHERE owner=? AND conversation_id=? AND (state IN ('submitting','queued','running','collecting') OR (state='indeterminate' AND sent=1 AND job_id IS NULL))",
				)
				.get(owner, conversationId);
			if (active) throw new Error("compute_capacity");
			const id = crypto.randomUUID(),
				now = Date.now();
			db.query(
				"INSERT INTO compute_jobs(id,owner,conversation_id,origin,request_id,idempotency_key,body_json,binding,service_url,state,deadline,created_at,updated_at,authorization_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				id,
				owner,
				conversationId,
				origin,
				requestId,
				crypto.randomUUID(),
				canonicalJson(body, { omitUndefined: true, keyOrder: "codeUnit" }),
				port.binding,
				env.url,
				"submitting",
				Math.min(now + 420000, deadline ?? Infinity),
				now,
				now,
				authorization ? JSON.stringify(authorization) : null,
			);
			enqueue(db, id, "submit");
			value = { action: operation, jobId: id, job: view(db, row(db, id)!) };
		} else {
			const target = zTarget(input);
			const r = owned(
				db,
				owner,
				target.jobId,
				origin === "screen" ? undefined : conversationId,
			);
			if (operation === "python_cancel") cancelInTransaction(db, owner, r.id);
			else if (operation === "python_artifact") {
				if (
					!target.artifactId ||
					!view(db, r).artifacts.some((a) => a.id === target.artifactId)
				)
					throw new Error("compute_artifact_not_found");
				if (
					r.state === "completed" &&
					view(db, r).artifacts.some((a) => !a.ready)
				) {
					patch(db, r.id, { state: "collecting", artifact_error: null });
					enqueue(db, r.id, "fetch");
				}
			} else if (operation !== "python_status")
				throw new Error("unsupported_operation");
			value = {
				action: operation,
				jobId: r.id,
				job: view(db, row(db, r.id)!),
				...(target.artifactId ? { artifactId: target.artifactId } : {}),
			};
		}
		db.query(
			"INSERT INTO compute_focus VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET job_id=excluded.job_id",
		).run(owner, value.jobId);
		db.query("INSERT INTO compute_commands VALUES(?,?,?,?,?,?)").run(
			requestId,
			owner,
			conversationId,
			operation,
			inputJson,
			JSON.stringify(value),
		);
		return { value, replay: false };
	};
}
function zTarget(input: unknown) {
	if (
		!input ||
		typeof input !== "object" ||
		!("jobId" in input) ||
		typeof input.jobId !== "string"
	)
		throw new Error("invalid_request");
	return input as { jobId: string; artifactId?: string };
}
