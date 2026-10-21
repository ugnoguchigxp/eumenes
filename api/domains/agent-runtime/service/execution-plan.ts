import { z } from "zod";
import type { ParentState } from "../repository/executions";

export const executionPlanInput = z.strictObject({
	expectedPlanRevision: z.number().int().min(0),
	items: z
		.array(
			z.strictObject({
				request: z
					.string()
					.trim()
					.min(1)
					.max(2000)
					.describe(
						"一子呼出しで行う内容。元依頼の対象・条件を保つ。結果から決まる値は参照から得ることを記す。",
					),
				dependsOn: z
					.array(z.number().int().min(0))
					.max(6)
					.describe(
						"このitems配列内で先に実行する項目の0始まりの番号。依存がなければ空配列。",
					),
			}),
		)
		.max(6),
});
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
	if (input.expectedPlanRevision !== (state.plan?.revision ?? 0))
		throw new Error("execution_plan_revision_conflict");
	if (state.pending || planFinished(state))
		throw new Error("execution_plan_closed");
	if (!canPlan(state)) throw new Error("execution_plan_observation_required");
	if (!state.plan && !input.items.length)
		throw new Error("execution_plan_invalid");
	if (input.items.length > state.limits.childCalls - state.children)
		throw new Error("execution_plan_capacity");
	for (const [index, item] of input.items.entries())
		if (item.dependsOn.some((dep) => dep >= index))
			throw new Error("execution_plan_dependency_invalid");
	const ids = input.items.map(() => crypto.randomUUID());
	state.plan = {
		revision: input.expectedPlanRevision + 1,
		requestRevision,
		observedAt: observations(state),
		items: [
			...(state.plan?.items.filter((item) => !!item.inputDigest) ?? []),
			...input.items.map((item, index) => ({
				stepRef: `step:${ids[index]}`,
				childId: ids[index]!,
				request: item.request,
				dependsOn: item.dependsOn.map((dep) => `step:${ids[dep]}`),
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
		items:
			state.plan?.items.map(
				({
					stepRef,
					request,
					dependsOn,
					inputDigest,
					resultRef,
					resultState,
				}) => ({
					stepRef,
					request,
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
		return "現在は操作計画の作成段階です。set_planのitemsには個別担当へ実行させる作業だけを入れます。find_toolchain・read_reference・ask_user・complete_task/report_partialはhostの制御関数なので、これらの呼出しを計画の項目に含めません。子のreceiptの確認や最終的な要約は報告段階で行い、別の子作業として追加しません。itemsの各要素のキーはrequestとdependsOnだけです。";
	if (planFinished(state))
		return "現在は結果報告の段階です。全計画項目の実行は終わっています。対応するresultsを根拠に、要求全体の達成ならcomplete_task、不足があればreport_partialを一つ呼びます。";
	return "操作計画は採用済みで、現在は未実行項目を実行する段階です。今回実行するstepRefを確認し、用途に合う提示能力を使うかfind_toolchainで探します。作成済みの計画をそのままset_planで返し直しません。新しい観測から計画の不足が判明し、revisionAllowedがtrueの場合だけ未実行部分を改訂します。";
}
