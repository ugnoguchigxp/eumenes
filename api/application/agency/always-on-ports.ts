import type { Database } from "bun:sqlite";
import { runRespond, emotionName } from "eumenes-agency";
import { isAlwaysOnSnapshot } from "../../domains/dialogue";
import { agencyStatusSchema } from "../../domains/dialogue/contracts";
import type {
	AgencyLayerPort,
	ConversationAgentPort,
} from "../../domains/dialogue/contracts";
import { currentInput } from "./input";
import { agencyReplyParts } from "./system-context";
import { deliveryEmotionOf } from "./speech";
import {
	alwaysOnEnvelope,
	alwaysOnProjection,
	type AlwaysOnScope,
} from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
export function createAlwaysOnPorts(input: {
	deps: AgencyHostDeps;
	convs: Map<string, AlwaysOnScope>;
	active(): string | null;
	display(): { id: string; until: number } | null;
	now(): number;
	changed(): void;
}) {
	const { deps, convs, active, display, now, changed } = input;
	function projection(db: Database, id: string) {
		const c = convs.get(id);
		const saved = deps.state
			?.recordsInTransaction(db)
			.find((r) => r.conversationId === id)?.snapshot;
		const snapshot = c ? alwaysOnEnvelope(c) : saved;
		return isAlwaysOnSnapshot(snapshot)
			? alwaysOnProjection(snapshot)
			: { lines: [], input: { sources: [], complete: true } };
	}
	const dialoguePort: AgencyLayerPort = {
		isCurrentInputInTransaction: (db, input) => currentInput(deps, db, input),
		inputForMessageInTransaction: (db, id) =>
			deps.state?.messageInputInTransaction(db, id) ?? null,
		inputForContextInTransaction: (db, id) => projection(db, id).input,
		stateForContextInTransaction: (db, id) => projection(db, id).lines,
		workChangedInTransaction: () => {
			changed();
		},
	};
	const conversationAgent: ConversationAgentPort = {
		system: () => agencyReplyParts(deps.settings.get().agency),
		async respond(input) {
			const reply = await runRespond({
				...input,
				emotion: deps.settings.get().agency.emotion,
			});
			return {
				text: reply.text,
				ended: reply.ended,
				...(reply.emotion
					? { emotion: deliveryEmotionOf(emotionName(reply.emotion)) }
					: {}),
			};
		},
	};
	function status(id: string) {
		const c = convs.get(id);
		const view = c?.agent.view();
		return agencyStatusSchema.parse({
			conversationId: id,
			activeConversationId: active(),
			displayedConversationId:
				display() && display()!.until > now() ? display()!.id : null,
			displayExpiresAt: display()?.until ?? null,
			actionsEnabled: deps.settings.get().agency.actions?.enabled ?? true,
			tracked: !!c,
			busy: !!c?.controller,
			idle: c
				? {
						blockedBy: c.busy ? "busy" : null,
						unanswered: view!.pacing.unanswered,
						level: 0,
						nextIntervalSec: c.heartbeat.status().intervalSec,
					}
				: null,
			counts: {
				interests: deps.settings.get().agency.interests.length,
				openIntents: 0,
				inFlight: view?.preparing.length ?? 0,
			},
		});
	}

	return { dialoguePort, conversationAgent, status };
}
