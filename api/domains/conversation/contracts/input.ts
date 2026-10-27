/** Who said an utterance of the conversation's input: the user, or the agent (its replies, announcements, own talk). */
export type UtteranceSpeaker = "user" | "agent";

/** One utterance as the input shows it: what was recognised or typed, or what reached the user. */
export type Utterance = {
	conversationId: string;
	/** The conversation's order of utterances. */
	seq: number;
	speaker: UtteranceSpeaker;
	text: string;
	/** The message (speech bubble) it is the text of. */
	messageId: string | null;
	at: string;
};

/** Where the recent conversation starts, and what it was cut on. */
export type ConversationCut = {
	/** The recent conversation is the utterances after this seq. */
	seq: number;
	/** Moves when what the input showed changes under it (a forget, a correction); a cut keeps it. */
	revision: number;
	/** The system part the cut was placed on: another one cuts again. */
	systemDigest: string;
	/** What `## Memory` showed when the cut was placed: another text cuts again. */
	memoryDigest: string;
	/** Why the next input must cut (a forget inside the recent conversation); null when none. */
	due: string | null;
	at: string;
};

/** One item the conversation's state holds: its text, and for a record where it came from. */
export type StateItem = { text: string };

/** The fields of the conversation's state the context keeper writes (section 7.1). */
export type ConversationStateBody = {
	topic: string | null;
	decisions: StateItem[];
	open: StateItem[];
	records: StateItem[];
};

export type ConversationState = {
	conversationId: string;
	version: number;
	body: ConversationStateBody;
	/** The newest utterance the state stands on. */
	basedOnSeq: number;
	at: string;
};
