import { expect, test } from "bun:test";
import {
	collectorHarness,
	idleSnapshot,
	eventsPage,
	NOW,
} from "./larm.fixture";
import { larmItems } from "../service/larm-items";

test("cursor expiry preserves known same-boot GPU facts; an explicit restart makes the old snapshot unknown", async () => {
	const h = collectorHarness();
	let stage = 0;
	h.setSnapshot(async () => {
		const snapshot = idleSnapshot();
		snapshot.generatedAt = new Date(h.now()).toISOString();
		return Response.json(snapshot);
	});
	h.setEvents(async () => {
		if (stage) {
			return Response.json(
				{
					error: {
						code:
							stage === 1
								? "monitoring_cursor_expired"
								: "monitoring_epoch_changed",
						message: "history unavailable",
						bootEpoch: stage === 1 ? "epoch-example" : "new-epoch",
						reasonCode: stage === 1 ? "capacity_evicted" : "daemon_restart",
						supportedContractVersions: ["larm-monitoring.v1"],
						recovery: "restart_window",
					},
				},
				{ status: stage === 1 ? 410 : 409 },
			);
		}
		const page = eventsPage(),
			snapshot = idleSnapshot(),
			event = structuredClone(page.events[1]!);
		event.id = "epoch-example:43";
		event.sequence = "43";
		event.kind = "gpu.reset_observed";
		event.workId = null;
		event.outcome = "observed";
		event.target = {
			type: "gpu",
			id: snapshot.nodes[0]!.gpus.value![0]!.id,
			nodeId: snapshot.nodes[0]!.nodeId,
		};
		event.occurredAt = new Date(NOW - 1000).toISOString();
		page.events.push(event);
		page.window.highWaterSequence = "43";
		return Response.json(page);
	});
	const gpu = async () =>
		larmItems(await h.collector.read(), {}, h.now()).find(
			(i) => i.shape === "larm-gpu",
		)!.state;
	expect((await gpu()).health).toBe("fault");
	stage = 1;
	h.advance();
	expect((await gpu()).health).toBe("fault");
	expect((await h.collector.read()).gaps.at(-1)?.detail).toBe(
		"capacity_evicted",
	);
	stage = 2;
	h.advance();
	const restarted = await gpu();
	expect(restarted.health).toBe("unknown");
	expect(restarted.stale).toBe(true);
});
