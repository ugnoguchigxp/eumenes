import type { Database } from "bun:sqlite";
import type { Purpose, Settings } from "../../settings";
import type { SpeechPreparation } from "../../delivery/contracts";
import type {
	BackgroundControl,
	CallSession,
	ControlContract,
	InferencePort,
	Messages,
	Receipt,
	SpeechOverride,
} from "../contracts";
import { get } from "../repository";
import type { Env } from "./execute-types";
import type { createRequestValidity } from "./request-validity";
import { createRequestStatus } from "./request-status";
import { createVoiceBinding } from "./voice-binding";
import { bindControlPolicy } from "./control-policy";
import { captureBackgroundControl } from "./background-control";
import { executeRequest as runRequest } from "./execute";
import { validateReceipt as checkReceipt } from "./receipt-authority";
import { createIndependentControls } from "./independent-control";

/** Each clause gets its own short deadline; the turn's authority is still enforced through `parents`. */
const SPEECH_CHUNK_DEADLINE_MS = 60_000;
/** The most output a control request may ask for (a long draft); the provider's own limit still applies. */
const MAX_CONTROL_OUTPUT_TOKENS = 32_768;
/** The longest one attempt may be given (a toolchain's own limit; its contract allows no more). */
const MAX_ATTEMPT_MS = 3_600_000;
type RequestArgs =
	Parameters<typeof runRequest> extends [unknown, ...infer R] ? R : never;
type ControlArgs = [
	string,
	Messages,
	AbortSignal,
	ControlContract?,
	CallSession?,
];
const runControl = (env: Env, ...[id, m, s, c, session]: ControlArgs) =>
	runRequest(
		env,
		id,
		m,
		s,
		undefined,
		undefined,
		undefined,
		c,
		undefined,
		session,
	);

