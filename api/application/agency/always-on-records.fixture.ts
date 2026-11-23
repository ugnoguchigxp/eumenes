import { agendaFixture, noRecords, type CallKind } from "./always-on.fixture";

export type Fixture = Awaited<ReturnType<typeof agendaFixture>>;
export const found = (over: Partial<ReturnType<typeof noRecords>>) => ({
	...noRecords(),
	...over,
});
/** A script that answers the records writer with the given output (the rest of the calls fall back). */
export const writes =
	(out: unknown | ((n: number) => unknown)) => (kind: CallKind) =>
		kind === "records"
			? typeof out === "function"
				? (out as (n: number) => unknown)(0)
				: out
			: undefined;
export const plans = (f: Fixture) =>
	f.h.store.read((db) => f.deps.continuity.plans.listInTransaction(db));
export const questions = (f: Fixture) =>
	f.h.store.read((db) => f.deps.continuity.questions.listInTransaction(db));
export const exchange = async (f: Fixture, n: string, text: string) => {
	await f.user(`user-${n}`, "ao", text);
	await f.assistant(`answer-${n}`, "いいですね。", "ao");
};
