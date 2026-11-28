import {
	abandonRunsInTransaction,
	createLedger,
	pruneRunsInTransaction,
	purgeSubjectInTransaction,
} from "eumenes-thought-plan";
import type { Database } from "bun:sqlite";
import type { GoalStore } from "eumenes-agency/agenda/runtime";
import type { Capabilities } from "../../domains/capabilities";
import type { ConversationService } from "../../domains/conversation";
import type { Messages } from "../../domains/inference";
import {
	adapterRef as supervisionAdapter,
	type DevelopmentSupervisionService,
} from "../../domains/development-supervision";
import type { MarkdownService } from "../../domains/markdown";
import type { MemoryService } from "../../domains/memory";
import {
	PRINCIPAL,
	PROFILE_SCOPE,
	type ForgetPurge,
} from "../../domains/memory/contracts";
import type { WebNoteService } from "../../domains/web-note";
import type { SettingsService } from "../../domains/settings";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { ClaudeCodeService } from "../../domains/claude-code";
import { createGoalClaude } from "../work/goal-claude";
import { createGoalSupervision } from "../work/goal-supervision";
import { captureGoalSources } from "./goal-input-sources";
import { createGoalDesignDocuments } from "./goal-design-documents";
import { createGoalReplyWork } from "./goal-permission";
import { createGoalWork } from "./goal-work";
import { goalQuestionMessageId } from "./goal-question-delivery";
import { recoverGoalWorkspaceChecks } from "./goal-workspace-verification";
import { goalSubject } from "./goal-deliberation";
import {
	createGoalPolicyConfiguration,
	goalInferenceConfiguration,
} from "./goal-policy-configuration";
import { registeredGoalVerifier } from "./registered-goal-verification";
import { goalDigest } from "./goal-progress-context";
import { createGoalProgress, type GoalProgressPorts } from "./goal-progress";
import { createGoalWebNote } from "./goal-web-note";
import type { GoalWorkspaceRegistry } from "./goal-workspaces";
import { recordPrefix, type AgencyRecordInputDeps } from "./input";
import { createGoalNoteAdopter } from "./goal-note-adoption";
import { createAgencyLlmPort } from "./llm-port";

type Inference = Parameters<typeof createAgencyLlmPort>[0]["inference"] & {
	usage?(): Array<{
		id: string;
		model: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
	}>;
};
const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };

export function registeredDevelopmentBinding(
	db: Database,
	capabilities: Capabilities,
) {
	for (const chain of capabilities.toolchainsInTransaction(db)) {
		const binding = capabilities.toolchainBindingInTransaction(
			db,
			chain.revisionId,
		)?.binding;
		if (
			binding?.document.execution === "task" &&
			binding.document.adapterRef === supervisionAdapter
		)
			return {
				toolchainRevisionId: chain.revisionId,
				bindingRevisionId: binding.revisionId,
			};
	}
	return null;
}

/** How long a goal's finished turns stay in the thought ledger. */
export const THOUGHT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Thinking waits this long after the last foreground request ended (spec/goal-idle-deliberation-redesign §2.2). */
export const GOAL_IDLE_AFTER_MS = 2 * 60 * 1000;

/**
 * When the host is idle for a goal's thinking: no foreground request runs and the last one ended at least
 * `GOAL_IDLE_AFTER_MS` ago. A process that just started is idle. `until()` is null while idle, otherwise the
 * time idling can begin at the earliest.
 */
export function createIdleWatch(
	activity:
		| {
				foregroundBusy(): boolean;
				onActivity(listener: () => void): () => void;
		  }
		| undefined,
	now: () => number = Date.now,
) {
	let lastForegroundAt = 0;
	let wasBusy = false;
	// Every request starting or ending is reported; only the foreground's own start and end move the clock,
	// so background calls (a goal's own thinking included) never postpone idling.
	activity?.onActivity(() => {
		const busy = activity.foregroundBusy();
		if (busy || wasBusy) lastForegroundAt = now();
		wasBusy = busy;
	});
	return {
		until(): number | null {
			if (!activity) return null;
			const at = now();
			if (activity.foregroundBusy()) return at + GOAL_IDLE_AFTER_MS;
			const from = lastForegroundAt + GOAL_IDLE_AFTER_MS;
			return lastForegroundAt && from > at ? from : null;
		},
	};
}

