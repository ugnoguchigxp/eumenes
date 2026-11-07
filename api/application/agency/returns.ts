import { persistMemory, resultInput } from "./memory";
import { staleInputSources } from "./input";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { snapshotRefs } from "./research";
import type { AgencyHostDeps, Conv } from "./host-types";
import type { Opportunity } from "eumenes-agency";
export function createResultCollector(input: {
	deps: AgencyHostDeps;
	convs: Map<string, Conv>;
	convOf(id: string): Conv;
	dropConv(c: Conv, reason: string): void;
	launch(c: Conv, trigger: Opportunity["trigger"]): void;
	nowMs(): number;
	digest(): string;
	inflight: Set<Promise<unknown>>;
}) {
	const { deps, convs, convOf, dropConv, launch, nowMs, digest, inflight } =
		input;
	const { store } = deps;
	const log = getLogger("agency");
	let returning = false;
	function collectReturns() {
		if (returning || !deps.state) return;
		const results = store.read((db) => deps.state!.resultsInTransaction(db));
		if (!results.length) return;
		returning = true;
		const task = store
			.write((db) => {
				for (const r of deps.state!.resultsInTransaction(db)) {
					const c = convs.get(r.conversationId) ?? convOf(r.conversationId);
					if (
						c.epoch !== r.epoch ||
						deps.state!.epochInTransaction(db, c.id) !== c.epoch
					)
						continue;
					const origin = resultInput(c, r.ticketId);
					const stale = staleInputSources(deps, db, origin.sources);
					if (stale.length) {
						deps.state!.forgetInTransaction(db, {
							messageIds: [],
							itemIds: [],
							sourceRefs: stale,
						});
						dropConv(c, "source_changed");
						continue;
					}
					if (r.cancel) deps.state!.cancelInTransaction(db, r.rootId);
					// Adopt while the persisted intent still authorizes evidence reads;
					// recording work.returned below releases that authority in this same write.
					const adopted = deps.state!.returnedInTransaction(db, r.rootId);
					const summary = adopted ? r.summary : "agency_result_invalidated";

					c.runtime.observe(
						{
							id: `return:${r.rootId}`,
							kind: "work.returned",
							actor: "tool",
							occurredAt: nowMs(),
							workRef: r.ticketId,
							workStatus: adopted ? r.workStatus : "failed",
							text: summary,
						},
						resultInput(c, r.ticketId),
					);
					c.runtime.recordResult(
						{
							ticketId: r.ticketId,
							status: adopted ? r.status : "failed",
							at: nowMs(),
							resultText: summary,
						},
						resultInput(c, r.ticketId),
					);
					if (
						!deps.state!.saveInTransaction(
							db,
							persistMemory(deps, db, {
								conversationId: c.id,
								epoch: c.epoch,
								scope: c.scope,
								snapshot: c.runtime.snapshot(),
								idle: c.planner.checkpoint(),
								settingsDigest: digest(),
								sourceRefs: snapshotRefs(c.runtime),
							}),
							nowMs(),
						)
					)
						throw new Error("agency_checkpoint_stale");
				}
			})
			.then(() => {
				for (const r of results) {
					const c = convs.get(r.conversationId);
					if (c) launch(c, "review_due");
				}
			})
			.catch((error) => {
				for (const r of results) {
					const c = convs.get(r.conversationId);
					if (c) dropConv(c, "return_checkpoint_failed");
				}
				log.warn("agency.return_failed", {
					reason: toErrorCode(error, "return_failed"),
				});
			})
			.finally(() => {
				returning = false;
			});
		inflight.add(task);
		task.finally(() => inflight.delete(task));
	}

	return collectReturns;
}
