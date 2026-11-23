import type { Database } from "bun:sqlite";
import { asData } from "eumenes-agency/agenda";
import {
	createRegisteredGoalDesignGenerator,
	validateRegisteredGoalDesign,
	type GoalProgress,
	type GoalStore,
	type RegisteredGoalDesignInput,
} from "eumenes-agency/agenda/runtime";
import type { MarkdownService } from "../../domains/markdown";
import { sha256Hex } from "../../infrastructure/digest";
import {
	currentGoalPermits,
	goalAccess,
	goalDigest,
} from "./goal-progress-context";
import type { GoalProgressPorts } from "./goal-progress";

const owner = "registered-goal-design";
export const invalidGoalCriterionQuote = "goal_criterion_source_invalid";
export const goalDesignObservation = "goal-design-observation";
const quoteCorrection =
	"validationFailure には直前の案と引用検査の結果が入ります。指定された箇所の sourceQuote を sourceText に実在する連続した文字列から選び直してください。目的の言い換えや資料本文を引用元に使いません。元の目標と達成条件を保ち、検証済みの引用を維持した完全な設計結果を返してください。";
const refFor = (row: GoalProgress) =>
	`${owner}:${row.goalId}:${row.goalRevision}`;
export function createGoalDesignDocuments(ports: {
	goals: GoalStore;
	generated: Pick<
		MarkdownService["generated"],
		"configureOwner" | "startInTransaction" | "originalInTransaction"
	>;
	llm: GoalProgressPorts["llm"];
	sourceText(db: Database, id: string): string | null;
	sourcesCurrent?: GoalProgressPorts["sourcesCurrent"];
}) {
	const { goals, generated } = ports;
	const rowFor = (db: Database, id: string, ref: string) =>
		goals.progressRowsInTransaction(db).find(
			(row) =>
				row.state.design?.id === id &&
				refFor(row) === ref &&
				(row.phase === "completed" ||
					goals.activeProgressInTransaction(db, goalAccess(row), row)) &&
				(!row.state.sourceRef ||
					ports.sourceText(db, row.state.sourceRef) !== null) &&
				(ports.sourcesCurrent?.(
					db,
					row,
					row.state.evidence.flatMap((item) => item.sources ?? []),
				) ??
					true),
		);
	generated.configureOwner(owner, {
		validInTransaction: (db, id, ref) => !!rowFor(db, id, ref),
		storedPreviewInTransaction(db, value) {
			const row = rowFor(db, value.id, value.ownerRef);
			return (
				!!row &&
				"goal" in value &&
				value.goal.principal === row.principal &&
				value.goal.goalId === row.goalId &&
				value.goal.goalRevision === row.goalRevision &&
				value.goal.scopeKey === row.ledgerScope &&
				value.goal.parentWorkId === null &&
				sha256Hex(value.markdown) === row.state.design?.digest
			);
		},
	});
	const prepareDesign: NonNullable<GoalProgressPorts["prepareDesign"]> = (
		db,
		row,
	) => {
		const access = goalAccess(row);
		const goal = goals.currentGoalInTransaction(db, access, row.goalId);
		const permits = currentGoalPermits(
			db,
			{
				goals,
				nowMs: Date.now(),
				sourcesCurrent: ports.sourcesCurrent ?? (() => true),
			},
			row,
		);
		if (
			!goal ||
			!permits.some(
				({ scope }) =>
					scope.basis.kind === "message" && scope.writablePaths.length > 0,
			)
		)
			return null;
		const source = row.state.sourceRef
			? ports.sourceText(db, row.state.sourceRef)
			: goal.desiredState;
		if (source === null) return null;
		const evidence = row.state.evidence.filter(
			({ ref, sources }) =>
				ref !== goalDesignObservation &&
				(!sources || (ports.sourcesCurrent?.(db, row, sources) ?? true)),
		);
		const notes = evidence.map(({ ref, summary }) => ({
			id: ref,
			title: "作業の観測",
			summary,
			markdown: summary,
			at: row.state.startedAt,
			refs: [],
		}));
		const inputVersion = goalDigest([
			source,
			permits.map(({ id, revision }) => [id, revision]),
			[...new Set(evidence.map(({ summary }) => summary))].sort(),
		]);
		if (
			row.state.evidence.some(
				({ ref, version }) =>
					ref === goalDesignObservation && version === inputVersion,
			) ||
			(row.state.problem?.startsWith("goal_design_blocked:") &&
				row.state.problem.startsWith(
					"goal_design_blocked:" +
						goalDigest([
							source,
							permits.map(({ id, revision }) => [id, revision]),
							row.state.evidence,
						]),
				))
		)
			return null;
		const sources = row.state.sourceRef ? [row.state.sourceRef] : [];
		const designInput: RegisteredGoalDesignInput = {
			sourceText: source,
			purpose: goal.desiredState,
			workspace: [...new Set(permits.map(({ scope }) => scope.workspaceRef))]
				.sort()
				.join(", "),
			analysis:
				"既知の条件から一手ずつ進め、作業結果を目標の達成条件と照合する。",
			brief: { task: goal.desiredState.slice(0, 80), prompt: source },
			memory: [],
			notes,
		};
		const run = async (signal: AbortSignal) => {
			const generate = createRegisteredGoalDesignGenerator(async (request) => {
				const llm = ports.llm(row.progressVersion);
				const completion = {
					purpose: "think" as const,
					prompt: request.data,
					schema: request.schema,
					system: request.instructions,
					input: {
						complete: row.state.sourceRef !== null,
						sources,
					},
					maxOutputTokens: 2400,
				};
				const { value } = await llm.complete(completion, request.signal);
				request.signal.throwIfAborted();
				try {
					return validateRegisteredGoalDesign(designInput, value);
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== invalidGoalCriterionQuote
					)
						throw error;
					const { criteria } = request.schema.parse(value);
					const fields = criteria.flatMap(({ sourceQuote }, index) =>
						source.includes(sourceQuote)
							? []
							: [`criteria[${index}].sourceQuote`],
					);
					const prompt = asData({
						...designInput,
						validationFailure: {
							code: error.message,
							fields,
							previousCriteria: criteria,
						},
					});
					if (Buffer.byteLength(prompt) > 128 * 1024) throw error;
					const corrected = await llm.complete(
						{
							...completion,
							prompt,
							system: `${request.instructions}\n${quoteCorrection}`,
						},
						request.signal,
					);
					return corrected.value;
				}
			});
			const document = await generate(designInput, signal);
			return document.markdown
				? {
						source,
						criteria: document.criteria,
						design: {
							id: crypto.randomUUID(),
							digest: sha256Hex(document.markdown),
						},
						document: { title: document.title, markdown: document.markdown },
					}
				: { blocked: "goal_design_blocked:" + document.missing };
		};
		return { inputVersion, sources, run };
	};
	const saveDesign: NonNullable<GoalProgressPorts["saveDesign"]> = (
		db,
		row,
		designed,
	) => {
		if (!designed.document) throw new Error("goal_design_document_missing");
		generated.startInTransaction(db, {
			id: designed.design.id,
			ownerRef: refFor(row),
			sourceRunId: row.goalId,
			goal: {
				principal: row.principal,
				goalId: row.goalId,
				goalRevision: row.goalRevision,
				scopeKey: row.ledgerScope,
				parentWorkId: null,
			},
			...designed.document,
			namespace: "eumenes",
			path: `designs/${designed.design.id}.md`,
			retention: "local",
		});
	};
	return {
		prepareDesign,
		saveDesign,
		readInTransaction(db: Database, id: string) {
			const row = goals
				.progressRowsInTransaction(db)
				.find(
					(item) =>
						item.state.design?.id === id && rowFor(db, id, refFor(item)),
				);
			const document = row && generated.originalInTransaction(db, id);
			return row && document
				? {
						...document,
						id,
						summary: document.title,
						at: row.state.startedAt,
						refs: row.state.sourceRef ? [row.state.sourceRef] : [],
					}
				: null;
		},
	};
}