/** The receipt of a control call carries no token counts: the goal's turns read them from the attempt record. */
function attemptUsage(inference: Inference) {
	const usage = inference.usage;
	return usage
		? {
				attemptUsage: (attemptId: string) => {
					const used = usage().find(({ id }) => id === attemptId);
					return used
						? {
								model: used.model,
								inputTokens: used.inputTokens,
								outputTokens: used.outputTokens,
								cacheReadTokens: null,
							}
						: null;
				},
			}
		: {};
}

export function createRegisteredGoals(ports: {
	store: SqliteStore;
	goals: GoalStore;
	conversation: Pick<
		ConversationService,
		"sourceInTransaction" | "appendInTransaction" | "retractInTransaction"
	>;
	referenceInputs: MemoryService["referenceInputs"];
	records?: AgencyRecordInputDeps;
	settings: Pick<SettingsService, "get" | "inTransaction" | "onChange">;
	inference: Inference;
	queue: GoalProgressPorts["queue"];
	blocked: (db: Database, messageId: string) => boolean;
	capabilities: Capabilities;
	workspaces: GoalWorkspaceRegistry;
	supervision?: DevelopmentSupervisionService;
	claude?: ClaudeCodeService;
	webNote?: WebNoteService;
	onWorkerAvailabilityChange?(listener: () => void): () => void;
	markdown: MarkdownService;
	/** The foreground requests (conversation answers, ASR, TTS): a goal thinks only while none ran lately. */
	activity?: {
		foregroundBusy(): boolean;
		onActivity(listener: () => void): () => void;
	};
}) {
	const { store, goals, conversation, settings, inference, queue, workspaces } =
		ports;
	const binding = (db: Database) =>
		registeredDevelopmentBinding(db, ports.capabilities);
	const enabled = (db: Database) =>
		settings.inTransaction(db).agency.actions?.enabled ?? true;
	const sourceText = (db: Database, id: string) => {
		const source = conversation.sourceInTransaction(db, id);
		return source.state === "available" && !ports.blocked(db, id)
			? source.message.text
			: null;
	};
	const sourcesCurrent: GoalProgressPorts["sourcesCurrent"] = (db, _row, ids) =>
		ids.length === 0 ||
		captureGoalSources(db, ports.referenceInputs, ids, ports.records).complete;
	const llm: GoalProgressPorts["llm"] = (generation) =>
		createAgencyLlmPort({
			store,
			inference,
			...attemptUsage(inference),
			next: (request) => {
				const resourceId = settings.get().agency.thinkResourceId;
				// A goal's thinking comes as one session: its earlier exchanges as messages, under its id.
				const { messages, session } = request as {
					messages?: Messages;
					session?: { id: string };
				};
				return {
					decisionId: crypto.randomUUID(),
					independent: true,
					generation,
					...(resourceId ? { resourceId } : {}),
					...(messages && { messages }),
					...(session && { sessionId: session.id }),
				};
			},
		});
	const designs = createGoalDesignDocuments({
		goals,
		llm,
		sourceText,
		sourcesCurrent,
		generated: ports.markdown.generated,
	});
	let progress: ReturnType<typeof createGoalProgress>;
	const notify: Parameters<typeof createGoalWebNote>[0]["notify"] = (
		db,
		row,
		observation,
	) => {
		progress.notifyWorkInTransaction(db, row, observation);
	};
	const research =
		ports.webNote &&
		createGoalWebNote({
			goals,
			webNote: ports.webNote,
			capabilities: ports.capabilities,
			enabled,
			sourcesCurrent,
			notify,
		});
	const execution =
		ports.supervision &&
		createGoalSupervision({
			goals,
			workspaces,
			supervision: ports.supervision,
			binding,
			enabled,
			sourcesCurrent,
			notify,
		});
	const ordinary =
		ports.claude &&
		createGoalClaude({
			claude: ports.claude,
			goals,
			capabilities: ports.capabilities,
			enabled,
			notify,
			sourceIsUser(db, ref) {
				const source = conversation.sourceInTransaction(db, ref);
				return source.state === "available" && source.message.role === "user";
			},
			sourcesCurrent,
		});
	const ordinaryPermit = (
		db: Database,
		row: Parameters<GoalProgressPorts["surface"]>[1],
	) =>
		goals
			.goalPermitsInTransaction(db, access, row)
			.find((permit) => ordinary?.usesWorkspace(db, row, permit));
	const verifier = registeredGoalVerifier({
		...ports,
		llm,
		sourcesCurrent,
		readResearch: research?.readInTransaction,
		permit: ordinary ? ordinaryPermit : undefined,
	});
	const reconcileConfiguration = createGoalPolicyConfiguration({
		goals,
		workspaces,
		binding,
		available: (db, ref) =>
			ports.supervision?.goalWorkerAvailableInTransaction(db, ref) ?? false,
		inferenceConfiguration: (db) =>
			goalInferenceConfiguration(settings.inTransaction(db)),
		webPolicy: research?.readPolicy,
		ordinary,
	});
	const idle = createIdleWatch(ports.activity);
	progress = createGoalProgress({
		store,
		goals,
		queue,
		enabled,
		sourcesCurrent,
		llm,
		thoughtLedger: createLedger(store),
		idleUntil: idle.until,
		legacyAccess: access,
		onConfigurationChange(listener) {
			const stopSettings = settings.onChange(listener);
			const stopWorkers = ports.onWorkerAvailabilityChange?.(listener);
			const fingerprint = (db: Database) =>
				goalDigest([
					binding(db),
					ordinary?.binding(db),
					research?.readPolicy(db),
				]);
			let current = store.read(fingerprint);
			const stopBindings = store.onCommit(() => {
				const next = store.read(fingerprint);
				if (next === current) return;
				current = next;
				listener();
			});
			return () => {
				stopSettings();
				stopWorkers?.();
				stopBindings();
			};
		},
		reconcileConfiguration,
		deliveryConversationOf(db, id) {
			const source = conversation.sourceInTransaction(db, id);
			return source.state === "available" &&
				source.message.role === "user" &&
				!ports.blocked(db, id)
				? source.message.conversationId
				: null;
		},
		owners: { ...execution?.owners, ...ordinary?.owners, ...research?.owners },
		surface(db, row, permit) {
			const standard = ordinaryPermit(db, row);
			const local =
				standard && ordinary
					? permit?.id === standard.id
						? ordinary.surface(db, row, standard)
						: undefined
					: execution?.surface(db, row, permit);
			return {
				capabilities: [
					...(local?.capabilities ?? []),
					...(research?.capabilities(db, permit) ?? []),
				],
				watches: local?.watches ?? [],
				checks: [],
				verifyAfter: [
					...(local?.verifyAfter ?? []),
					...(research?.verifyAfter ?? []),
				],
			};
		},
		checks: verifier.checks,
		sourceText,
		...designs,
		prepareDesign: (db, row) =>
			ordinaryPermit(db, row) ? null : designs.prepareDesign(db, row),
		verify: verifier.verify,
		verificationCurrent: verifier.verificationCurrent,
		staleVerificationEvidence: verifier.staleVerificationEvidence,
		report: (row) =>
			[
				"登録目標を完了しました。",
				...row.state.criteria.map(({ text }) => `- ${text}`),
			].join("\n"),
	});
	const reply = createGoalReplyWork({
		...ports,
		progress,
		access,
		scopeKey: PROFILE_SCOPE,
		workspaces,
		binding,
		reconcileConfiguration,
	});
	const work = createGoalWork({
		...ports,
		enabled,
		reply: (conversationId) => reply(conversationId),
	});
	function forgetInTransaction(db: Database, purge: ForgetPurge) {
		const messages = new Set(purge.messageIds);
		for (const {
			row,
			documentId,
			attempts,
			questionRefs,
		} of goals.forgetGoalInputsInTransaction(db, access, {
			goalIds: purge.derived.goalIds ?? [],
			sourceCurrent: (id) =>
				!messages.has(id) &&
				((!id.startsWith("memory-input:") &&
					!id.startsWith("memory:") &&
					!id.startsWith(recordPrefix)) ||
					captureGoalSources(db, ports.referenceInputs, [id], ports.records)
						.complete),
		})) {
			for (const ref of questionRefs) {
				const id = goalQuestionMessageId(row, ref);
				if (conversation.sourceInTransaction(db, id).state === "available")
					conversation.retractInTransaction(db, { messageId: id });
			}
			if (documentId)
				ports.markdown.generated.cancelInTransaction(db, documentId, true);
			for (const attempt of attempts) {
				if (
					research?.forgetInTransaction(db, row, attempt) ||
					ordinary?.forgetInTransaction(db, row, attempt) ||
					execution?.forgetInTransaction(db, row, attempt)
				)
					goals.releaseForgottenGoalWorkInTransaction(
						db,
						row,
						attempt.id,
						attempt.dispatchId,
						attempt.permitId,
						attempt.permitRevision,
					);
			}
			// The turns thought about this goal carry its text and material: they go with it.
			purgeSubjectInTransaction(db, goalSubject(row.goalId));
			progress.submitInTransaction(db, row);
		}
	}

	const adoptNote = createGoalNoteAdopter(goals, progress, sourcesCurrent);

	return {
		progress,
		recoverWorkspaceChecks: () => store.write(recoverGoalWorkspaceChecks),
		reply,
		list: reply.list,
		work,
		quiet: (input: Parameters<typeof updateGoalQuiet>[3]) =>
			updateGoalQuiet(store, goals, progress, input),
		readDesign: (db: Database, id: string) =>
			designs.readInTransaction(db, id) ??
			research?.readInTransaction(db, id) ??
			null,
		forgetInTransaction,
		adoptNote,
		authority: execution?.authority,
		thoughts: { recover: () => store.write(recoverThoughts) },
	};
}

