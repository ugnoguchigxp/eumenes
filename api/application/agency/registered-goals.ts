import type { Database } from "bun:sqlite";
import type { GoalStore } from "eumenes-agency/agenda/runtime";
import type { Capabilities } from "../../domains/capabilities";
import type { ConversationService } from "../../domains/conversation";
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
import { createGoalSupervision } from "../work/goal-supervision";
import { captureGoalSources } from "./goal-input-sources";
import { createGoalDesignDocuments } from "./goal-design-documents";
import { createGoalReplyWork } from "./goal-permission";
import { createGoalReportDelivery } from "./goal-report-delivery";
import { goalQuestionMessageId } from "./goal-question-delivery";
import { createGoalPolicyConfiguration } from "./goal-policy-configuration";
import { composeGoalVerifiers } from "./goal-verifiers";
import { createGoalSemanticVerification } from "./goal-semantic-verification";
import { createGoalVerification } from "./goal-verification";
import { goalDigest } from "./goal-progress-context";
import { createGoalProgress, type GoalProgressPorts } from "./goal-progress";
import { createGoalWebNote } from "./goal-web-note";
import type { GoalWorkspaceRegistry } from "./goal-workspaces";
import { recordPrefix, type AgencyRecordInputDeps } from "./input";
import { createGoalNoteAdopter } from "./goal-note-adoption";
import { createAgencyLlmPort } from "./llm-port";

type Inference = Parameters<typeof createAgencyLlmPort>[0]["inference"];
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
	webNote?: WebNoteService;
	onWorkerAvailabilityChange?(listener: () => void): () => void;
	markdown: MarkdownService;
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
			next: () => {
				const resourceId = settings.get().agency.thinkResourceId;
				return {
					decisionId: crypto.randomUUID(),
					independent: true,
					generation,
					...(resourceId ? { resourceId } : {}),
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
	const machine = createGoalVerification({ goals, workspaces, sourcesCurrent });
	const semantic = createGoalSemanticVerification({
		llm,
		sourcesCurrent,
		read(db, row, id) {
			const researchNote = research?.readInTransaction(db, id);
			if (researchNote) return researchNote;
			const evidence = row.state.evidence.find((item) => item.ref === id);
			const original =
				evidence && ports.markdown.generated.originalInTransaction(db, id);
			return original &&
				evidence &&
				goalDigest([
					id,
					original.title,
					original.markdown,
					evidence.sources,
				]) === evidence.digest
				? { ...original, id, sources: evidence.sources ?? [] }
				: null;
		},
	});
	const verifier = composeGoalVerifiers(machine, semantic);
	const reconcileConfiguration = createGoalPolicyConfiguration({
		goals,
		workspaces,
		binding,
		available: (db, ref) =>
			ports.supervision?.goalWorkerAvailableInTransaction(db, ref) ?? false,
		inferenceConfiguration(db) {
			const configured = settings.inTransaction(db);
			const route = configured.routes.llm;
			const resources = [
				configured.agency.thinkResourceId,
				route.fallbackId,
			].flatMap((id) => configured.resources.filter((item) => item.id === id));
			return [
				route,
				configured.general.reasoningEffort,
				resources,
				configured.connections.filter((connection) =>
					resources.some((resource) => resource.connectionId === connection.id),
				),
			];
		},
		webPolicy: research?.readPolicy,
	});
	progress = createGoalProgress({
		store,
		goals,
		queue,
		enabled,
		sourcesCurrent,
		llm,
		legacyAccess: access,
		onConfigurationChange(listener) {
			const stopSettings = settings.onChange(listener);
			const stopWorkers = ports.onWorkerAvailabilityChange?.(listener);
			const fingerprint = (db: Database) =>
				goalDigest([binding(db), research?.readPolicy(db)]);
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
		owners: { ...execution?.owners, ...research?.owners },
		surface(db, row, permit) {
			const local = execution?.surface(db, row, permit);
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
	const reports = createGoalReportDelivery({ ...ports, enabled });
	function quiet({
		speechUntil,
		allUntil,
	}: {
		speechUntil: number | null;
		allUntil: number | null;
	}) {
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
			progress.submitInTransaction(db, row);
		}
	}

	const adoptNote = createGoalNoteAdopter(goals, progress, sourcesCurrent);

	return {
		progress,
		reply,
		list: reply.list,
		reports,
		quiet,
		readDesign: (db: Database, id: string) =>
			designs.readInTransaction(db, id) ??
			research?.readInTransaction(db, id) ??
			null,
		forgetInTransaction,
		adoptNote,
		authority: execution?.authority,
	};
}
