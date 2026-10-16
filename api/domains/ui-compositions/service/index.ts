import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import { composeInput, designSpec, submitInput } from "../contracts";
import {
	createUiGenerationHandler,
	type ControlInference,
	type ImagePort,
} from "./handler";
import {
	get,
	list,
	receipt,
	saveReceipt,
	type CompositionRow,
} from "../repository";

const scope = "default";
function item(row: CompositionRow) {
	return {
		id: row.id,
		title: row.title,
		prompt: row.prompt,
		description: row.description,
		state: row.state,
		generation: row.generation,
		updatedAt: row.updated_at,
		motifId: row.motif_id ?? undefined,
		errorCode: row.error_code ?? undefined,
		definition: row.definition_json
			? (JSON.parse(row.definition_json) as unknown)
			: undefined,
		fields: row.fields_json
			? (JSON.parse(row.fields_json) as unknown)
			: undefined,
	};
}

export function createUiCompositions(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: ControlInference;
	image: () => ImagePort;
}) {
	const { store, queue } = deps;
	const handler = createUiGenerationHandler(deps);
	queue.registerHandler(handler);
	function composeInTransaction(db: Database, raw: unknown, requestId: string) {
		const input = composeInput.parse(raw);
		const old = receipt(db, requestId);
		if (old) {
			const saved = get(db, old.projectId);
			if (!saved) throw new Error("ui_project_not_found");
			return { item: item(saved), receipt: old, replay: true };
		}
		const current = input.projectId ? get(db, input.projectId) : null;
		if (input.projectId && (!current || current.scope !== scope))
			throw new Error("ui_project_not_found");
		const id = current?.id ?? crypto.randomUUID();
		const generation = (current?.generation ?? 0) + 1;
		const now = Date.now();
		if (current) {
			if (current.job_id)
				queue.cancelInTransaction(db, current.job_id, "superseded");
			db.query(
				"UPDATE ui_compositions SET prompt=?, motif_id=?, state='generating', generation=?, request_id=?, job_id=NULL, error_code=NULL, updated_at=? WHERE id=?",
			).run(
				input.prompt,
				input.motifId || null,
				generation,
				requestId,
				now,
				id,
			);
		} else
			db.query(
				"INSERT INTO ui_compositions(id,scope,title,description,prompt,motif_id,state,generation,request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				id,
				scope,
				"制作中のUI",
				"",
				input.prompt,
				input.motifId || null,
				"generating",
				generation,
				requestId,
				now,
				now,
			);
		const { job } = queue.enqueueInTransaction(db, {
			scope: "ui-compositions",
			kind: handler.kind,
			dedupeKey: `${id}:${generation}`,
			payload: { id, generation },
			subjectRef: id,
			lane: "interactive",
			resourceKey: "inference.llm",
			maxAttempts: 1,
			deadlineAtMs: now + 120_000,
		});
		db.query("UPDATE ui_compositions SET job_id=? WHERE id=?").run(job.id, id);
		const accepted = { projectId: id, state: "generating" };
		saveReceipt(db, requestId, accepted);
		return { item: item(get(db, id)!), receipt: accepted, replay: false };
	}
	function cancelInTransaction(db: Database, id: string, requestId: string) {
		const old = receipt(db, requestId);
		if (old) return { receipt: old, replay: true };
		const row = get(db, id);
		if (!row || row.scope !== scope || row.state !== "generating")
			throw new Error("ui_project_not_generating");
		if (row.job_id)
			queue.cancelInTransaction(db, row.job_id, "cancel_requested");
		db.query(
			"UPDATE ui_compositions SET state='cancelled', error_code=NULL, updated_at=? WHERE id=?",
		).run(Date.now(), id);
		const accepted = { projectId: id, state: "cancelled" };
		saveReceipt(db, requestId, accepted);
		return { receipt: accepted, replay: false };
	}
	function submitInTransaction(
		db: Database,
		id: string,
		expectedGeneration: number,
		raw: unknown,
		requestId: string,
	) {
		const old = receipt(db, requestId);
		if (old)
			return {
				projectId: old.projectId,
				responseId: old.responseId!,
				receipt: old,
				replay: true,
			};
		const row = get(db, id);
		if (
			!row ||
			row.scope !== scope ||
			row.state !== "ready" ||
			!row.fields_json
		)
			throw new Error("ui_project_not_ready");
		if (row.generation !== expectedGeneration)
			throw new Error("ui_project_changed");
		const values = submitInput.parse(raw);
		const fields = designSpec.shape.fields.parse(JSON.parse(row.fields_json));
		for (const field of fields)
			if (field.type === "checkbox" && typeof values[field.id] === "string") {
				try {
					values[field.id] = JSON.parse(values[field.id] as string);
				} catch {
					throw new Error("ui_response_invalid");
				}
			}
		const allowed = new Set(fields.map((f) => f.id));
		if (Object.keys(values).some((key) => !allowed.has(key)))
			throw new Error("ui_response_unknown_field");
		for (const field of fields) {
			const value = values[field.id];
			if (
				field.required &&
				(value === undefined ||
					value === "" ||
					(Array.isArray(value) && value.length === 0) ||
					value === false)
			)
				throw new Error("ui_response_required");
			if (value === undefined) continue;
			if (
				field.type === "checkbox"
					? !Array.isArray(value) ||
						value.some((v) => !field.options?.includes(v))
					: field.type === "boolean"
						? typeof value !== "boolean"
						: typeof value !== "string" ||
							value.length > 2000 ||
							(["select", "radio"].includes(field.type) &&
								!field.options?.includes(value))
			)
				throw new Error("ui_response_invalid");
		}
		db.query(
			"INSERT INTO ui_composition_responses(id,composition_id,generation,values_json,created_at) VALUES(?,?,?,?,?)",
		).run(requestId, id, row.generation, JSON.stringify(values), Date.now());
		const accepted = {
			projectId: id,
			state: "submitted",
			responseId: requestId,
		};
		saveReceipt(db, requestId, accepted);
		return {
			projectId: id,
			responseId: requestId,
			receipt: accepted,
			replay: false,
		};
	}
	return {
		composeInTransaction,
		cancelInTransaction,
		submitInTransaction,
		list: () => store.read((db) => list(db, scope).map(item)),
		get: (id: string) =>
			store.read((db) => {
				const row = get(db, id);
				return row?.scope === scope ? item(row) : null;
			}),
		listInTransaction: (db: Database) => list(db, scope).map(item),
		getInTransaction: (db: Database, id: string) => {
			const row = get(db, id);
			return row?.scope === scope ? item(row) : null;
		},
		getByRequestInTransaction: (db: Database, requestId: string) => {
			const row = db
				.query("SELECT * FROM ui_compositions WHERE scope=? AND request_id=?")
				.get(scope, requestId) as CompositionRow | null;
			return row ? item(row) : null;
		},
		responseInTransaction: (db: Database, id: string) =>
			db
				.query(
					"SELECT id,composition_id,generation FROM ui_composition_responses WHERE id=?",
				)
				.get(id),
		receiptInTransaction: (db: Database, id: string) => receipt(db, id),
		wake: () => queue.wake(),
	};
}
export type UiCompositionsService = ReturnType<typeof createUiCompositions>;