/**
 * At start: a turn left running belongs to a process that is gone, and turns finished more than
 * `THOUGHT_RETENTION_MS` ago leave the ledger.
 */
function recoverThoughts(db: Database) {
	const nowMs = Date.now();
	abandonRunsInTransaction(db, { idleSinceMs: nowMs, mode: "library", nowMs });
	pruneRunsInTransaction(db, {
		finishedBeforeMs: nowMs - THOUGHT_RETENTION_MS,
	});
}

function updateGoalQuiet(
	store: SqliteStore,
	goals: GoalStore,
	progress: ReturnType<typeof createGoalProgress>,
	{
		speechUntil,
		allUntil,
	}: {
		speechUntil: number | null;
		allUntil: number | null;
	},
) {
	return store
		.write((db) => {
			let controlChanged = false;
			for (const scope of [PROFILE_SCOPE, `${PROFILE_SCOPE}:agenda-goals`]) {
				const prior = goals.goalScopeControlInTransaction(db, access, scope);
				goals.setGoalScopeControlInTransaction(db, access, scope, {
					speechUntilMs: speechUntil,
					allUntilMs: allUntil,
				});
				if ((prior?.allUntilMs ?? null) !== allUntil) {
					progress.rescheduleScopeInTransaction(db, access, scope);
					controlChanged = true;
				}
			}
			if (controlChanged && allUntil === null)
				progress.configurationChangedInTransaction(db);
		})
		.then(progress.wake);
}
