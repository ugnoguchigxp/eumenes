import type { AgencyHostDeps, Conv } from "./host-types";
import { agencyStatusSchema } from "../../domains/dialogue/contracts/agency-status";

const ATTENTION_MS = 45_000;

/** Display presence chooses a speech destination; it never creates a user turn or resets limits. */
export function createAttention(input: {
	deps: AgencyHostDeps;
	convs: ReadonlyMap<string, Conv>;
	now(): number;
	activeId(): string | null;
	convOf(id: string): Conv;
	activate(c: Conv): void;
	save(c: Conv): Promise<boolean>;
	available(): boolean;
	prune(): void;
}) {
	let display: { id: string; expiresAt: number } | null = null;
	const current = () =>
		display && display.expiresAt > input.now() ? display : null;
	function status(id: string) {
		const c = input.convs.get(id);
		const state = c?.runtime.snapshot().state;
		return agencyStatusSchema.parse({
			conversationId: id,
			activeConversationId: input.activeId(),
			displayedConversationId: current()?.id ?? null,
			displayExpiresAt: current()?.expiresAt ?? null,
			actionsEnabled: input.deps.settings.get().agency.actions?.enabled ?? true,
			tracked: !!c,
			busy: !!c?.background,
			idle: c?.planner.status() ?? null,
			counts: {
				interests:
					state?.interests?.filter((i) => i.status !== "faded").length ?? 0,
				openIntents:
					state?.intents.filter(
						(i) => i.state !== "completed" && i.state !== "abandoned",
					).length ?? 0,
				inFlight: state?.intents.filter((i) => !!i.workRef).length ?? 0,
			},
		});
	}
	return {
		preferred: () => current()?.id ?? null,
		status,
		async attend(id: string) {
			if (!input.available()) throw new Error("agency_unavailable");
			const entering = current()?.id !== id;
			const changed = !input.convs.has(id) || input.activeId() !== id;
			display = { id, expiresAt: input.now() + ATTENTION_MS };
			const c = input.convOf(id);
			if (
				entering &&
				(input.deps.settings.get().agency.actions?.enabled ?? true)
			) {
				const ordinal = input.deps.store.read((db) =>
					input.deps.conversation.latestOrdinalInTransaction(db, id),
				);
				const eventId = `screen-view:${ordinal}`;
				const snap = c.runtime.snapshot();
				const known =
					snap.observations.some((o) => o.id === eventId) ||
					snap.scheduling?.wake.events.includes(eventId) ||
					snap.forgottenRefs?.includes(eventId);
				if (!known)
					c.runtime.observe(
						{
							id: eventId,
							kind: "external.event",
							actor: "host",
							occurredAt: input.now(),
							text: "この会話が利用者の画面に表示されました。新しい利用者発言や依頼ではありません。",
						},
						{ sources: [], complete: true },
					);
			}
			input.activate(c);
			input.prune();
			c.scheduler.rearm();
			if (changed || entering) await input.save(c);
			return status(id);
		},
	};
}
