import type { Database } from "bun:sqlite";
import { hash, type Capabilities } from "../../domains/capabilities";
import type { ClaudeCodeService } from "../../domains/claude-code";
import type {
	DevelopmentSupervisionService,
	SupervisedGrant,
	SupervisionHost,
} from "../../domains/development-supervision";
import type { DialogueService } from "../../domains/dialogue";
import type { InferencePort } from "../../domains/inference";
import type { MarkdownService } from "../../domains/markdown";
import type { ToolchainExecutionPort } from "../../domains/tool-runtime";
import type { WebNoteService } from "../../domains/web-note";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Knowledge } from "../knowledge/service";
import { createSupervisionDesigns } from "./supervision-design";
import { supervisionDesignInference } from "./supervision-design-inference";
import {
	supervisionBuildContext,
	supervisionResearchNote,
} from "./supervision-research";
import { supervisionWorkspace } from "./supervision-workspace";
import type { GoalWorkspaceRegistry } from "../agency/goal-workspaces";

export function configureDevelopmentSupervision(input: {
	supervisor: DevelopmentSupervisionService;
	store: SqliteStore;
	inference: InferencePort;
	execution: ToolchainExecutionPort;
	capabilities: Capabilities;
	note: WebNoteService;
	claude: ClaudeCodeService;
	markdown: MarkdownService;
	dialogue: Pick<
		DialogueService,
		"notifyInTransaction" | "revokeExecutionNoticeInTransaction"
	>;
	context: Pick<
		Parameters<typeof supervisionBuildContext>[0],
		"memory" | "goals" | "world"
	>;
	knowledge: Pick<
		Knowledge,
		"selectForSupervision" | "supervisionSkillCurrentInTransaction"
	>;
	/** The same registered checkout used by inspect.source and the Claude runner. */
	checkout: string;
	goal?: NonNullable<SupervisionHost["goal"]>;
	goalWorkspaces?: GoalWorkspaceRegistry;
}) {
	const {
		supervisor,
		store,
		inference,
		execution,
		capabilities,
		note,
		claude,
		markdown,
		dialogue,
		knowledge,
	} = input;
	const context = supervisionBuildContext({
		...input.context,
		validSourceInTransaction: execution.validSourceInTransaction,
		validReferenceInTransaction: execution.validReferenceInTransaction,
		skillCurrentInTransaction: knowledge.supervisionSkillCurrentInTransaction,
	});
	function target(db: Database, id: string, adapter: string) {
		const chain = capabilities
			.toolchainsInTransaction(db)
			.find((entry) => entry.id === id);
		if (!chain) return null;
		const bound = capabilities.toolchainBindingInTransaction(
			db,
			chain.revisionId,
		)?.binding;
		return bound?.document.execution === "task" &&
			bound.document.adapterRef === adapter
			? {
					toolchainRevisionId: chain.revisionId,
					bindingRevisionId: bound.revisionId,
				}
			: null;
	}
	const viewResearch = (db: Database, grant: SupervisedGrant) =>
		grant.workId && grant.source.conversationId !== null
			? note.supervised.viewInTransaction(db, grant.source, grant.workId)
			: null;
	const workspace = supervisionForOwners(input);
	const host: SupervisionHost = {
		...(input.goal ? { goal: input.goal } : {}),
		validSourceInTransaction: execution.validSourceInTransaction,
		controlSourceInTransaction: execution.controlSourceInTransaction,
		validReferenceInTransaction: execution.validReferenceInTransaction,
		readReferenceInTransaction: execution.readReferenceInTransaction,
		revokeInTransaction: dialogue.revokeExecutionNoticeInTransaction,
		deliverInTransaction(db, view, eventId) {
			if (!supervisor.task.viewInTransaction(db, view.id)) return false;
			dialogue.notifyInTransaction(db, {
				requestId: eventId,
				conversationId: view.conversationId,
				text: JSON.stringify({
					kind: "supervised_update",
					workRef: view.id,
					revision: view.revision,
					questionId: view.question?.id,
				}),
			});
			return true;
		},
		workspace,
		research: {
			contextInTransaction: context.contextInTransaction,
			validEvidenceInTransaction(db, source, evidence) {
				if (evidence.kind !== "web" && evidence.kind !== "source")
					return context.validEvidenceInTransaction(db, source, evidence);
				const grant = supervisor.researchGrantInTransaction(
					db,
					source,
					evidence.id,
				);
				const view = grant && viewResearch(db, grant);
				if (!grant || !view || grant.kind === "claude") return false;
				const observed = supervisionResearchNote(grant.kind, view, Date.now());
				return !!observed && hash(observed.evidence) === hash(evidence);
			},
			targetInTransaction(db, kind) {
				const ready =
					kind === "web.note"
						? note.availableInTransaction()
						: note.inspectionAvailableInTransaction();
				return ready
					? target(
							db,
							kind,
							kind === "web.note"
								? "adapter:web-note@1"
								: "adapter:inspect-source@1",
						)
					: null;
			},
			startInTransaction(db, _kind, start) {
				if (start.source.conversationId === null)
					throw new Error("supervision_owner_mismatch");
				return note.supervised.startInTransaction(db, {
					...start,
					source: start.source,
				});
			},
			viewInTransaction: viewResearch,
			noteInTransaction: (_db, grant, view) =>
				grant.kind === "claude" || view.conversationId === null
					? null
					: supervisionResearchNote(grant.kind, view, Date.now()),
			cancelInTransaction(db, grant, id) {
				if (grant.workId && grant.source.conversationId !== null)
					note.supervised.cancelInTransaction(
						db,
						grant.source,
						grant.workId,
						id,
					);
			},
			skillSmith: (query, source, signal) =>
				knowledge.selectForSupervision(query, source, signal, (db) => {
					if (!execution.validSourceInTransaction(db, source))
						throw new Error("supervision_source_stale");
				}),
		},
		child: {
			...claude.supervised,
			targetInTransaction: (db, forGoal, workspaceRef) =>
				claude.supervisedAvailableInTransaction(forGoal, workspaceRef)
					? (target(
							db,
							"claude-code.supervised",
							"adapter:claude-code-task@1",
						) ??
						target(db, "claude-code.request", "adapter:claude-code-task@1"))
					: null,
		},
		design: createSupervisionDesigns({
			markdown,
			infer: supervisionDesignInference(store, inference),
			bindingInTransaction: supervisor.designBindingInTransaction,
		}),
	};
	supervisor.configure(host);
}

