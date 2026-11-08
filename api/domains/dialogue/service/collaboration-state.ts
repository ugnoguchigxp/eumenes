import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hash as sourceDigest } from "../../capabilities";
import {
	collaborationStateSchema,
	forgetStateSources,
	proposeStateUpdate,
	withinJsonLimits,
	type CollaborationState,
	type StateHostContext,
} from "eumenes-collaboration";
import { byId, sessionById, type SessionRecord } from "../repository";
import {
	collaborationState,
	collaborationSources,
} from "../repository/collaboration-state";
import type { DialogueDeps } from "./context";
import { specialistExecutionSource } from "./specialist-source";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => {
	throw new Error(reason);
};

/** Only real message versions are registered; the same message edited later has a new source ref. */
export function collaborationSnapshot(
	deps: DialogueDeps,
	db: Database,
	session: SessionRecord,
	runId: string,
) {
	const port = deps.specialist!;
	const set = port.setInTransaction(db, session.toolchainRevisionId);
	const document = set.agent.document
		? port
				.documentOf(session.adapterRef)
				?.readInTransaction(db, session.workRef)
		: null;
	const work = port.workStateInTransaction(
		db,
		session.adapterRef,
		session.workRef,
	);
	if (!work) throw new Error("work_missing");
	const raw = document?.text ?? JSON.stringify(work.current);
	const version = (work as { revision?: number }).revision;
	const workVersion = {
		ref: session.workRef,
		revision:
			document?.revision ??
			(Number.isSafeInteger(version) && version! >= 0 ? version! : 0),
		digest: hash(raw),
	};
	let row = collaborationState(db, session.id);
	if (!row) {
		const state: CollaborationState = {
			stateSchemaVersion: 1,
			coreContractVersion: 1,
			packageVersion: "0.4.0",
			sessionId: session.id,
			revision: 0,
			sourceRevision: 0,
			work: workVersion,
			facts: [],
		};
		db.query(
			"INSERT INTO dialogue_collaboration_states(session_id,body,source_revision) VALUES(?,?,0)",
		).run(session.id, JSON.stringify(state));
		row = collaborationState(db, session.id)!;
	}
	if (!withinJsonLimits(JSON.parse(row.body))) fail("json_resource_limit");
	let saved = collaborationStateSchema.parse(JSON.parse(row.body));
	let sourceRevision = row.source_revision;
	const invalid = new Set<string>();
	for (const source of collaborationSources(db, session.id)) {
		const message = deps.conversation.messageInTransaction(
			db,
			source.message_id,
		)?.message;
		if (
			!source.active ||
			!message ||
			message.role !== "user" ||
			message.conversationId !== session.conversationId ||
			sourceDigest(message.text) !== source.digest ||
			deps.memory?.isSourceRevokedInTransaction(db, source.message_id)
		)
			invalid.add(source.ref);
	}
	// Inactive refs stay inactive, but need not bump the generation on every read.
	const newlyInvalid = collaborationSources(db, session.id).filter(
		(s) => s.active && invalid.has(s.ref),
	);
	if (newlyInvalid.length) {
		sourceRevision++;
		const forgotten = forgetStateSources(saved, {
			sessionId: session.id,
			expectedRevision: saved.revision,
			invalidRefs: invalid,
			sourceRevision,
		});
		for (const ref of invalid)
			db.query(
				"UPDATE dialogue_collaboration_sources SET active=0 WHERE session_id=? AND ref=?",
			).run(session.id, ref);
		saved = forgotten.state;
		db.query(
			"UPDATE dialogue_collaboration_states SET body=?,source_revision=?,orphaned=? WHERE session_id=?",
		).run(
			JSON.stringify(saved),
			sourceRevision,
			JSON.stringify(forgotten.orphaned),
			session.id,
		);
	}
	const source = specialistExecutionSource(
		deps,
		db,
		runId,
		session.id,
		session.epoch,
	);
	if (!source) throw new Error("collaboration_source_invalid");
	const ref = `${source.messageId}:${source.digest}`;
	if (!collaborationSources(db, session.id).some((s) => s.ref === ref)) {
		sourceRevision++;
		db.query(
			"INSERT INTO dialogue_collaboration_sources VALUES(?,?,?,?,1)",
		).run(session.id, ref, source.messageId, source.digest);
		db.query(
			"UPDATE dialogue_collaboration_states SET source_revision=? WHERE session_id=?",
		).run(sourceRevision, session.id);
	}
	const sources = collaborationSources(db, session.id);
	const host: StateHostContext = {
		sessionId: session.id,
		epoch: session.epoch,
		sourceRevision,
		work: workVersion,
		sources: sources.map((s) => ({
			ref: s.ref,
			kind: "user",
			active: !!s.active,
		})),
	};
	const sourceText = sources
		.filter((s) => s.active)
		.map((s) => ({
			ref: s.ref,
			text: deps.conversation.messageInTransaction(db, s.message_id)!.message
				.text,
		}));
	return {
		state: saved,
		host,
		sourceText,
		reconfirm: JSON.parse(
			collaborationState(db, session.id)!.orphaned,
		) as string[],
	};
}

