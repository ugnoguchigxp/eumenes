import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { TasksService } from "../../tasks";
import type { QueueService } from "../../queue";
import type { InferencePort } from "../../inference/contracts";
import type { TaskReports } from "../../task-reports";
import type { ObservationReadPort, WorkflowPort } from "../contracts";
import { createReporting } from "./report";

export const payloadSchema = z.strictObject({ id: z.string().min(1).max(160) });

export type CodingSupervisionInput = {
	store: SqliteStore;
	tasks: () => TasksService;
	queue: QueueService;
	inference: InferencePort;
	reports: TaskReports;
	workflow: WorkflowPort;
	/** Read-only observation source for diagnosis; defaults to workflow.observe. */
	observationReader?: ObservationReadPort;
	/** Whether request_change/answer_question wait for the user. Defaults to on. */
	approveInstructions?: () => boolean;
	now?: () => number;
};

/** Collaborators and mutable state shared by every supervision module. */
export type SupervisionContext = {
	store: SqliteStore;
	tasks: () => TasksService;
	queue: QueueService;
	inference: InferencePort;
	reports: TaskReports;
	workflow: WorkflowPort;
	observationReader?: ObservationReadPort;
	approveInstructions: () => boolean;
	now: () => number;
	/** Jobs and requests cancelled in a transaction; flushed after commit. */
	cancelledJobs: Set<string>;
	cancelledRequests: Set<string>;
	state: { closed: boolean };
	report: ReturnType<typeof createReporting>;
};

export function createContext(
	input: CodingSupervisionInput,
): SupervisionContext {
	const now = input.now ?? Date.now;
	return {
		store: input.store,
		tasks: input.tasks,
		queue: input.queue,
		inference: input.inference,
		reports: input.reports,
		workflow: input.workflow,
		observationReader: input.observationReader,
		approveInstructions: input.approveInstructions ?? (() => true),
		now,
		cancelledJobs: new Set<string>(),
		cancelledRequests: new Set<string>(),
		state: { closed: false },
		report: createReporting({
			reports: input.reports,
			tasks: input.tasks,
			now,
		}),
	};
}
