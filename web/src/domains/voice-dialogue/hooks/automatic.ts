import { useCallback, useEffect, useRef } from "react";
import type { Run } from "../../../../../api/domains/dialogue/contracts";
import type { useReplay } from "./replay";

/** Proactive utterances of the agency host: runless assistant messages with this id prefix. */
const AGENCY_MESSAGE_PREFIX = "agency:";
const isAgencyUtterance = (message: { id: string }) =>
	message.id.startsWith(AGENCY_MESSAGE_PREFIX);

type Pending = {
	id: string;
	text: string;
	runId: string | null;
	/** The claim's key (spec tts-single-lane §4.3). */
	sourceKey: string;
};

/**
 * New adopted answers and new agency utterances share the existing player; live voice turns own
 * their chunks. Eumenes speaks as one (spec tts-single-lane §4.1–4.3): only the playback screen
 * reads, only the conversation agent or the specialist the conversation is switched to is read, and
 * each one is claimed on the backend first so no other screen reads it too.
 */
export function useAutomaticSpeech({
	runs,
	messages,
	enabled,
	player,
	ownsSpeech,
	blocked = false,
	screen,
	speaker,
}: {
	runs: Run[] | undefined;
	messages: Array<{ id: string; text: string }> | undefined;
	enabled: boolean | undefined;
	player: Pick<
		ReturnType<typeof useReplay>,
		"play" | "stopAutomatic" | "prepare"
	>;
	ownsSpeech: (utteranceId: string | null) => boolean;
	/** Wait until the shared voice controller finishes its existing answer. */
	blocked?: boolean;
	screen: {
		/** This screen is the one that plays sound. */
		playbackScreen: boolean;
		/** Claims the speech for this screen; false means another screen or nobody reads it. */
		claim: (sourceKey: string) => Promise<boolean>;
	};
	/** The conversation's specialist session; it speaks only while active (switched to). */
	speaker: { id: string; state: string } | null | undefined;
}) {
	const { playbackScreen: playback, claim } = screen;
	const speakerSession = speaker?.state === "active" ? speaker.id : null;
	const seen = useRef<Set<string> | null>(null);
	const seenUtterances = useRef<Set<string> | null>(null);
	const pending = useRef<Pending[]>([]);
	const epoch = useRef(0);
	const busy = useRef(false);
	const audible = !!enabled && playback;
	const latest = useRef({ audible, player, blocked, claim });
	useEffect(() => {
		latest.current = { audible, player, blocked, claim };
	}, [audible, player, blocked, claim]);
	const clearQueue = useCallback(() => {
		pending.current = [];
		epoch.current++;
		busy.current = false;
		latest.current.player.stopAutomatic();
	}, []);
	useEffect(() => {
		if (!runs || !messages || enabled === undefined) return;
		if (!seen.current) {
			// Opening a conversation never reads its existing history aloud.
			seen.current = new Set(
				runs.filter((run) => run.status === "completed").map((run) => run.id),
			);
			seenUtterances.current = new Set(
				messages.filter(isAgencyUtterance).map((message) => message.id),
			);
			return;
		}
		for (const run of runs) {
			if (run.status !== "completed" || seen.current.has(run.id)) continue;
			if (
				!audible ||
				ownsSpeech(run.utteranceId) ||
				(run.specialistSessionId && run.specialistSessionId !== speakerSession)
			) {
				seen.current.add(run.id);
				continue;
			}
			const message = run.answerMessageId
				? messages.find((message) => message.id === run.answerMessageId)
				: run.announcement
					? {
							id: `announcement:${run.id}:${run.revision}`,
							text: run.announcement,
						}
					: undefined;
			if (!message) continue; // The two queries can settle in either order.
			seen.current.add(run.id);
			if (!message.text.trim()) continue;
			pending.current.push({
				id: message.id,
				text: message.text,
				runId: run.id,
				sourceKey: run.answerMessageId
					? `run:${run.id}:answer`
					: `run:${run.id}:announcement:${run.revision}`,
			});
		}
		for (const message of messages) {
			if (
				!isAgencyUtterance(message) ||
				seenUtterances.current!.has(message.id)
			)
				continue;
			seenUtterances.current!.add(message.id);
			if (!audible || !message.text.trim()) continue;
			pending.current.push({
				id: message.id,
				text: message.text,
				runId: null,
				sourceKey: `message:${message.id}`,
			});
		}
		if (!audible) {
			clearQueue();
			return;
		}
		if (blocked || busy.current || !pending.current.length) return;
		busy.current = true;
		const mine = epoch.current;
		const current = () =>
			mine === epoch.current &&
			latest.current.audible &&
			!latest.current.blocked;
		void (async () => {
			try {
				while (current()) {
					const answer = pending.current.shift();
					if (!answer) break;
					const claimed = await latest.current
						.claim(answer.sourceKey)
						.catch(() => false);
					if (!claimed || !current()) continue;
					await latest.current.player.play(
						answer.id,
						answer.text,
						answer.runId,
						{ automatic: true },
					);
				}
			} finally {
				if (mine === epoch.current) busy.current = false;
			}
		})();
	}, [
		runs,
		messages,
		enabled,
		audible,
		player,
		ownsSpeech,
		blocked,
		speakerSession,
		clearQueue,
	]);
	useEffect(() => {
		const prepare = () => {
			if (latest.current.audible)
				void latest.current.player.prepare().catch(() => {});
		};
		document.addEventListener("pointerdown", prepare);
		document.addEventListener("keydown", prepare);
		return () => {
			document.removeEventListener("pointerdown", prepare);
			document.removeEventListener("keydown", prepare);
			clearQueue();
		};
	}, [clearQueue]);
}
