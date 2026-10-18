import { afterEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as settingsMigrations } from "../../settings";
import { createMonitoringClient } from "../../larm";
import {
	monitoringSnapshotSchema,
	monitoringEventsSchema,
} from "../../larm/contracts";
import { migrations, createLarmRepository } from "../repository";
import {
	createLarmCollector,
	type LarmCollectorConfig,
} from "../service/larm-collector";
const raw = (name: string): unknown =>
	JSON.parse(
		readFileSync(
			new URL(
				`../../../../spec/reference/larm-monitoring-v1/${name}.json`,
				import.meta.url,
			),
			"utf8",
		),
	);
export const idleSnapshot = () =>
	monitoringSnapshotSchema.parse(raw("snapshot-idle"));
export const eventsPage = () =>
	monitoringEventsSchema.parse(raw("events-cancelled"));
export const NOW = Date.parse("2026-10-18T08:30:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
export function collectorHarness() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-larm-monitoring-"));
	const store = openStore(join(dir, "db"), [
		...settingsMigrations,
		...migrations,
	]);
	let clock = NOW,
		config: LarmCollectorConfig = {
			baseUrl: "http://127.0.0.1:19231",
			token: "existing-control-canary",
		};
	let changed: (() => void) | undefined;
	const calls: URL[] = [];
	let snapshotReply: () => Promise<Response> = async () =>
		Response.json(idleSnapshot());
	let eventsReply: (url: URL) => Promise<Response> = async () =>
		Response.json(eventsPage());
	const repository = createLarmRepository(store, () => clock);
	const make = () =>
		createLarmCollector({
			config: () => config,
			repository,
			now: () => clock,
			onChange: (callback) => {
				changed = callback;
				return () => {
					changed = undefined;
				};
			},
			createClient: (options) =>
				createMonitoringClient({
					...options,
					fetch: async (input) => {
						const url = new URL(String(input));
						calls.push(url);
						return url.pathname.endsWith("snapshot")
							? snapshotReply()
							: eventsReply(url);
					},
				}),
		});
	let collector = make();
	cleanups.push(async () => {
		await collector.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		store,
		repository,
		calls,
		get collector() {
			return collector;
		},
		setSnapshot(fn: typeof snapshotReply) {
			snapshotReply = fn;
		},
		setEvents(fn: typeof eventsReply) {
			eventsReply = fn;
		},
		advance(ms = 60000) {
			clock += ms;
		},
		now: () => clock,
		configure(next: LarmCollectorConfig) {
			config = next;
			changed?.();
		},
		async reopen() {
			await collector.close();
			collector = make();
		},
	};
}
