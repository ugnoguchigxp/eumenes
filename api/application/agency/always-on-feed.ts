import { fixedInput, combineInput, currentInput } from "./input";
import { feedAlwaysOn } from "./always-on-flow";
import { recoverAlwaysOnScope } from "./always-on-recovery";
import type { AgencyHostDeps } from "./host-types";
import type { AlwaysOnScope } from "./always-on-scope";
import type { AgencyWork } from "./work";
type FeedHost = {
	deps: AgencyHostDeps;
	convs: Map<string, AlwaysOnScope>;
	persisted: Map<string, number>;
	recovering: Set<string>;
	on(): boolean;
	now(): number;
	refresh(c: AlwaysOnScope): Promise<void>;
	invalidate(c: AlwaysOnScope): void;
	conv(id: string): AlwaysOnScope;
	work: AgencyWork | undefined;
	collect(): Promise<void>;
	save(): Promise<void>;
	syncBusy(): void;
	feed(): {
		cursor: number;
		activeId: string | null;
		display: { id: string; until: number } | null;
	};
	adopt(value: { cursor: number; activeId: string | null }): void;
};
export async function pumpAlwaysOnHost(input: FeedHost) {
	const {
		deps,
		convs,
		recovering,
		on,
		now,
		refresh,
		invalidate,
		persisted,
		conv,
		work,
		collect,
		save,
		syncBusy,
	} = input;
	let { cursor, activeId, display } = input.feed();
	if (!on()) return;
	for (const id of recovering) {
		const c = convs.get(id);
		if (c) await recoverAlwaysOnScope(deps, c, now());
		recovering.delete(id);
	}
	for (const c of convs.values()) {
		if (
			deps.store.read((db) => deps.state!.epochInTransaction(db, c.id)) !==
			c.epoch
		) {
			invalidate(c);
			c.scheduler.dispose();
			convs.delete(c.id);
			persisted.delete(c.id);
		} else await refresh(c);
	}
	for (;;) {
		const events = deps.store.read((db) =>
			deps.conversation.changesInTransaction(db, cursor, 200),
		);
		for (const event of events) {
			if (
				event.namespace === "conversation" &&
				event.sourceKind === "message"
			) {
				const c = conv(event.conversationId);
				feedAlwaysOn(deps, c, event, now());
				if (event.speaker === "user" && (!display || display.until <= now()))
					activeId = c.id;
				c.heartbeat.event(now());
			}
			cursor = event.seq;
		}
		if (events.length < 200) break;
	}
	if (work)
		for (const c of convs.values()) {
			const todos = deps.store.read((db) =>
				work!
					.todosInTransaction(db, c.id)
					.filter(
						(t) =>
							t.status === "waiting" &&
							!!t.input?.complete &&
							currentInput(deps, db, t.input),
					),
			);
			const id = `work:${fixedInput(todos).sources[0]!.slice(-32)}`;
			if (
				todos.length &&
				!c.agent.snapshot().observations.some((o) => o.id === id)
			) {
				c.agent.observe(
					{
						id,
						kind: "source.changed",
						actor: "host",
						occurredAt: now(),
						text: JSON.stringify(
							todos.map(({ input: _input, ...todo }) => todo),
						),
					},
					combineInput(
						...todos.map((t) => t.input ?? { sources: [], complete: false }),
					),
				);
				c.revision++;
				c.heartbeat.event(now());
			}
		}
	input.adopt({ cursor, activeId });
	await collect();
	await save();
	syncBusy();
}
