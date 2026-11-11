/**
 * Eumenes' steer for the agenda reply: words the user sends while a reply is being written reach
 * that reply's next model call, through the server's one eumenes-steer inbox (vendor/steer). The
 * agency package has no steer of its own (user, 2026-11-11: "steerはagencyには含めず、eumenesにある
 * steerとの接続を心がけてください"); it gives the seam (`AgendaAddedWords`) and the mark its reply
 * rules read (`addedWordsLine`), and this fills the seam with Eumenes' inbox.
 *
 * As eumenes_steer/design.md §5 asks of Agency, the boundary is each `chat.complete` of the reply
 * loop (`runRespond` calls it again after its read tools), named by the call's number. The inbox
 * holds only the message's reference; its words are read again from the store when a call takes
 * them (a message forgotten meanwhile is not given). What one call took is given to the later calls
 * of the same reply too, where it was first given, in the order sent. Replies stream to the user as
 * they are written, so the first answer stands: `end` tells which messages the calls took, and the
 * conversation answers the rest with a run of its own.
 */
import type { SteeringInbox, SteeringTarget } from "eumenes-steer";
import type { ReplyMessage, ReplyPort } from "eumenes-agency";
import { addedWordsLine, type AgendaAddedWords } from "eumenes-agency/agenda";

/** One conversation's steering: its replies run one at a time; `send` goes to the reply open now. */
export function createAgendaSteering(input: {
	readonly inbox: SteeringInbox;
	/** The words of a user's message in the store, or null once it is gone (forgotten). */
	readonly read: (messageId: string) => string | null;
	/** The inbox's clock (its `expiresAt` is read against this). */
	readonly now: () => number;
	/** Target ids are `<prefix><replyId>`: the server's inbox serves every conversation. */
	readonly targetPrefix: string;
}): AgendaAddedWords {
	let open: {
		readonly target: SteeringTarget;
		readonly taken: Set<string>;
	} | null = null;

	return {
		begin(replyId) {
			if (open) throw new Error("steer: a reply is open already");
			const targetId = `${input.targetPrefix}${replyId}`;
			const opened = input.inbox.open(targetId, "1");
			if (opened.status !== "opened")
				throw new Error(`steer: ${targetId} ${opened.status}`);
			const run = { target: opened.target, taken: new Set<string>() };
			open = run;
			return {
				wrap(chat): ReplyPort {
					let call = 0;
					// Messages taken by an earlier call, kept where they were first given.
					const given: { at: number; message: ReplyMessage }[] = [];
					return {
						async complete(request, onDelta, signal) {
							call++;
							const claimed = run.target.claim(`call-${call}`);
							const fresh: { id: string; message: ReplyMessage }[] = [];
							if (claimed.status === "claimed")
								for (const e of claimed.batch.events) {
									if (e.expiresAt <= input.now()) continue;
									const text = input.read(e.sourceRef);
									if (text === null) continue;
									fresh.push({
										id: e.sourceRef,
										message: { role: "user", content: addedWordsLine(text) },
									});
								}
							const at = request.messages.length;
							const messages = [...request.messages];
							// Each place gets its words in the order sent; places from the end, so earlier
							// positions hold.
							const places = new Map<number, ReplyMessage[]>();
							for (const a of [
								...given,
								...fresh.map((f) => ({ at, message: f.message })),
							])
								places.set(a.at, [...(places.get(a.at) ?? []), a.message]);
							for (const [place, words] of [...places].sort(
								(x, y) => y[0] - x[0],
							))
								messages.splice(place, 0, ...words);
							let out: Awaited<ReturnType<ReplyPort["complete"]>>;
							try {
								out = await chat.complete(
									{ ...request, messages },
									onDelta,
									signal,
								);
							} catch (error) {
								// Not known to be taken: the words stay for a later call or a run of their own.
								if (claimed.status === "claimed")
									run.target.settle(claimed.batch.id, "released");
								throw error;
							}
							if (claimed.status === "claimed")
								run.target.settle(claimed.batch.id, "committed");
							for (const f of fresh) {
								run.taken.add(f.id);
								given.push({ at, message: f.message });
							}
							return out;
						},
					};
				},
				end() {
					run.target.close();
					if (open === run) open = null;
					return [...run.taken];
				},
			};
		},
		send(messageId) {
			if (!open) return false;
			return (
				open.target.enqueue({
					id: messageId,
					sourceRef: messageId,
					sourceRevision: "1",
				}).status === "accepted"
			);
		},
	};
}
