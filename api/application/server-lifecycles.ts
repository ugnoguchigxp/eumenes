import { getLogger } from "../infrastructure/logger";
import { intervalLifecycle, type Lifecycle } from "./lifecycle";
import { recoverSteward } from "./world/steward-assembly";
import type { Services } from "./server-services";
import { createSpecialistSessionsLifecycle } from "./toolchain/specialist-sessions";

const log = getLogger("server");

/** The interval workers of the process; `createLifecycles` starts, stops and drains them in its own order. */
function createIntervalWorkers(s: Services) {
	// Rebuild the toolchain and turn indexes in the provider's current space.
	const googleMaintenance = intervalLifecycle("google_accounts", 60_000, () =>
		s.googleAccounts.maintain(),
	);
	const refreshVectors = async () => {
		const space = await s.toolchain.refreshVectors();
		const memory = s.memory.status();
		if (!space || !memory.enabled || !memory.healthy) return;
		const signal = AbortSignal.timeout(30_000);
		try {
			while (
				!signal.aborted &&
				(await s.memory.vectors.refreshTurns(space, signal))
			) {}
		} catch {
			log.warn("memory.turn_vectors_refresh_failed", {
				reason: "embedding_failed",
			});
		}
	};
	const vectorRefresh = intervalLifecycle(
		"toolchain_vectors",
		600_000,
		refreshVectors,
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
			s.delegated.tasks
				.maintenance()
				.catch((error) =>
					log.warn(
						"tasks.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
			s.toolchain.actionRequests
				.maintenance()
				.catch((error) =>
					log.warn(
						"toolchain_actions.maintenance_failed",
						{ reason: "maintenance_failed" },
						error,
					),
				),
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
	const drawingMaintenance = intervalLifecycle("excalidraw_idle", 1000, () =>
		s.excalidraw.tick(),
	);
	// Tasks and captures past their deadline end, and temp files no capture owns are removed.
	const browserSweep = intervalLifecycle("browser_sweep", 30_000, () =>
		s.browser.service.sweep(),
	);
	return {
		googleMaintenance,
		vectorRefresh,
		refreshVectors,
		reportDelivery,
		taskMaintenance,
		storeRetention,
		kanbanMaintenance,
		timerMaintenance,
		drawingMaintenance,
		browserSweep,
	};
}

/**
 * Process lifecycle of the services. The three groups are separate because the
 * three orders differ: recovery order (a journal before the world that reads
 * it, queue before the tasks it carries), start order (runners after every
 * recovery), and bring-up order for resources, which `closeAll` walks in
 * reverse so the shutdown order is exactly: commit/status subscriptions,
 * change stream, HTTP, timers, in-flight maintenance (tasks, store retention,
 * timers), world,
 * scheduler, service tests, voice, excalidraw, Claude Code sessions,
 * agents, the browser (its MCP child), queue,
 * web research, dialogue, inference, shared files, datasets, store.
 */
export function createLifecycles(s: Services, http: Lifecycle): Lifecycle[] {
	const {
		googleMaintenance,
		vectorRefresh,
		refreshVectors,
		reportDelivery,
		taskMaintenance,
		storeRetention,
		kanbanMaintenance,
		timerMaintenance,
		drawingMaintenance,
		browserSweep,
	} = createIntervalWorkers(s);
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
		{ name: "memory_host_recovery", recover: () => s.memoryHost.recover() },
		{
			name: "agency_recovery",
			recover: () => s.agency.recover(),
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
		{ name: "live_voice_recovery", recover: () => s.liveVoice.live.recover() },
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
		{ name: "queue_recovery", recover: () => s.queue.recover() },
		{ name: "workflow_recovery", recover: () => s.workflow.recover() },
		{
			name: "development_supervision_recovery",
			recover: () => s.toolchain.developmentSupervision?.recover(),
		},
		{ name: "web_note_recovery", recover: () => s.toolchain.webNote.recover() },
		{
			name: "claude_code_recovery",
			recover: async () => {
				await s.toolchain.claudeCode?.recover();
				s.toolchain.claudeCode?.start();
			},
		},
		{
			name: "registered_goals_recovery",
			recover: async () => {
				await s.registeredGoals.recoverWorkspaceChecks();
				await s.registeredGoals.thoughts.recover();
				await s.registeredGoals.progress.recover();
				await s.registeredGoals.work.recover();
			},
		},
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
				await s.browser.interact?.recover();
			},
		},
		{ name: "delegated_recovery", recover: () => s.delegated.tasks.recover() },
		{ name: "dots_recovery", recover: () => s.dots.recover() },
		{
			name: "task_report_recovery",
			recover: () => s.store.write(s.deliverTaskReports),
		},
		{ name: "timers_recovery", recover: () => s.timers.recover() },
		{ name: "scheduler_recovery", recover: () => s.scheduler.recover() },
		// Start order. Change-feed/forget consumers: commit notification plus a modest poll; they never create inference jobs.
		{
			name: "toolchain_vectors_start",
			start: () => {
				vectorRefresh.start?.();
				void refreshVectors();
			},
		},
		// This boot's shared files start empty; the last boot's are removed in the background.
		{ name: "scratch_start", start: () => s.scratch.start() },
		{ name: "agents_start", start: () => s.toolchain.agents.start() },
		{
			name: "registered_goals_start",
			start: () => {
				s.registeredGoals.progress.listen();
			},
		},
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
		{
			name: "timer_maintenance_start",
			start: () => timerMaintenance.start?.(),
		},
		{ name: "browser_sweep_start", start: () => browserSweep.start?.() },
		{
			name: "kanban_maintenance_start",
			start: () => kanbanMaintenance.start?.(),
		},
		{ name: "memory_host_start", start: () => s.memoryHost.start() },
		// Bring-up order of the resources; closed in reverse.
		{ name: "store", close: () => s.store.close() },
		{ name: "dataset_store", close: () => s.datasetStore.close() },
		{ name: "attitude_dataset", close: () => s.attitudeDataset.close() },
		// After the queue whose jobs read the files (reverse order: closed later).
		{ name: "scratch", close: () => s.scratch.close() },
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
		{ name: "compute", close: () => s.compute.close() },
		{ name: "queue", close: () => s.queue.close(10_000) },
		{
			name: "canvas",
			close: () => s.canvas?.runtime.close(),
		},
		// The MCP child stops before the queue that drives it (reverse order: closed first).
		{ name: "browser_sweep", close: () => browserSweep.idle() },
		{ name: "browser", close: () => s.browser.close() },
		{ name: "capabilities", close: () => s.toolchain.capabilities.close() },
		{ name: "agents", close: () => s.toolchain.agents.close() },
		{
			name: "development_supervision",
			close: () => s.toolchain.developmentSupervision?.close(),
		},
		{ name: "web_note", close: () => s.toolchain.webNote.close() },
		{
			name: "claude_code_task",
			close: async () => {
				await s.toolchain.claudeCode?.close();
			},
		},
		{
			// Stop goal subscriptions before their owners and the queue are closed.
			name: "registered_goals",
			close: async () => {
				s.registeredGoals.progress.close();
			},
		},
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
		{ name: "live_voice", close: () => s.liveVoice.live.close() },
		{ name: "service_tests", close: () => s.serviceTests.close() },
		{ name: "scheduler", close: () => s.scheduler.close() },
		{ name: "delegated", close: () => s.delegated.close() },
		// World consumers stop before anything closes the store.
		{ name: "world", close: () => s.world?.close() },
		{ name: "task_maintenance", close: () => taskMaintenance.idle() },
		{ name: "task_report_delivery", close: () => reportDelivery.idle() },
		{ name: "store_retention", close: () => storeRetention.idle() },
		googleMaintenance,
		{ name: "timer_maintenance", close: () => timerMaintenance.idle() },
		{ name: "kanban_maintenance", close: () => kanbanMaintenance.idle() },
		{
			name: "timers",
			close: () => {
				reportDelivery.stop();
				taskMaintenance.stop();
				storeRetention.stop();
				timerMaintenance.stop();
				kanbanMaintenance.stop();
				browserSweep.stop();
				vectorRefresh.stop();
			},
		},
		{ name: "memory_host", close: () => s.memoryHost.close() },
		http,
		{ name: "changes", close: () => s.changes.close() },
		{ name: "status", close: () => s.unsubscribeStatus() },
		{ name: "commits", close: () => s.unsubscribeCommits() },
		{ name: "memory_host_listener", recover: () => s.memoryHost.listen() },
	];
}
