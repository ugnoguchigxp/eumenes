/**
 * The active short-term memory of a conversation (the ContextWindow specification, sections 5.6, 8, 9.3, 11):
 * the flow of events, the episode that replaced the events moved out of the window, the work results of the
 * conversation's TODOs, and the window's version. Long-term memory lives in `memory`, never here.
 */
export const eventTypes = ["said", "delivered", "acted", "notice"] as const;
export type EventType = (typeof eventTypes)[number];
export const eventActors = ["user", "agent", "specialist", "host"] as const;
export type EventActor = (typeof eventActors)[number];
/**
 * `pending`: a user utterance no generation has handled yet (shown as the newest message, not in the log).
 * `logged`: in the log, in `logOrder`. `moved`: moved out of the window (its frozen text is gone).
 */
export type EventStatus = "pending" | "logged" | "moved";

/** What a caller hands over; the store numbers it, renders it once and freezes the text. */
export type EventInput = {
	conversationId: string;
	at: string;
	type: EventType;
	by: EventActor;
	/** The event's own fields as the model reads them, in the order they are written. */
	fields: Record<string, unknown>;
	/** A shorter copy re-construction may switch to (a memory read without its results). */
	shortFields?: Record<string, unknown>;
	/** The conversation messages it shows: forgetting any of them purges its text. */
	messageIds?: readonly string[];
	/**
	 * Twice the same key is one event: the second append returns the first (an action that a repair or a retried
	 * generation calls again is carried out once).
	 */
	dedupeKey?: string;
	/**
	 * How the delivery side finds the utterance it delivered (`message:<id>`, `announcement:<run id>`): the key a
	 * `delivered` event is recorded against. One utterance per key.
	 */
	deliveryKey?: string;
	/** A user utterance that is not handled yet: kept out of the log until `handleInTransaction`. */
	pending?: boolean;
};

export type ConversationEvent = {
	conversationId: string;
	/** The order of receipt; the id the model reads is `e<seq>`. */
	seq: number;
	id: string;
	at: string;
	type: EventType;
	by: EventActor;
	status: EventStatus;
	/** The place in the log (the order of appending to it); null while pending. */
	logOrder: number | null;
	/** The frozen text in its current form; null once moved out. */
	text: string | null;
	tokens: number;
	form: "full" | "short";
	/** A short form exists. */
	shortable: boolean;
	deliveryKey: string | null;
	messageIds: string[];
	curated: boolean;
	forgotten: boolean;
};

export const episodeKinds = ["summary", "unsummarized"] as const;
export type EpisodeKind = (typeof episodeKinds)[number];
/** One part of the episode: a summary of a range of moved events, or the mark of a range without one. */
export type EpisodeSegment = {
	kind: EpisodeKind;
	/** The receipt range (`seq`) of the events it stands for. */
	fromSeq: number;
	toSeq: number;
	fromAt: string;
	toAt: string;
	count: number;
	/** The summary text; empty for an unsummarized range. */
	text: string;
	/** The messages the summary stands on: forgetting any of them turns it into an unsummarized range. */
	messageIds: string[];
};

/** The window version: it changes only at a re-construction or an immediate change, never on an append. */
export type WindowVersion = {
	conversationId: string;
	version: number;
	rebuiltAt: string | null;
	reason: string | null;
};
