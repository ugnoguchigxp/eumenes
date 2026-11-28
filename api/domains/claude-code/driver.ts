import { workWorkspace } from "./lifecycle";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { codingCanonicalJSON } from "../coding";
import { type Host, type Runner, type Work } from "./contracts";
import {
	acceptObservation,
	authorityCurrent,
	newId,
	supervisedAuthority,
} from "./lifecycle";
import { read, save } from "./repository";

export async function drive(
	{
		store,
		now,
		cancel,
		cancelDecision,
	}: {
		store: SqliteStore;
		now(): number;
		cancel(db: Database, work: Work, reason: "expired"): void;
		cancelDecision(db: Database, jobId: string): void;
	},
	currentHost: Host,
	target: Runner,
	snapshot: Work,
) {
	if (snapshot.effect?.kind === "read_events") {
		await driveReadEvents(store, now, currentHost, target, snapshot);
		return;
	}
	const executionId = snapshot.executionId!;
	const effect = snapshot.effect;
	const current = (db: Database) => {
		const work = read(db, snapshot.id);
		return work?.generation === snapshot.generation &&
			work.executionId === executionId &&
			codingCanonicalJSON(work.effect) === codingCanonicalJSON(effect)
			? work
			: null;
	};
	const authorized = (
		db: Database,
		work: Work,
		action: "continue" | "inspect",
	) =>
		work.deadline > now() &&
		authorityCurrent(currentHost, db, work) &&
		(!work.supervision ||
			(!!work.supervision.lease &&
				workWorkspace(currentHost, work).current?.(
					db,
					work.supervision.lease,
				) === true)) &&
		(action === "continue" ||
			!work.supervision ||
			authorityCurrent(currentHost, db, work, "inspect"));
	const dispatch = store.readSnapshot((db) => {
		const work = current(db);
		if (!work) return null;
		if (effect?.kind === "stop") {
			const owned =
				!work.supervision ||
				supervisedAuthority(currentHost, db, work, "stop", {
					operationId: effect.id,
				}) ||
				(effect.reason !== "cancel" &&
					supervisedAuthority(currentHost, db, work, "view"));
			return owned ? work : null;
		}
		return authorized(db, work, effect ? "continue" : "inspect") ? work : null;
	});
	if (!dispatch) return;
	const presentation = dispatch.supervision?.presentation;
	let observation;
	let replyUnconfirmed = false;
	try {
		if (presentation && !presentation.sent && effect?.kind !== "stop") {
			if (!target.present) return;
			await target.present(
				executionId,
				presentation.questionId,
				presentation.expiresAt,
			);
			const remainsCurrent = await store.write((db) => {
				const work = current(db);
				if (
					!work ||
					!authorized(db, work, "continue") ||
					work.supervision?.presentation?.operationId !==
						presentation.operationId
				)
					return false;
				work.supervision.presentation.sent = true;
				save(db, work, now());
				return true;
			});
			if (!remainsCurrent) return;
		}
		observation =
			effect?.kind === "start"
				? await target.start(effect.operation)
				: effect?.kind === "reply"
					? await target.reply(
							executionId,
							effect.id,
							effect.questionId,
							effect.answer,
						)
					: effect?.kind === "stop"
						? await target.stop(
								executionId,
								effect.id,
								dispatch.supervision?.lease
									? {
											lease: dispatch.supervision.lease,
											authorization: dispatch.supervision.authorization,
										}
									: undefined,
							)
						: await target.inspect(executionId);
	} catch {
		// Preserve the intent on transport failure. An elapsed deadline never authorizes a fresh execution.
		if (
			dispatch.supervision &&
			(effect?.kind === "reply" || (presentation && !presentation.sent)) &&
			effect?.kind !== "stop"
		) {
			try {
				const observed = await target.inspect(executionId);
				// Only the original operation's durable receipt confirms a lost reply response.
				if (
					observed?.question?.id === presentation?.questionId &&
					(presentation?.expiresAt ?? Infinity) > now()
				)
					return;
				observation = observed;
				replyUnconfirmed =
					effect?.kind === "reply" &&
					(observed?.answerReceipt?.operationId !== effect.id ||
						observed.answerReceipt.questionId !== effect.questionId);
			} catch {
				return;
			}
		} else {
			if (effect?.kind !== "stop" || (snapshot.stopAt ?? Infinity) > now())
				return;
			observation = null;
		}
	}
	if (
		effect?.kind === "stop" &&
		(snapshot.stopAt ?? Infinity) <= now() &&
		!observation?.managedExecutionStopped
	)
		observation = null;
	if (
		observation?.toolRequests?.length &&
		dispatch.supervision?.lease &&
		target.approveTool &&
		effect?.kind !== "stop"
	) {
		const lease = dispatch.supervision.lease;
		for (const request of observation.toolRequests) {
			const allowed = store.readSnapshot((db) => {
				const work = current(db);
				return (
					work &&
					authorized(db, work, "continue") &&
					codingCanonicalJSON(observation.supervised?.lease) ===
						codingCanonicalJSON(lease)
				);
			});
			if (!allowed) break;
			try {
				await target.approveTool(executionId, request.id, lease);
			} catch {
				break;
			}
		}
	}
	await store.write((db) => {
		const work = current(db);
		if (!work || (effect?.kind !== "stop" && !authorized(db, work, "inspect")))
			return;
		if (
			replyUnconfirmed &&
			work.supervision?.answerDelivery?.state === "pending"
		) {
			work.supervision.answerDelivery.state = "failed";
			cancel(db, work, "expired");
			work.notice = newId();
			save(db, work, now());
			return;
		}
		if (!acceptObservation(db, currentHost, work, observation, now())) return;
		if (
			work.status !== "waiting_child" &&
			snapshot.decisionMode === "progress" &&
			snapshot.decisionId
		) {
			cancelDecision(db, snapshot.decisionId);
			if (work.decisionId === snapshot.decisionId) work.decisionId = null;
		}
		work.observedAt = now();
		save(db, work, now());
	});
}

