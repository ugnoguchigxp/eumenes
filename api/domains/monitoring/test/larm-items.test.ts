import { expect, test } from "bun:test";
import {
	collectorHarness,
	idleSnapshot,
	eventsPage,
	NOW,
} from "./larm.fixture";
import { larmItems } from "../service/larm-items";
const states = (items: ReturnType<typeof larmItems>) =>
	Object.fromEntries(items.map((i) => [i.shape, i.state]));

test("a slow response cannot make a sample younger than its validity period", async () => {
	const h = collectorHarness();
	h.setSnapshot(async () => {
		const s = idleSnapshot();
		s.nodes[0]!.cpu.utilization.observedAt = new Date(NOW - 8000).toISOString();
		h.advance(3000);
		return Response.json(s);
	});
	const view = await h.collector.read();
	expect(states(larmItems(view, {}, h.now()))["larm-cpu"]?.stale).toBe(true);
});
test("the four shapes use measured zeros and RAM alone, retain quality, and never invent GPU work", async () => {
	const h = collectorHarness();
	h.setSnapshot(async () => {
		const s = idleSnapshot();
		s.nodes[0]!.cpu.utilization.value = 0;
		s.nodes[0]!.gpus.value![0]!.utilization.value = 0;
		s.core.activeWorkloads.value = 2;
		return Response.json(s);
	});
	const view = await h.collector.read(),
		s = states(larmItems(view, {}, NOW));
	expect(s["larm-cpu"]?.utilization).toBe(0);
	expect(s["larm-gpu"]?.utilization).toBe(0);
	expect(s["larm-gpu"]?.activity).toBe("idle");
	expect(s["larm-core"]?.activity).toBe("working");
	const m = view.snapshot!.nodes[0]!.memory;
	expect(s["larm-memory"]?.utilization).toBeCloseTo(
		1 - m.memAvailable.value! / m.memTotal.value!,
	);
	expect(states(larmItems(view, {}, NOW + 10001))["larm-cpu"]?.stale).toBe(
		true,
	);
	expect(s["larm-cpu"]?.observations?.[0]?.observedAt).toBe(
		Date.parse(view.snapshot!.nodes[0]!.cpu.utilization.observedAt!),
	);
});
test("a fresh HTTP response cannot refresh old samples; unavailable is unknown and auth is not disconnection", async () => {
	const h = collectorHarness();
	await h.collector.read();
	h.advance();
	h.setSnapshot(async () => {
		const s = idleSnapshot();
		s.generatedAt = new Date(NOW + 60000).toISOString();
		const o = s.nodes[0]!.cpu.utilization;
		o.status = "permission_denied";
		o.observedAt = null;
		o.interval = null;
		delete o.value;
		return Response.json(s);
	});
	const view = await h.collector.read(),
		s = states(larmItems(view, {}, h.now()));
	expect(s["larm-cpu"]?.health).toBe("unknown");
	expect(s["larm-cpu"]?.utilization).toBeUndefined();
	expect(s["larm-memory"]?.stale).toBe(true);
	h.advance();
	h.setSnapshot(async () => Response.json({}, { status: 401 }));
	const auth = states(larmItems(await h.collector.read(), {}, h.now()));
	expect(auth["larm-core"]?.health).toBe("unknown");
	expect(auth["larm-core"]?.reason).toBe("unauthorized");
});
test("multiple nodes or GPUs require IDs, while STOPPING and unloaded models are not faults", async () => {
	const h = collectorHarness();
	h.setSnapshot(async () => {
		const s = idleSnapshot(),
			other = structuredClone(s.nodes[0]!);
		other.nodeId = "another-node";
		s.nodes.push(other);
		s.core.runtimes[0]!.status.value = "STOPPING";
		s.core.runtimes[0]!.modelLoadState = {
			...s.core.runtimes[0]!.status,
			value: "unloaded",
		};
		return Response.json(s);
	});
	const view = await h.collector.read();
	expect(states(larmItems(view, {}, NOW))["larm-cpu"]?.reason).toBe(
		"selection_required",
	);
	const s = states(
		larmItems(view, { monitoringNodeId: idleSnapshot().nodes[0]!.nodeId }, NOW),
	);
	expect(s["larm-cpu"]?.health).toBe("healthy");
	expect(s["larm-core"]?.health).toBe("healthy");
});
test("only targeted explicit OOM/GPU facts create ten-minute faults, not counters or generic request failures", async () => {
	const h = collectorHarness();
	h.setEvents(async () => {
		const p = eventsPage();
		const base = p.events[1]!;
		const node = idleSnapshot().nodes[0]!;
		const kinds = [
			"host.oom_counter_changed",
			"host.oom_kill_observed",
			"gpu.reset_observed",
		] as const;
		for (const [i, kind] of kinds.entries())
			p.events.push({
				...base,
				id: `epoch-example:${43 + i}`,
				sequence: String(43 + i),
				kind,
				outcome: "observed",
				workId: null,
				target: {
					type: kind.startsWith("gpu") ? "gpu" : "node",
					id: kind.startsWith("gpu") ? node.gpus.value![0]!.id : node.nodeId,
					nodeId: node.nodeId,
				},
				occurredAt: new Date(NOW - 1000).toISOString(),
			});
		p.window.highWaterSequence = "45";
		return Response.json(p);
	});
	const view = await h.collector.read(),
		s = states(larmItems(view, {}, NOW));
	expect(s["larm-memory"]?.health).toBe("fault");
	expect(s["larm-gpu"]?.health).toBe("fault");
	expect(s["larm-core"]?.health).toBe("healthy");
	expect(s["larm-gpu"]?.faultRemainingMs).toBe(599000);
	expect(states(larmItems(view, {}, NOW + 600001))["larm-gpu"]?.health).toBe(
		"healthy",
	);
	view.history.faults = view.history.faults.filter(
		(e) => e.kind === "host.oom_counter_changed",
	);
	expect(states(larmItems(view, {}, NOW))["larm-memory"]?.health).toBe(
		"healthy",
	);
});
