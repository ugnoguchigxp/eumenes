import type { Database } from "bun:sqlite";
import type { QueueService } from "../../queue";
import type { SchedulerService } from "../../scheduler";
import type { LogFields } from "../../../infrastructure/logger";

export type TimerLog = {
	debug(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields, error?: unknown): void;
};

export type TimerDeps = {
	now: () => number;
	id: () => string;
	scheduler: SchedulerService;
	queue: QueueService;
	publish?: () => void;
	protectedIds?: (tx: Database) => readonly string[];
	log: TimerLog;
};
