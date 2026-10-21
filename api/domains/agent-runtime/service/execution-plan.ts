import { z } from "zod";
import type { ParentState } from "../repository/executions";

export const executionPlanInput = z.strictObject({
	goal: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe(
			"originalRequestとrequestUpdatesから、依頼全体の達成条件を対象・条件・個数を落とさずに書く。完了判断の基準になる。",
		),
	items: z
		.array(
			z.strictObject({
				request: z
					.string()
					.trim()
					.min(1)
					.max(2000)
					.describe(
						"個別担当への一回の依頼。元依頼の対象・条件を保つ。結果から決まる値は参照から得ることを記す。",
					),
				check: z
					.string()
					.trim()
					.max(500)
					.describe(
						"この項目の結果で、次へ進む前や報告前に確かめる点。子の結果はhostがresultsへ返すので、確認のための別項目は作らない。不要なら空文字。",
					),
				dependsOn: z
					.array(z.union([z.number().int().min(0), z.string().min(1).max(160)]))
					.max(6)
					.describe(
						"先に終える項目。新しいitems内の0始まりの番号、または実行済み項目のstepRef。依存がなければ空配列。",
					),
			}),
		)
		.max(6)
		.describe(
			"個別担当への依頼の列。一項目は一子呼出し。能力の探索・結果の確認・まとめ・質問は項目にしない。",
		),
	report: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe(
			"全項目の実行後に、子の結果から確認・まとめて利用者へ返す内容。まとめのための子作業は作らない。",
		),
});
/** Executed items are the only prior items a revision can depend on; their results already exist. */
export const executedStepRefs = (state: ParentState) =>
	state.plan?.items
		.filter((item) => !!item.resultRef)
		.map((item) => item.stepRef) ?? [];
export const planReady = (state: ParentState) =>
	!!state.plan && !state.planRequired;
export const planFinished = (state: ParentState) =>
	planReady(state) && state.plan!.items.every((item) => !!item.resultRef);
export const runnablePlanItems = (state: ParentState) =>
	!planReady(state)
		? []
		: state.plan!.items.filter(
				(item) =>
					!item.inputDigest &&
					item.dependsOn.every((ref) =>
						state.plan!.items.some(
							(prior) => prior.stepRef === ref && !!prior.resultRef,
						),
					),
			);
const observations = (state: ParentState) =>
	state.searches + state.notes.length;
export const canPlan = (state: ParentState) =>
	!state.pending &&
	!state.selecting &&
	(!planReady(state) ||
		(!planFinished(state) && observations(state) > state.plan!.observedAt));

/** Only structure and execution facts are checked; the model owns the task meaning. */
export function acceptExecutionPlan(
	state: ParentState,
	requestRevision: number,
	raw: unknown,
) {
	const input = executionPlanInput.parse(raw);
	if (state.pending || planFinished(state))
		throw new Error("execution_plan_closed");
	if (!canPlan(state)) throw new Error("execution_plan_observation_required");
	if (!state.plan && !input.items.length)
		throw new Error("execution_plan_invalid");
	if (input.items.length > state.limits.childCalls - state.children)
		throw new Error("execution_plan_capacity");
	const executed = executedStepRefs(state);
	for (const [index, item] of input.items.entries())
		if (
			item.dependsOn.some((dep) =>
				typeof dep === "number" ? dep >= index : !executed.includes(dep),
			)
		)
			throw new Error("execution_plan_dependency_invalid");
	const ids = input.items.map(() => crypto.randomUUID());
	// The decision was prepared against this state (epoch and ordinal are checked at settle), so the host owns the version.
	state.plan = {
		revision: (state.plan?.revision ?? 0) + 1,
		requestRevision,
		observedAt: observations(state),
		goal: input.goal,
		report: input.report,
		items: [
			...(state.plan?.items.filter((item) => !!item.inputDigest) ?? []),
			...input.items.map((item, index) => ({
				stepRef: `step:${ids[index]}`,
				childId: ids[index]!,
				request: item.request,
				check: item.check,
				dependsOn: item.dependsOn.map((dep) =>
					typeof dep === "number" ? `step:${ids[dep]}` : dep,
				),
			})),
		],
	};
	state.planRequired = false;
}

export function executionPlanProjection(state: ParentState) {
	return {
		revision: state.plan?.revision ?? 0,
		requestRevision: state.plan?.requestRevision,
		required: !planReady(state),
		finished: planFinished(state),
		revisionAllowed: canPlan(state),
		goal: state.plan?.goal,
		report: state.plan?.report,
		items:
			state.plan?.items.map(
				({
					stepRef,
					request,
					check,
					dependsOn,
					inputDigest,
					resultRef,
					resultState,
				}) => ({
					stepRef,
					request,
					check,
					dependsOn,
					state: resultRef ? "executed" : inputDigest ? "running" : "pending",
					resultRef,
					resultState,
				}),
			) ?? [],
	};
}

export function executionPhaseInstruction(state: ParentState) {
	if (!planReady(state))
		return "現在は操作計画の作成段階です。set_planのgoalに依頼全体の達成条件、itemsに個別担当へ実行させる作業、reportに最終報告でまとめる内容を書きます。find_toolchain・read_reference・ask_user・complete_task/report_partialはhostの制御関数なので、これらの呼出しを計画の項目に含めません。子の結果はresultsへ返るので、結果で確かめる点はその項目のcheckに書き、確認やまとめを別の子作業にしません。";
	if (planFinished(state))
		return "現在は結果報告の段階です。全計画項目の実行は終わっています。plan.goalとoriginalRequestの各条件を対応するresultsと照合し、すべて満たした根拠があればcomplete_task、不足があればreport_partialを一つ呼びます。summaryにはplan.reportの内容を結果に基づいて書きます。";
	return "操作計画は採用済みで、現在は未実行項目を実行する段階です。今回実行するstepRefを確認し、用途に合う提示能力を使うかfind_toolchainで探します。作成済みの計画をそのままset_planで返し直しません。未実行項目が既存のresultsの確認やまとめだけなら子を呼ばず、plan.goal全体を満たした根拠があればcomplete_taskで終了します。新しい観測から計画の不足や不要な項目が判明し、revisionAllowedがtrueの場合だけ未実行部分を改訂します。";
}
