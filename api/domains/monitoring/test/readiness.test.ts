import { expect, test } from "bun:test";
import { defaults } from "../../settings";
import { runtimeReadiness } from "../service/runtime-readiness";
import { routeState } from "../service/route-state";
import { idleSnapshot } from "./larm.fixture";

test("Warm ready requires explicit loaded, HOT and healthy signals; HOT alone remains Ready", () => {
	const s = idleSnapshot();
	const base = s.core.runtimes[0]!;
	s.core.runtimes = [0, 1, 2, 3, 4].map((i) => ({
		...structuredClone(base),
		runtimeId: `runtime-${i}`,
	}));
	for (const r of s.core.runtimes) {
		r.status.value = "HOT";
		r.healthOk.value = true;
		r.modelLoadState.status = "ok";
		r.modelLoadState.observedAt = r.status.observedAt;
	}
	s.core.runtimes[0]!.modelLoadState.value = "loaded";
	s.core.runtimes[1]!.modelLoadState.status = "unsupported";
	s.core.runtimes[1]!.modelLoadState.observedAt = null;
	delete s.core.runtimes[1]!.modelLoadState.value;
	s.core.runtimes[2]!.modelLoadState.value = "unloaded";
	s.core.runtimes[3]!.status.value = "STARTING";
	s.core.runtimes[3]!.modelLoadState.value = "loading";
	s.core.runtimes[4]!.status.value = "STOPPING";
	s.core.runtimes[4]!.modelLoadState.value = "unloaded";
	expect(runtimeReadiness(s)).toEqual([
		{ readiness: "warm_ready", count: 1 },
		{ readiness: "ready", count: 1 },
		{ readiness: "cold", count: 1 },
		{ readiness: "starting", count: 1 },
		{ readiness: "stopping", count: 1 },
	]);
});

test("a held provider communicates Ready without fabricating an execution success or a warm model", () => {
	const s = defaults({});
	const idle = { running: 0, lastSuccessAt: null, lastFailure: null };
	const ready = routeState(
		s,
		"asr",
		idle,
		{ state: "ready", capabilities: ["asr"] },
		true,
		[],
	);
	expect(ready).toMatchObject({
		health: "unknown",
		activity: "idle",
		readiness: "ready",
	});
	const unclaimed = routeState(
		s,
		"tts",
		idle,
		{ state: "ready", capabilities: ["asr"] },
		true,
		[],
	);
	expect(unclaimed.readiness).toBe("configured");
	expect(unclaimed.health).toBe("unknown");
	const failed = routeState(
		s,
		"asr",
		idle,
		{ state: "failed", capabilities: [] },
		true,
		[],
	);
	expect(failed).toMatchObject({
		health: "disconnected",
		readiness: "unknown",
	});
	const unreachable = routeState(
		s,
		"asr",
		{ ...idle, lastFailure: { at: Date.now(), reason: "network_unavailable" } },
		{ state: "ready", capabilities: ["asr"] },
		true,
		[],
	);
	expect(unreachable).toMatchObject({
		health: "disconnected",
		readiness: "unknown",
	});
});
