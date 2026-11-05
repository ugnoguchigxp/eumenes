import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	createBrowserInteract,
	createCaptureFiles,
	createInteractDriver,
	createWebpEncoder,
	type BrowserService,
	type InteractDriver,
} from "../../domains/browser";
import type { ConversationService } from "../../domains/conversation";
import type { QueueService } from "../../domains/queue";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { systemContext } from "../../infrastructure/system-context";
import type { TaskRunnerPorts } from "./browser-task-runner";
import { loadInteractRelease } from "./interact-release";
import { createInteractInference } from "./interact-inference";
import siteCandidates from "../../../vendor/interact/site-candidates.json";

export function buildBrowserInteract(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: TaskRunnerPorts["inference"];
	legacy: BrowserService;
	conversation: ConversationService;
	outputDir: string;
	captureDir: string;
	origin: string;
	createDriver?: (
		runId: string,
		executablePath: string | undefined,
	) => InteractDriver;
}) {
	const release = loadInteractRelease();
	const skill = systemContext("browser.contexts.interact.skill", {});
	if (skill !== release.body)
		throw new Error("interact_skill_generation_stale");
	let collaborationSourceGuard:
		| ((db: import("bun:sqlite").Database, source: unknown) => boolean)
		| undefined;
	const validSource = (db: import("bun:sqlite").Database, raw: unknown) => {
		const source = raw as {
			kind: string;
			execution?: unknown;
			messageId?: string;
			conversationId?: string;
			digest?: string;
			source?: unknown;
		};
		if (source.kind === "collaboration")
			return collaborationSourceGuard?.(db, source.source) ?? false;
		if (source.kind === "execution")
			return !!deps.legacy.taskExecutionSourceInTransaction(db, {
				execution: source.execution,
			});
		if (source.kind !== "message" || !source.messageId) return false;
		const message = deps.conversation.messageInTransaction(
			db,
			source.messageId,
		)?.message;
		return (
			message?.role === "user" &&
			message.conversationId === source.conversationId &&
			createHash("sha256")
				.update(message.text ?? "")
				.digest("hex") === source.digest
		);
	};
	const service = createBrowserInteract({
		store: deps.store,
		queue: deps.queue,
		now: Date.now,
		infer: createInteractInference(deps, skill),
		validSource,
		knowledgeSeed: siteCandidates,
		skill: {
			...release.skill,
			digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`,
		},
		reviewInstructions: systemContext("browser.contexts.interact.review", {}),
		files: createCaptureFiles({ directory: join(deps.captureDir, "interact") }),
		encoder: createWebpEncoder(),
		webOrigins: [deps.origin],
		createDriver: (id) => {
			const path = deps.legacy.setting.get().executablePath || undefined;
			return (
				deps.createDriver?.(id, path) ??
				createInteractDriver({
					executablePath: path,
					outputDir: join(deps.outputDir, "interact", id),
				})
			);
		},
	});
	return {
		...service,
		setCollaborationSourceGuard(
			guard: NonNullable<typeof collaborationSourceGuard>,
		) {
			collaborationSourceGuard = guard;
		},
	};
}