function supervisionForOwners(input: {
	checkout: string;
	goal?: NonNullable<SupervisionHost["goal"]>;
	goalWorkspaces?: GoalWorkspaceRegistry;
}): SupervisionHost["workspace"] {
	const normal = supervisionWorkspace(input.checkout);
	const background = new Map(
		input.goalWorkspaces
			?.runnerWorkspaces()
			.map((item) => [
				item.ref,
				supervisionWorkspace(item.root, item.ref, [
					...new Set(item.checks.map(({ command }) => command)),
				]),
			]),
	);
	const scoped = (
		scope: Parameters<
			NonNullable<SupervisionHost["workspace"]["resolveScope"]>
		>[0],
	) => {
		const goal = background.get(scope.workspaceRef);
		return goal?.resolveScope?.(scope) ? goal : normal;
	};
	return {
		inTransaction(db, source) {
			return source.origin === "goal"
				? (input.goal?.authorityInTransaction(db, source)?.workspace ?? null)
				: normal.inTransaction(db, source);
		},
		resolveScope: (scope) => scoped(scope).resolveScope!(scope),
		authorizeInTransaction(db, request) {
			if (request.source.origin !== "goal")
				return normal.authorizeInTransaction(db, request);
			const saved = input.goal?.authorityInTransaction(db, request.source);
			const scope =
				saved &&
				background.get(request.scope.workspaceRef)?.resolveScope!(
					request.scope,
				);
			if (
				!saved ||
				!scope ||
				scope.workspaceRef !== saved.scope.workspaceRef ||
				scope.targetRevision !== saved.scope.targetRevision ||
				scope.mode !== saved.scope.mode ||
				scope.deadline > saved.scope.deadline ||
				scope.mode !== request.ceiling ||
				(scope.mode === "edit" &&
					request.design?.digest !== saved.design?.digest)
			)
				return false;
			return (
				scope.readablePaths.every((path) =>
					saved.scope.readablePaths.includes(path),
				) &&
				scope.writablePaths.every((path) =>
					saved.scope.writablePaths.includes(path),
				) &&
				scope.checks.every((check) =>
					saved.scope.checks.some((allowed) => hash(allowed) === hash(check)),
				)
			);
		},
		inspectInTransaction: (db, scope, workId, inherited) =>
			scoped(scope).inspectInTransaction(db, scope, workId, inherited),
		capture: (scope, signal, baseline, inherited) =>
			scoped(scope).capture(scope, signal, baseline, inherited),
	};
}