export async function recover(
	store: SqliteStore,
	currentHost: Host,
	runner: Runner,
	id: string,
	proof: "process_exit" | "host_reboot",
	owned: (db: Database) => boolean,
	now: () => number,
) {
	if (!runner.recover) return false;
	const snapshot = store.readSnapshot((db) =>
		owned(db) ? read(db, id) : null,
	);
	const executionId = snapshot?.executionId;
	const lease = snapshot?.supervision?.lease;
	if (!executionId || !lease) return false;
	if (snapshot.stop === "confirmed") return true;
	if (snapshot.stop !== "unconfirmed") return false;
	const observation = await runner.recover(executionId, lease, proof);
	if (
		observation.executionId !== executionId ||
		observation.state !== "stopped" ||
		!observation.managedExecutionStopped ||
		codingCanonicalJSON(observation.supervised?.lease) !==
			codingCanonicalJSON(lease)
	)
		return false;
	return store.write((db) => {
		if (!owned(db)) return false;
		const work = read(db, id);
		if (
			!work ||
			work.executionId !== executionId ||
			codingCanonicalJSON(work.supervision?.lease) !==
				codingCanonicalJSON(lease)
		)
			return false;
		if (work.stop === "confirmed") return true;
		if (
			work.stop !== "unconfirmed" ||
			!workWorkspace(currentHost, work).recover?.(db, lease)
		)
			return false;
		work.stop = "confirmed";
		if (work.works) work.idlePending = true;
		work.summary = "実行の停止を確認しました。結果は中断です。";
		work.observedAt = now();
		work.observation = observation;
		work.notice = newId();
		save(db, work, now());
		return true;
	});
}

export async function tryRecovery(
	recover: (proof: "process_exit" | "host_reboot") => Promise<boolean>,
) {
	for (const proof of ["process_exit", "host_reboot"] as const) {
		try {
			if (await recover(proof)) return;
		} catch {
			// Until proof is available, this holder stays quarantined.
		}
	}
}

async function driveReadEvents(
	store: SqliteStore,
	now: () => number,
	currentHost: Host,
	target: Runner,
	snapshot: Work,
) {
	const effect = snapshot.effect;
	if (effect?.kind !== "read_events") return;
	const current = (db: Database) => {
		const work = read(db, snapshot.id);
		return work?.generation === snapshot.generation &&
			codingCanonicalJSON(work.effect) === codingCanonicalJSON(effect) &&
			work.deadline > now() &&
			authorityCurrent(currentHost, db, work, "inspect")
			? work
			: null;
	};
	if (!store.readSnapshot(current)) return;
	let fetched: Awaited<ReturnType<NonNullable<Runner["events"]>>> | null = null;
	try {
		fetched = target.events
			? await target.events(effect.executionId, effect.after)
			: null;
	} catch {
		fetched = null;
	}
	await store.write((db) => {
		const work = current(db);
		if (!work) return;
		work.effect = null;
		if (fetched) {
			const existing = new Map(
				(work.eventExcerpts ?? []).map((item) => [
					`${item.executionId}:${item.seq}`,
					item,
				]),
			);
			const knownRefs = new Set(work.knownEvidenceRefs ?? []);
			for (const item of fetched.events) {
				const ref = `${effect.executionId}:${item.seq}`;
				existing.set(ref, {
					executionId: effect.executionId,
					seq: item.seq,
					text: item.text.slice(0, 2_000),
				});
				knownRefs.add(ref);
			}
			work.eventExcerpts = [...existing.values()].slice(-16);
			work.knownEvidenceRefs = [...knownRefs].slice(-128);
			work.eventCursor = fetched.next;
		} else {
			work.eventCursor = -1;
		}
		work.observedAt = now();
		save(db, work, now());
	});
}
