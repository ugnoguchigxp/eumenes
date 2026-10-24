import { useCallback, useEffect, useRef } from "react";
import type { Run } from "../../../../../api/domains/dialogue/contracts";
import type { useReplay } from "./replay";

/** Proactive utterances of the agency host: runless assistant messages with this id prefix. */
const AGENCY_MESSAGE_PREFIX = "agency:";
const isAgencyUtterance = (message: { id: string }) =>
	message.id.startsWith(AGENCY_MESSAGE_PREFIX);

/**
 * New adopted answers and new agency utterances share the existing player; live voice turns own
 * their chunks.
 */
export function useAutomaticSpeech({
	runs,
	messages,
	enabled,
	player,
	ownsSpeech,
	blocked = false,
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
}) {
	const seen = useRef<Set<string> | null>(null);
	const seenUtterances = useRef<Set<string> | null>(null);
	const pending = useRef<
		Array<{ id: string; text: string; runId: string | null }>
	>([]);
	const epoch = useRef(0);
	const busy = useRef(false);
	const latest = useRef({ enabled, player, blocked });
	useEffect(() => {
		latest.current = { enabled, player, blocked };
	}, [enabled, player, blocked]);
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
			if (!enabled || ownsSpeech(run.utteranceId)) {
				seen.current.add(run.id);
				continue;
			}
			const message = messages.find(
				(message) => message.id === run.answerMessageId,
			);
			if (!message) continue; // The two queries can settle in either order.
			seen.current.add(run.id);
			if (!message.text.trim()) continue;
			pending.current.push({
				id: message.id,
				text: message.text,
				runId: run.id,
			});
		}
		for (const message of messages) {
			if (
				!isAgencyUtterance(message) ||
				seenUtterances.current!.has(message.id)
			)
				continue;
			seenUtterances.current!.add(message.id);
			if (!enabled || !message.text.trim()) continue;
			pending.current.push({ id: message.id, text: message.text, runId: null });
		}
		if (!enabled) {
			clearQueue();
			return;
		}
		if (blocked || busy.current || !pending.current.length) return;
		busy.current = true;
		const mine = epoch.current;
		void (async () => {
			try {
				while (
					mine === epoch.current &&
					latest.current.enabled &&
					!latest.current.blocked
				) {
					const answer = pending.current.shift();
					if (!answer) break;
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
	}, [runs, messages, enabled, player, ownsSpeech, blocked, clearQueue]);
	useEffect(() => {
		const prepare = () => {
			if (latest.current.enabled)
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
