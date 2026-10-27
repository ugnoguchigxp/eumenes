/**
 * One seeded event as the product appends it: the conversation message, the continuity event(s), and the input's
 * utterance (the user's words to the main agent; the agent's as far as they were heard).
 */
import type { Database } from "bun:sqlite";
import type { ConversationEvent } from "../../../continuity";
import type { SeedEvent } from "./case-schema";
import type { SessionContext } from "./session-context";
import { CONVERSATION_ID } from "./session-types";

export function writeEvent(
	ctx: SessionContext,
	db: Database,
	seed: SeedEvent,
	pending = false,
): ConversationEvent[] {
	const { events, conversation, refs, resolve } = ctx;
	const at = ctx.jst(seed.at);
	const written: ConversationEvent[] = [];
	const add = (input: Parameters<typeof events.appendInTransaction>[1]) => {
		const { event } = events.appendInTransaction(db, input);
		written.push(event);
		return event;
	};
	const remember = (key: string | undefined, event: ConversationEvent) => {
		if (key) refs.set(key, event.id);
	};
	const message = (role: "user" | "assistant", text: string) => {
		const id = ctx.nextMessage();
		conversation.appendInTransaction(db, {
			id,
			conversationId: CONVERSATION_ID,
			role,
			text,
			createdAt: seed.at,
			runId: null,
		});
		return id;
	};
	const utterance = (
		speaker: "user" | "agent",
		text: string,
		messageId: string,
	) =>
		ctx.conversation.input.appendUtteranceInTransaction(db, {
			conversationId: CONVERSATION_ID,
			speaker,
			text,
			messageId,
			at: seed.at,
		});
	if (seed.type === "said" && seed.by === "user") {
		const id = message("user", seed.text);
		utterance("user", seed.text, id);
		remember(
			seed.key,
			add({
				conversationId: CONVERSATION_ID,
				at,
				type: "said",
				by: "user",
				fields: { text: seed.text },
				messageIds: [id],
				pending,
			}),
		);
	} else if (seed.type === "said" && seed.by === "agent") {
		const id = message("assistant", seed.text);
		const about = seed.about ? (resolve(seed.about) as string[]) : [];
		const todoRefs = seed.todoRefs ? (resolve(seed.todoRefs) as string[]) : [];
		const said = add({
			conversationId: CONVERSATION_ID,
			at,
			type: "said",
			by: "agent",
			fields: {
				text: seed.text,
				...(seed.origin === "reply" ? {} : { origin: seed.origin }),
				...(todoRefs.length ? { todoRefs } : {}),
				...(about.length ? { about } : {}),
			},
			messageIds: [id],
			...(seed.heard !== null || seed.speaking
				? {
						// The product's key: an announcement's, or the answer run's.
						deliveryKey:
							seed.origin === "announcement"
								? `announcement:${id}`
								: `run:${id}`,
					}
				: {}),
		});
		remember(seed.key, said);
		const heard =
			seed.heard === "partial"
				? seed.deliveredText
				: seed.heard === "none"
					? ""
					: seed.text;
		if (heard && !seed.speaking) utterance("agent", heard, id);
		if (seed.heard !== null)
			add({
				conversationId: CONVERSATION_ID,
				at,
				type: "delivered",
				by: "host",
				fields: {
					ref: said.id,
					heard: seed.heard,
					...(seed.heard === "partial"
						? { deliveredText: seed.deliveredText }
						: {}),
				},
			});
	} else if (seed.type === "said") {
		const id = message("assistant", seed.text);
		remember(
			seed.key,
			add({
				conversationId: CONVERSATION_ID,
				at,
				type: "said",
				by: "specialist",
				fields: { toolchain: seed.toolchain, text: seed.text },
				messageIds: [id],
			}),
		);
	} else {
		remember(
			seed.key,
			add({
				conversationId: CONVERSATION_ID,
				at,
				type: seed.type,
				by: seed.type === "acted" ? seed.by : "host",
				fields: resolve(seed.fields) as Record<string, unknown>,
			}),
		);
	}
	return written;
}
