import type { Database } from "bun:sqlite";
import type { AgencyRecord } from "../../domains/dialogue";
import { currentInput, fixedInput } from "./input";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { deliverAlwaysOn } from "./always-on-flow";
import { alwaysOnRecord, type AlwaysOnScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
const log = getLogger("agency");
type CycleHost = {
	deps: AgencyHostDeps;
	convs: Map<string, AlwaysOnScope>;
	on(): boolean;
	now(): number;
	busy(c: AlwaysOnScope): boolean;
	refresh(c: AlwaysOnScope): Promise<void>;
	digest(): string;
	save(): Promise<boolean>;
	active(): string | null;
};
type ResultHost = Pick<CycleHost, "deps" | "convs" | "now"> & {
	hostDigest: string;
	conv(id: string): AlwaysOnScope;
	make(id: string, previous: AgencyRecord): AlwaysOnScope;
	invalidate(c: AlwaysOnScope): void;
	saveInTransaction(db: Database): void;
	collected(): void;
};
export async function runAlwaysOnCycle(host: CycleHost, c: AlwaysOnScope) {
	const { deps, convs, on, now, busy, refresh, digest, save, active } = host;
	if (!on() || convs.get(c.id) !== c || c.id !== active()) return null;
	await refresh(c);
	if (busy(c)) return null;
	const generation = c.generation;
	const ordinal = deps.store.read((db) =>
		deps.conversation.latestOrdinalInTransaction(db, c.id),
	);
	const beforeSettings = digest();
	const controller = new AbortController();
	c.controller = controller;
	c.revision++;
	try {
		const out = await c.agent.tick(
			now(),
			() => ({ busy: busy(c) || c.id !== active() }),
			controller.signal,
		);
		c.revision++;
		if (out.call)
			log.info("agency.llm_call", {
				subjectId: c.id,
				purpose: "think",
				outcome: out.call.code,
				durationMs: out.call.latencyMs,
				promptTokens: out.call.inputTokens,
				completionTokens: out.call.outputTokens,
			});
		if (out.ticket) {
			c.tickets.push(out.ticket);
			await deliverAlwaysOn({
				deps,
				c,
				ticket: out.ticket,
				at: now(),
				save,
				current: (speech, db) =>
					on() &&
					convs.get(c.id) === c &&
					c.generation === generation &&
					!controller.signal.aborted &&
					digest() === beforeSettings &&
					fixedInput({
						agency: deps.settings.inTransaction(db).agency,
						general: deps.settings.inTransaction(db).general,
					}).sources[0] === beforeSettings &&
					deps.store.read(
						(db) =>
							currentInput(deps, db, {
								sources: out.ticket!.inputs,
								complete: true,
							}) &&
							deps.conversation.latestOrdinalInTransaction(db, c.id) ===
								ordinal,
					) &&
					(!speech || (active() === c.id && !busy(c))),
			});
		}
		return { next: out.next, wakeAt: out.wakeAt };
	} catch (error) {
		if (!controller.signal.aborted)
			log.warn("agency.cycle_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "agency_cycle_failed"),
			});
		return null;
	} finally {
		if (c.controller === controller) c.controller = null;
		c.revision++;
		if (on() && convs.get(c.id) === c)
			await save().catch((error) =>
				log.warn("agency.checkpoint_failed", {
					reason: toErrorCode(error, "checkpoint_failed"),
				}),
			);
	}
}
export async function collectAlwaysOnResults(host: ResultHost) {
	const {
		deps,
		convs,
		now,
		hostDigest,
		conv,
		make,
		invalidate,
		saveInTransaction,
		collected,
	} = host;
	if (!deps.state) return;
	const results = deps.store.read((db) => deps.state!.resultsInTransaction(db));
	if (!results.length) return;
	const before = [...convs.values()].map((c) => alwaysOnRecord(c, hostDigest));
	try {
		await deps.store.write((db) => {
			for (const r of deps.state!.resultsInTransaction(db)) {
				const c = conv(r.conversationId);
				if (c.epoch !== r.epoch) continue;
				const t = c.tickets.find((t) => t.id === r.ticketId);
				if (
					!t ||
					!currentInput(deps, db, { sources: t.inputs, complete: true })
				) {
					deps.state!.cancelInTransaction(db, r.rootId);
					deps.state!.returnedInTransaction(db, r.rootId);
					continue;
				}
				if (r.cancel) deps.state!.cancelInTransaction(db, r.rootId);
				const adopted = deps.state!.returnedInTransaction(db, r.rootId);
				c.agent.workReturned({
					ticketId: r.ticketId,
					at: now(),
					status:
						adopted && r.workStatus === "succeeded"
							? "succeeded"
							: adopted && r.workStatus === "partial"
								? "partial"
								: "failed",
					summary: adopted ? r.summary : "agency_result_invalidated",
				});
				c.revision++;
				c.heartbeat.event(now());
			}
			saveInTransaction(db);
		});
		collected();
	} catch (error) {
		// Volatile core changes must roll back with the writer, including failed result adoption.
		for (const c of convs.values()) {
			invalidate(c);
			c.scheduler.dispose();
		}
		convs.clear();
		for (const record of before) make(record.conversationId, record);
		throw error;
	}
}
