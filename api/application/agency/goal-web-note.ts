import type { Database } from "bun:sqlite";
import type {
	GoalAttempt,
	GoalObservation,
	GoalPermit,
	GoalPermitScope,
	GoalProgress,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import { hash, type Capabilities } from "../../domains/capabilities";
import type { GoalExecutionSource } from "../../domains/tool-runtime";
import {
	webNoteAdapterRef,
	type GoalWebNoteOwner,
	type GoalWebNoteReceipt,
	type WebNoteService,
} from "../../domains/web-note";
import { goalExecutionSource } from "./goal-execution-source";
import {
	goalAccess,
	goalDigest,
	type GoalCapability,
} from "./goal-progress-context";
import type { GoalOwnerPort, GoalProgressPorts } from "./goal-progress";

const owner = "web-note";
const read = "web-note:research";

function identity(row: GoalProgress, attempt: GoalAttempt) {
	return {
		principal: row.principal,
		scopeKey: row.ledgerScope,
		goalId: row.goalId,
		goalRevision: row.goalRevision,
		attemptId: attempt.id,
		permitId: attempt.permitId,
		permitRevision: attempt.permitRevision,
	};
}

export function createGoalWebNote(ports: {
	goals: GoalStore;
	webNote: WebNoteService;
	capabilities: Capabilities;
	enabled(db: Database): boolean;
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"];
	notify(db: Database, row: GoalProgress, observation: GoalObservation): void;
}) {
	const { goals, webNote, capabilities } = ports;
	function binding(db: Database) {
		if (!webNote.availableInTransaction()) return null;
		for (const item of capabilities.toolchainsInTransaction(db)) {
			if (item.id !== "web.note") continue;
			const bound = capabilities.toolchainBindingInTransaction(
				db,
				item.revisionId,
			)?.binding;
			if (
				bound?.document.execution === "task" &&
				bound.document.adapterRef === webNoteAdapterRef
			)
				return {
					toolchainRevisionId: item.revisionId,
					bindingRevisionId: bound.revisionId,
				};
		}
		return null;
	}
	function readPolicy(db: Database) {
		const target = binding(db);
		if (!target) return null;
		const scope: GoalPermitScope = {
			version: 1,
			basis: { kind: "policy", revision: target.toolchainRevisionId },
			workspaceRef: owner,
			baselineCommit: target.bindingRevisionId,
			readablePaths: [],
			writablePaths: [],
			checks: [],
			expiresAtMs: null,
		};
		return { ...target, scope, workspace: owner, impact: "read" };
	}
	function subject(db: Database, source: GoalExecutionSource) {
		const access = {
			principal: source.principal,
			scopeKeys: [source.scopeKey],
		};
		const row = goals.activeProgressInTransaction(db, access, source);
		const attempt =
			row && goals.goalAttemptInTransaction(db, access, row, source.attemptId);
		const permit =
			row &&
			attempt &&
			goals.goalPermitInTransaction(db, access, row, attempt.permitId);
		const target = binding(db);
		if (
			!row ||
			!attempt ||
			!permit ||
			!target ||
			!ports.enabled(db) ||
			attempt.owner !== owner ||
			(attempt.operationRef ?? attempt.step.capabilityRef) !== read ||
			row.currentWorkId !== attempt.id ||
			permit.scope.workspaceRef !== owner ||
			permit.revoked ||
			permit.revision !== attempt.permitRevision ||
			permit.scope.basis.kind !== "policy" ||
			permit.toolchainRevisionId !== target.toolchainRevisionId ||
			permit.scope.baselineCommit !== target.bindingRevisionId ||
			hash(goalExecutionSource(row, attempt, permit)) !== hash(source) ||
			(goals.goalScopeControlInTransaction(db, access, row.ledgerScope)
				?.allUntilMs ?? 0) > Date.now()
		)
			return null;
		return ports.sourcesCurrent(db, row, sources(row, attempt))
			? { row, attempt }
			: null;
	}
	function sources(row: GoalProgress, attempt: GoalAttempt) {
		return [
			...new Set([
				...(row.state.sourceRef ? [row.state.sourceRef] : []),
				...row.state.evidence
					.filter(({ ref }) => attempt.step.evidenceRefs.includes(ref))
					.flatMap((item) => item.sources ?? []),
			]),
		];
	}
	function observation(
		row: GoalProgress,
		attempt: GoalAttempt,
		receipt: GoalWebNoteReceipt,
	): GoalObservation {
		const { result, ownerWorkId, ownerRevision } = receipt;
		const outcome =
			receipt.status === "completed"
				? "succeeded"
				: receipt.status === "partial"
					? "partial"
					: receipt.status === "cancelled"
						? "cancelled"
						: receipt.status === "failed" || receipt.status === "interrupted"
							? "failed"
							: "running";
		const version = String(ownerRevision);
		return {
			producer: owner,
			ref: attempt.dispatchId,
			version,
			digest: goalDigest(receipt),
			evidence:
				result?.answer && (outcome === "succeeded" || outcome === "partial")
					? [
							{
								ref: ownerWorkId,
								version,
								digest: goalDigest(result),
								summary: result.summary || result.answer.slice(0, 500),
								sources: sources(row, attempt),
							},
						]
					: [],
			attempt: {
				id: attempt.id,
				dispatchId: attempt.dispatchId,
				ownerWorkId,
				ownerRevision,
				outcome,
				observed: result?.summary ?? null,
				resultRef: result ? ownerWorkId : null,
			},
		};
	}
	const host: GoalWebNoteOwner = {
		authorityInTransaction: (db, source) => subject(db, source) !== null,
		observeInTransaction(db, source, receipt) {
			const current = subject(db, source);
			if (current)
				ports.notify(
					db,
					current.row,
					observation(current.row, current.attempt, receipt),
				);
		},
	};
	const worker: GoalOwnerPort = {
		startInTransaction(db, row, attempt, permit) {
			const source = goalExecutionSource(row, attempt, permit);
			if (!subject(db, source))
				return { status: "refused", reason: "goal_web_note_policy_inactive" };
			const receipt = webNote.goal.startInTransaction(db, source);
			return {
				status: "known",
				observation: observation(row, attempt, receipt),
			};
		},
		lookupInTransaction(db, row, attempt) {
			const permit = goals.goalPermitInTransaction(
				db,
				goalAccess(row),
				row,
				attempt.permitId,
			);
			if (!permit) return { status: "unknown" };
			const receipt = webNote.goal.lookupInTransaction(
				db,
				goalExecutionSource(row, attempt, permit),
			);
			return receipt
				? { status: "known", observation: observation(row, attempt, receipt) }
				: { status: "absent" };
		},
		cancelInTransaction: (db, row, attempt) =>
			webNote.goal.cancelInTransaction(
				db,
				identity(row, attempt),
				attempt.dispatchId,
			),
		wake: webNote.flush,
	};
	webNote.configureGoal(host);
	return {
		owners: { [owner]: worker },
		verifyAfter: [read],
		readPolicy,
		capabilities(db: Database, permit: GoalPermit | null): GoalCapability[] {
			const target = binding(db);
			if (
				!target ||
				!permit ||
				permit.scope.workspaceRef !== owner ||
				permit.toolchainRevisionId !== target.toolchainRevisionId ||
				permit.scope.baselineCommit !== target.bindingRevisionId
			)
				return [];
			return [
				{
					ref: read,
					description:
						"既存の Web メモ担当に公開情報の調査と出典付き文書を依頼する。",
					allowedScope:
						"公開 Web の読取。ローカルファイルや外部の書き込みは許可されていない。",
					effect: "read",
					owner,
					bindingRevisionId: target.bindingRevisionId,
				},
			];
		},
		forgetInTransaction(db: Database, row: GoalProgress, attempt: GoalAttempt) {
			return (
				attempt.owner === owner &&
				webNote.goal.cancelInTransaction(
					db,
					identity(row, attempt),
					attempt.dispatchId,
					true,
				)
			);
		},
		readInTransaction(db: Database, id: string) {
			for (const row of goals.progressRowsInTransaction(db)) {
				const evidence = row.state.evidence.find(({ ref }) => ref === id);
				if (
					!evidence ||
					!ports.sourcesCurrent(db, row, evidence.sources ?? []) ||
					(row.phase !== "completed" &&
						!goals.activeProgressInTransaction(db, goalAccess(row), row))
				)
					continue;
				const attempt = goals
					.goalAttemptsInTransaction(db, goalAccess(row), row)
					.find((item) => item.owner === owner && item.ownerWorkId === id);
				if (!attempt) continue;
				const receipt = webNote.goal.lookupByIdentityInTransaction(
					db,
					identity(row, attempt),
					id,
				);
				const result = receipt?.result;
				if (!result?.answer || goalDigest(result) !== evidence.digest) continue;
				return {
					id,
					title: result.title ?? "調査メモ",
					summary: result.summary,
					markdown: result.answer,
					at: row.state.startedAt,
					refs: [...(evidence.sources ?? [])],
					sources: (result.sources ?? []).map(
						({ url, title }) => title + " " + url,
					),
				};
			}
			return null;
		},
	};
}
