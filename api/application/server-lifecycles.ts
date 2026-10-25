import { getLogger } from "../infrastructure/logger";
import { intervalLifecycle, type Lifecycle } from "./lifecycle";
import { recoverSteward } from "./world/steward-assembly";
import type { Services } from "./server-services";
import { createSpecialistSessionsLifecycle } from "./toolchain/specialist-sessions";
import { toolchainMaintenance } from "./toolchain/toolchain-adapters";

const log = getLogger("server");

/**
 * Process lifecycle of the services. The three groups are separate because the
 * three orders differ: recovery order (a journal before the world that reads
 * it, queue before the tasks it carries), start order (runners after every
 * recovery), and bring-up order for resources, which `closeAll` walks in
 * reverse so the shutdown order is exactly: commit/status subscriptions,
 * change stream, HTTP, timers, coding, in-flight maintenance (tasks, store retention,
 * timers), world,
 * supervision, delegated, scheduler, service tests, voice, excalidraw, Claude Code sessions,
 * agents, the browser (its MCP child), queue,
 * web research, dialogue, inference, datasets, store.
 */
export function createLifecycles(s: Services, http: Lifecycle): Lifecycle[] {
	// Toolchain and procedure passages are embedded in the background; retrieval falls back
	// to full-text search while a vector is missing.
	const googleMaintenance = intervalLifecycle(
		"google_accounts",
		60_000,
		() => s.googleAccounts.maintain(),
		{ exclusive: true },
	);
	const vectorRefresh = intervalLifecycle(
		"toolchain_vectors",
		600_000,
		() => s.toolchain.refreshVectors(),
		{ exclusive: true },
	);
	const reportDelivery = intervalLifecycle("task_report_delivery", 1000, () =>
		s.store.write(s.deliverTaskReports),
	);
	const taskMaintenance = intervalLifecycle("task_maintenance", 60_000, () =>
		Promise.allSettled([
			s.dotsMessages
				.maintenance()
				.catch((error) =>
					log.warn(
						"dots.messages_maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.dots
				.maintenance()
				.catch((error) =>
					log.warn(
						"dots.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.dotsEvents
				.maintenance()
				.catch((error) =>
					log.warn(
						"dots.events_maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.supervision
				?.maintenance()
				.catch((error) =>
					log.warn(
						"coding_supervision.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.delegated.tasks
				.maintenance()
				.catch((error) =>
					log.warn(
						"tasks.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.compute.refresh(),
			...toolchainMaintenance(s, log),
		]),
	);
	// Bounded deletes (queue 500, occurrences 500, schedules 100) keep the writer free.
	const storeRetention = intervalLifecycle("store_retention", 3_600_000, () =>
		s.store
			.write((db) => {
				const at = Date.now();
				s.queue.pruneInTransaction(db, at);
				s.scheduler.pruneInTransaction(db, at);
				s.toolchain.terminals.pruneInTransaction(db, new Date(at));
				s.toolchain.shell.pruneInTransaction(db, new Date(at));
			})
			.catch((error) =>
				log.warn(
					"store.retention_failed",
					{ reason: "retention_failed" },
					error,
				),
			),
	);
	const codingHeartbeat = intervalLifecycle(
		"coding_heartbeat",
		15_000,
		() => s.codingExecution?.heartbeat(),
		{ exclusive: false },
	);
	// Settles board runs whose result could not be applied, and prunes old runs (hourly).
	const kanbanMaintenance = intervalLifecycle(
		"kanban_maintenance",
		30_000,
		() => s.toolchain.kanbanRuns.maintain(),
	);
	const timerMaintenance = intervalLifecycle("timer_maintenance", 1000, () =>
		s.timers
			.maintenance()
			.catch((error) =>
				log.warn(
					"timers.maintenance_failed",
					{ reason: "maintenance_failed" },
					error,
				),
			),
	);
	const drawingMaintenance = intervalLifecycle(
		"excalidraw_idle",
		1000,
		() => s.excalidraw.tick(),
		{ exclusive: true },
	);
	// Tasks and captures past their deadline end, and temp files no capture owns are removed.
	const browserSweep = intervalLifecycle(
		"browser_sweep",
		30_000,
		() => s.browser.service.sweep(),
		{ exclusive: true },
	);
	// A screen command nobody received expires on time, so the conversation can say it was not shown.
	const screenExpiry = intervalLifecycle(
		"screen_expiry",
		5000,
		() =>
			s.resources &&
			s.store.write((db) => s.resources!.screen.expireInTransaction(db)),
		{ exclusive: true },
	);
	let feedResyncRequired = false;
	return [
		// Recovery runs to completion before any worker starts; a failure aborts startup.
		{
			// Journal reconciliation precedes any memory read or worker; a broken journal disables memory.
			name: "memory_recovery",
			recover: async () => {
				const recovery = await s.memory.recover();
				if (!recovery.healthy)
					log.warn("memory.unavailable", { reason: recovery.reason });
				feedResyncRequired = recovery.feedResyncRequired === true;
			},
		},
		{
			// World recovery follows Memory's and precedes every queue/worker start. It never aborts startup:
			// a failed recovery leaves World's gate closed (fail closed) and is retried by its poll.
			name: "world_recovery",
			recover: async () => {
				await s.world?.recover({ feedResyncRequired });
			},
		},
		{ name: "excalidraw_recovery", recover: () => s.excalidraw.recover() },
		{ name: "voice_recovery", recover: () => s.voice.recover() },
		{ name: "inference_recovery", recover: () => s.inference.recover() },
		{ name: "service_tests_recovery", recover: () => s.serviceTests.recover() },
		{ name: "agents_recovery", recover: () => s.toolchain.agents.recover() },
		{ name: "dialogue_recovery", recover: () => s.dialogue.recover() },
		{
			name: "shell_recovery",
			recover: () => s.toolchain.shell.recover(),
		},
		{
			name: "terminals_recovery",
			recover: () => s.toolchain.terminals.recover(),
		},
		{
			name: "kanban_recovery",
			recover: () => s.toolchain.kanbanRuns.recover(),
		},
		{
			name: "steward_recovery",
			recover: () => s.store.write((db) => recoverSteward(s.steward, db)),
		},
		{ name: "web_research_recovery", recover: () => s.webResearch.recover() },
		{ name: "compute_discovery", recover: () => s.compute.refresh() },
		{ name: "queue_recovery", recover: () => s.queue.recover() },
		{
			name: "visual_analysis_recovery",
			recover: async () => {
				await s.ocr.analyses?.recover();
				await s.objectRecognition.analyses?.recover();
			},
		},
		{
			// A connection of the previous process ended with it; what it left running is settled here.
			name: "browser_recovery",
			recover: async () => {
				await s.browser.service.ready;
				await s.browser.service.sweep();
			},
		},
		{ name: "delegated_recovery", recover: () => s.delegated.recover() },
		{ name: "dots_recovery", recover: () => s.dots.recover() },
		{
			name: "task_report_recovery",
			recover: () => s.store.write(s.deliverTaskReports),
		},
		{
			name: "coding_recovery",
			recover: async () => {
				await s.codingComposition?.coding.recover();
			},
		},
		{
			name: "supervision_recovery",
			recover: async () => {
				await s.supervision?.recover();
			},
		},
		{ name: "timers_recovery", recover: () => s.timers.recover() },
		{ name: "scheduler_recovery", recover: () => s.scheduler.recover() },
		// Start order. Change-feed/forget consumers: commit notification plus a modest poll; they never create inference jobs.
		{
			name: "toolchain_vectors_start",
			start: () => {
				vectorRefresh.start?.();
				void s.toolchain.refreshVectors();
			},
		},
		{
			// The forecast areas of the weather toolchain; the task maintenance pass reads them again once a day.
			name: "weather_areas_start",
			start: () => {
				void s.toolchain.weather?.maintain();
			},
		},
		{
			// The EDINET list of listed companies of the stock toolchain; the task maintenance pass reads it again once a day.
			name: "stock_codelist_start",
			start: () => {
				void s.toolchain.stock?.maintain();
			},
		},
		{ name: "agents_start", start: () => s.toolchain.agents.start() },
		{ name: "queue_start", start: () => s.queue.start() },
		{
			name: "task_report_delivery_start",
			start: () => reportDelivery.start?.(),
		},
		{ name: "world_start", start: () => s.world?.start() },
		// After every recovery: the feed starts at the end of the outbox, so nothing from the past is read.
		{ name: "agency_start", start: () => s.agency.start() },
		{ name: "prewarm_start", start: () => s.prewarm.start() },
		{ name: "web_research_start", start: () => s.webResearch.start() },
		{ name: "excalidraw_start", start: () => drawingMaintenance.start?.() },
		{ name: "scheduler_start", start: () => s.scheduler.start() },
		{ name: "task_maintenance_start", start: () => taskMaintenance.start?.() },
		{ name: "store_retention_start", start: () => storeRetention.start?.() },
		{ name: "coding_heartbeat_start", start: () => codingHeartbeat.start?.() },
		{
			name: "timer_maintenance_start",
			start: () => timerMaintenance.start?.(),
		},
		{ name: "browser_sweep_start", start: () => browserSweep.start?.() },
		{ name: "screen_expiry_start", start: () => screenExpiry.start?.() },
		{
			name: "kanban_maintenance_start",
			start: () => kanbanMaintenance.start?.(),
		},
		// Bring-up order of the resources; closed in reverse.
		{ name: "store", close: () => s.store.close() },
		{ name: "dataset_store", close: () => s.datasetStore.close() },
		{ name: "attitude_dataset", close: () => s.attitudeDataset.close() },
		{
			name: "inference",
			close: () => Promise.race([s.inference.close(), Bun.sleep(5_000)]),
		},
		{
			// Spontaneous speech stops (its in-flight cycles end) before the dialogue service closes.
			name: "dialogue",
			close: async () => {
				s.prewarm.close();
				await s.agency.close();
				await s.dialogue.close();
			},
		},
		{ name: "monitoring", close: () => s.monitoring.close() },
		createSpecialistSessionsLifecycle(s.dialogue),
		{ name: "web_research", close: () => s.webResearch.close() },
		{ name: "queue", close: () => s.queue.close(10_000) },
		// The MCP child stops before the queue that drives it (reverse order: closed first).
		{ name: "browser_sweep", close: () => browserSweep.idle() },
		{ name: "screen_expiry", close: () => screenExpiry.idle() },
		{ name: "browser", close: () => s.browser.close() },
		{ name: "capabilities", close: () => s.toolchain.capabilities.close() },
		{ name: "agents", close: () => s.toolchain.agents.close() },
		{ name: "kanban", close: () => s.toolchain.kanbanRuns.disconnect() },
		{ name: "shell", close: () => s.toolchain.shell.closeAll() },
		{ name: "terminals", close: () => s.toolchain.terminals.closeAll() },
		{
			name: "excalidraw",
			close: async () => {
				drawingMaintenance.stop();
				await drawingMaintenance.idle();
				await s.excalidraw.close();
			},
		},
		{ name: "voice", close: () => s.voice.close() },
		{ name: "service_tests", close: () => s.serviceTests.close() },
		{ name: "scheduler", close: () => s.scheduler.close() },
		{ name: "delegated", close: () => s.delegated.close() },
		{ name: "supervision", close: () => s.supervision?.close() },
		// World consumers stop before anything closes the store.
		{ name: "world", close: () => s.world?.close() },
		{ name: "task_maintenance", close: () => taskMaintenance.idle() },
		{ name: "task_report_delivery", close: () => reportDelivery.idle() },
		{ name: "store_retention", close: () => storeRetention.idle() },
		googleMaintenance,
		{ name: "timer_maintenance", close: () => timerMaintenance.idle() },
		{ name: "kanban_maintenance", close: () => kanbanMaintenance.idle() },
		// Worker lease also expires independently if shutdown cannot deliver a stop.
		{ name: "coding", close: () => s.codingComposition?.coding.close() },
		{ name: "coding_execution", close: () => s.codingExecution?.shutdown() },
		{
			name: "timers",
			close: () => {
				reportDelivery.stop();
				taskMaintenance.stop();
				storeRetention.stop();
				codingHeartbeat.stop();
				timerMaintenance.stop();
				kanbanMaintenance.stop();
				browserSweep.stop();
				screenExpiry.stop();
				vectorRefresh.stop();
			},
		},
		http,
		{ name: "changes", close: () => s.changes.close() },
		{ name: "status", close: () => s.unsubscribeStatus() },
		{ name: "commits", close: () => s.unsubscribeCommits() },
	];
}
