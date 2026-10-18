import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	monitoringContractJsonSchema,
	monitoringSnapshotSchema,
	monitoringEventsSchema,
	monitoringErrorSchema,
} from "../contracts/monitoring-v1";
import { createMonitoringClient } from "../service/monitoring";
const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(
			new URL(
				`../../../../spec/reference/larm-monitoring-v1/${name}.json`,
				import.meta.url,
			),
			"utf8",
		),
	);
test("canonical source generates the exact published JSON Schema and accepts every handoff example", () => {
	expect(fixture("responses.schema")).toEqual(monitoringContractJsonSchema());
	for (const name of [
		"snapshot-idle",
		"snapshot-partial",
		"snapshot-unsupported",
	])
		expect(monitoringSnapshotSchema.safeParse(fixture(name)).success).toBe(
			true,
		);
	expect(
		monitoringEventsSchema.safeParse(fixture("events-cancelled")).success,
	).toBe(true);
	for (const name of ["cursor-expired", "epoch-changed"])
		expect(monitoringErrorSchema.safeParse(fixture(name)).success).toBe(true);
});
test("availability, CPU interval and unknown fields are enforced; large counters remain strings", () => {
	const s = monitoringSnapshotSchema.parse(fixture("snapshot-idle"));
	s.nodes[0]!.memory.oomKills.value = "90071992547409931234567890";
	expect(
		monitoringSnapshotSchema.parse(s).nodes[0]!.memory.oomKills.value,
	).toBe("90071992547409931234567890");
	delete s.nodes[0]!.cpu.utilization.value;
	expect(monitoringSnapshotSchema.safeParse(s).success).toBe(false);
	const other = monitoringSnapshotSchema.parse(fixture("snapshot-idle"));
	other.nodes[0]!.cpu.utilization.interval = null;
	expect(monitoringSnapshotSchema.safeParse(other).success).toBe(false);
	expect(
		monitoringSnapshotSchema.safeParse({
			...(fixture("snapshot-idle") as object),
			credential: "canary",
		}).success,
	).toBe(false);
});
test("only monitoring GETs use the existing Control bearer and an encoded cursor, without body or redirects", async () => {
	const calls: { url: URL; init?: RequestInit }[] = [];
	const c = createMonitoringClient({
		baseUrl: "http://127.0.0.1:19231",
		token: "existing-control-canary",
		lifetime: new AbortController().signal,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			calls.push({ url, init });
			return Response.json(
				fixture(
					url.pathname.endsWith("snapshot")
						? "snapshot-idle"
						: "events-cancelled",
				),
			);
		},
	});
	expect((await c.snapshot()).status).toBe("ok");
	expect((await c.events("opaque+/=&cursor")).status).toBe("ok");
	expect(calls).toHaveLength(2);
	for (const { url, init } of calls) {
		expect(url.origin).toBe("http://127.0.0.1:19231");
		expect(init?.method).toBe("GET");
		expect(init?.body).toBeUndefined();
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer existing-control-canary",
		);
	}
	expect(calls[1]!.url.searchParams.get("cursor")).toBe("opaque+/=&cursor");
});
test("HTTP status survives malformed error bodies; 410, Retry-After and cancellation are distinct", async () => {
	for (const [http, status] of [
		[401, "unauthorized"],
		[403, "forbidden"],
		[404, "not_found"],
		[406, "unsupported_contract"],
		[429, "rate_limited"],
		[503, "unavailable"],
	] as const) {
		const c = createMonitoringClient({
			baseUrl: "http://127.0.0.1:19231",
			token: "existing-control",
			lifetime: new AbortController().signal,
			fetch: async () => new Response("untrusted body", { status: http }),
		});
		expect((await c.snapshot()).status).toBe(status);
	}
	const c = createMonitoringClient({
		baseUrl: "http://127.0.0.1:19231",
		token: "existing-control",
		lifetime: new AbortController().signal,
		fetch: async () =>
			Response.json(fixture("cursor-expired"), {
				status: 410,
				headers: { "Retry-After": "120" },
			}),
	});
	expect(await c.events("old")).toMatchObject({
		httpStatus: 410,
		errorCode: "monitoring_cursor_expired",
		retryAfterMs: 120000,
	});
	const lifetime = new AbortController();
	const pending = createMonitoringClient({
		baseUrl: "http://127.0.0.1:19231",
		token: "existing-control",
		lifetime: lifetime.signal,
		fetch: async () => new Promise(() => {}),
	}).snapshot();
	lifetime.abort();
	await expect(pending).rejects.toThrow();
});