export function createRequestOperations(
	env: Env,
	{
		valid,
		usable,
	}: Pick<ReturnType<typeof createRequestValidity>, "valid" | "usable">,
) {
	const { store, settings, options, allowed, active } = env;
	function capture(
		db: Database,
		subject: string,
		purpose: Purpose,
		deadline: number,
		snapshot = settings.inTransaction(db),
	) {
		const old = db
			.query("SELECT id FROM inference_requests WHERE subject=? AND purpose=?")
			.get(subject, purpose) as { id: string } | null;
		if (old) return old.id;
		const id = crypto.randomUUID();
		db.query(
			"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES(?,?,?,?,?)",
		).run(id, subject, purpose, JSON.stringify(snapshot), deadline);
		return id;
	}
	const executeRequest = (...args: RequestArgs) => runRequest(env, ...args);
	function validateReceipt(db: Database, receipt: Receipt) {
		const captured = get(db, receipt.requestId);
		if (captured?.controlPolicyRequestId) {
			const policy = get(db, captured.controlPolicyRequestId);
			if (!policy || !allowed(db, policy)) return false;
		}
		return checkReceipt(db, receipt, allowed);
	}
	function accept(db: Database, receipt: Receipt) {
		if (!validateReceipt(db, receipt)) return false;
		db.query("UPDATE inference_attempts SET accepted=1 WHERE id=?").run(
			receipt.attemptId,
		);
		db.query("UPDATE inference_requests SET status='accepted' WHERE id=?").run(
			receipt.requestId,
		);
		return true;
	}
	async function standaloneReceipt(
		purpose: Purpose,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		override?: SpeechOverride,
		preparation?: SpeechPreparation,
	) {
		const id = await store.write((db) => {
			const current = settings.inTransaction(db);
			return capture(
				db,
				crypto.randomUUID(),
				purpose,
				Date.now() + (purpose === "llm" ? 180_000 : 45_000),
				current,
			);
		});
		const receipt = await executeRequest(
			id,
			input,
			signal,
			onDelta,
			preparation,
			undefined,
			undefined,
			override,
		);
		if (!(await store.write((db) => accept(db, receipt))))
			throw new Error("permission_revoked");
		return receipt;
	}
	async function standalone(
		purpose: Purpose,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		override?: SpeechOverride,
	) {
		return (await standaloneReceipt(purpose, input, signal, onDelta, override))
			.value;
	}
	const operations = {
		countControlTokens(messages: Messages) {
			const count = options.countControlTokens?.(messages) ?? null;
			return count !== null && Number.isSafeInteger(count) && count >= 0
				? count
				: null;
		},
		captureBackgroundControlInTransaction(
			db: Database,
			input: BackgroundControl,
		) {
			return captureBackgroundControl(db, input, {
				snapshot: () => structuredClone(settings.inTransaction(db)),
				capture,
			});
		},
		captureControlInTransaction(
			db: Database,
			input: {
				subject: string;
				policySubject: string;
				deadline: number;
				maxOutputTokens: number;
				attemptMs?: number;
			},
		) {
			const policy = db
				.query(
					"SELECT id FROM inference_requests WHERE subject=? AND purpose='llm'",
				)
				.get(input.policySubject) as { id: string } | null;
			const root = policy ? get(db, policy.id) : null;
			if (!root || !allowed(db, root)) throw new Error("permission_revoked");
			const snapshot = structuredClone(root.snapshot);
			const requestId = capture(
				db,
				input.subject,
				"llm",
				Math.min(input.deadline, root.deadline),
				snapshot,
			);
			bindControlPolicy(db, requestId, root.id);
			db.query(
				"UPDATE inference_requests SET mode='control',output_limit=?,attempt_ms=?,context_policy='exact',parents=? WHERE id=? AND status='pending'",
			).run(
				Math.min(MAX_CONTROL_OUTPUT_TOKENS, Math.max(1, input.maxOutputTokens)),
				input.attemptMs === undefined
					? null
					: Math.min(MAX_ATTEMPT_MS, Math.max(1000, input.attemptMs)),
				JSON.stringify(root.parents),
				requestId,
			);
			return requestId;
		},
		extendDeadlineInTransaction(
			db: Database,
			subject: string,
			deadline: number,
		) {
			// Every row of the subject: a control request is bounded by its root's deadline even after the root's answer.
			db.query(
				"UPDATE inference_requests SET deadline=? WHERE subject=? AND deadline<?",
			).run(deadline, subject, deadline);
		},
		...createIndependentControls(settings.inTransaction, capture),
		executeControl(...[id, messages, signal, control, session]: ControlArgs) {
			if (store.read((db) => get(db, id))?.mode !== "control")
				throw new Error("invalid_control_request");
			return runControl(env, id, messages, signal, control, session);
		},
		setContextPolicyInTransaction(
			db: Database,
			requestId: string,
			_policy: "exact",
		) {
			if (
				db
					.query(
						"UPDATE inference_requests SET context_policy='exact' WHERE id=? AND status='pending'",
					)
					.run(requestId).changes !== 1
			)
				throw new Error("permission_revoked");
		},
		flushCancelledRequests(requestIds: string[]) {
			for (const requestId of requestIds)
				if (store.read((db) => get(db, requestId))?.status === "cancelled")
					active.get(requestId)?.controller.abort();
		},
		snapshotFor(db: Database, subject: string) {
			const row = db
				.query(
					"SELECT snapshot FROM inference_requests WHERE subject=? LIMIT 1",
				)
				.get(subject) as { snapshot: string } | null;
			return row ? (JSON.parse(row.snapshot) as Settings) : null;
		},
		bindInTransaction: createVoiceBinding(valid, allowed),
		async cancelSubject(subject: string) {
			await store.write((db) =>
				db
					.query(
						"UPDATE inference_requests SET status='cancelled' WHERE (subject=? OR substr(subject,1,?)=?) AND status='pending'",
					)
					.run(subject, `${subject}:speech:`.length, `${subject}:speech:`),
			);
			for (const a of active.values())
				if (
					a.row.subject === subject ||
					a.row.subject.startsWith(`${subject}:speech:`)
				)
					a.controller.abort();
		},
		captureInTransaction: capture,
		executeRequest: (
			id: string,
			input: Messages | string | Uint8Array,
			signal: AbortSignal,
			preparation?: SpeechPreparation,
			session?: CallSession,
		) =>
			executeRequest(
				id,
				input,
				signal,
				undefined,
				preparation,
				undefined,
				undefined,
				undefined,
				session,
			),
		executeStream: (
			...[
				id,
				messages,
				signal,
				onDelta,
				preparation,
				tools,
				session,
				outputContract,
			]: Parameters<NonNullable<InferencePort["executeStream"]>>
		) =>
			executeRequest(
				id,
				messages,
				signal,
				onDelta,
				preparation,
				tools,
				undefined,
				undefined,
				session,
				outputContract,
			),
		liveRequest: (id: string) => store.read((db) => usable(db, id)),
		captureSpeechChunkInTransaction(
			db: Database,
			voiceSubject: string,
			index: number,
		) {
			const parent = db
				.query(
					"SELECT id FROM inference_requests WHERE subject=? AND purpose='tts'",
				)
				.get(voiceSubject) as { id: string } | null;
			const original = parent ? get(db, parent.id) : null;
			if (!original || !original.parents.every((id) => usable(db, id)))
				throw new Error("permission_revoked");
			const id = capture(
				db,
				`${voiceSubject}:speech:${index}`,
				"tts",
				Math.max(original.deadline, Date.now() + SPEECH_CHUNK_DEADLINE_MS),
				original.snapshot,
			);
			db.query("UPDATE inference_requests SET parents=? WHERE id=?").run(
				JSON.stringify(original.parents),
				id,
			);
			return id;
		},
		acceptInTransaction: accept,
		...createRequestStatus(allowed),
		validateReceiptInTransaction: validateReceipt,
		requestFor(db: Database, subject: string, purpose: Purpose) {
			return (
				(
					db
						.query(
							"SELECT id FROM inference_requests WHERE subject=? AND purpose=?",
						)
						.get(subject, purpose) as { id: string } | null
				)?.id ?? null
			);
		},
		validInTransaction: valid,
		validRequest(id: string) {
			return store.read((db) => valid(db, id));
		},
		answer: (messages: Messages, signal: AbortSignal) =>
			standalone("llm", messages, signal) as Promise<string>,
		answerStream: (
			messages: Messages,
			signal: AbortSignal,
			onDelta: (text: string) => void,
		) => standalone("llm", messages, signal, onDelta) as Promise<string>,
		transcribe: (wav: Uint8Array, signal: AbortSignal) =>
			standalone("asr", wav, signal) as Promise<string>,
	};
	return { capture, executeRequest, accept, standaloneReceipt, operations };
}