export function collaborationReference(
	snapshot: ReturnType<typeof collaborationSnapshot>,
) {
	const { state, host, sourceText, reconfirm } = snapshot;
	const text =
		"\nCOLLABORATION_STATE=" +
		JSON.stringify(state) +
		"\nSOURCE_REGISTRY=" +
		JSON.stringify({ host, sourceText }) +
		"\nRECONFIRM=" +
		JSON.stringify(reconfirm);
	if (!withinJsonLimits({ state, host, sourceText, reconfirm }))
		fail("json_resource_limit");
	return text;
}

/** The caller's writer also checks the live run and control receipt before reaching this boundary. */
export function adoptCollaborationState(
	deps: DialogueDeps,
	db: Database,
	input: {
		sessionId: string;
		epoch: number;
		runId: string;
		operationId: string;
	},
	proposal: unknown,
) {
	if (!withinJsonLimits(proposal))
		return { ok: false as const, reason: "json_resource_limit" };
	const session = sessionById(db, input.sessionId),
		run = byId(db, input.runId);
	if (
		!session ||
		session.epoch !== input.epoch ||
		session.state !== "active" ||
		session.activeRunId !== input.runId ||
		run?.status !== "running"
	)
		return { ok: false as const, reason: "session_changed" };
	const snapshot = collaborationSnapshot(deps, db, session, input.runId);
	const digest = hash(JSON.stringify(proposal));
	const previous = db
		.query<
			{ session_id: string; epoch: number; digest: string; revision: number },
			[string]
		>(
			"SELECT session_id,epoch,digest,revision FROM dialogue_collaboration_receipts WHERE operation_id=?",
		)
		.get(input.operationId);
	if (previous)
		return previous.session_id === input.sessionId &&
			previous.epoch === input.epoch &&
			previous.digest === digest
			? { ok: true as const, replay: true, revision: previous.revision }
			: { ok: false as const, reason: "operation_identity_conflict" };
	const checked = proposeStateUpdate(snapshot.state, proposal, snapshot.host);
	if (!checked.ok) return checked;
	db.query(
		"UPDATE dialogue_collaboration_states SET body=?,orphaned='[]' WHERE session_id=?",
	).run(JSON.stringify(checked.state), session.id);
	db.query("INSERT INTO dialogue_collaboration_receipts VALUES(?,?,?,?,?)").run(
		input.operationId,
		session.id,
		session.epoch,
		digest,
		checked.state.revision,
	);
	return { ok: true as const, replay: false, revision: checked.state.revision };
}

/** Invoked by the real memory purge, in the same writer transaction as source revocation. */
export function forgetCollaborationState(
	db: Database,
	messageIds: readonly string[],
) {
	const bySession = new Map<string, Set<string>>();
	for (const id of messageIds)
		for (const source of db
			.query<{ session_id: string; ref: string }, [string]>(
				"SELECT session_id,ref FROM dialogue_collaboration_sources WHERE message_id=? AND active=1",
			)
			.all(id)) {
			if (!bySession.has(source.session_id))
				bySession.set(source.session_id, new Set());
			bySession.get(source.session_id)!.add(source.ref);
		}
	for (const [sessionId, invalidRefs] of bySession) {
		const row = collaborationState(db, sessionId)!;
		const result = forgetStateSources(JSON.parse(row.body), {
			sessionId,
			expectedRevision: collaborationStateSchema.parse(JSON.parse(row.body))
				.revision,
			invalidRefs,
			sourceRevision: row.source_revision + 1,
		});
		for (const ref of invalidRefs)
			db.query(
				"UPDATE dialogue_collaboration_sources SET active=0 WHERE session_id=? AND ref=?",
			).run(sessionId, ref);
		db.query(
			"UPDATE dialogue_collaboration_states SET body=?,source_revision=?,orphaned=? WHERE session_id=?",
		).run(
			JSON.stringify(result.state),
			row.source_revision + 1,
			JSON.stringify(result.orphaned),
			sessionId,
		);
	}
}
