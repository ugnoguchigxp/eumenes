import { useEffect, useState } from "react";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";

type Snapshot = { turn: VoiceTurn; prefix: string };
const join = (before: string, after: string | null | undefined) =>
	[before, after].filter(Boolean).join("\n");

function pendingText(snapshot: Snapshot | null): string {
	if (!snapshot || snapshot.turn.runId) return "";
	const { turn, prefix } = snapshot;
	if (turn.status === "recognizing") return join(prefix, turn.text);
	return turn.status === "input_ready" ? (turn.text ?? "") : "";
}

function observe(previous: Snapshot | null, turn: VoiceTurn | undefined) {
	if (!turn || previous?.turn === turn) return previous;
	return {
		turn,
		prefix:
			previous?.turn.utteranceId === turn.utteranceId
				? previous.prefix
				: pendingText(previous),
	};
}

/** Presentation only: the server's assessed text alone is eligible for commit. */
export function useTranscription(
	turn: VoiceTurn | undefined,
	recognitionId: string | null,
	preview: string | null,
) {
	const [saved, setSaved] = useState<Snapshot | null>(null);
	useEffect(() => {
		// Preserve the pending text across the query switch while a new upload starts.
		// oxlint-disable-next-line react/set-state-in-effect
		setSaved((previous) => (recognitionId ? observe(previous, turn) : null));
	}, [turn, recognitionId]);
	if (!recognitionId) return null;
	const snapshot = observe(saved, turn);
	const current = snapshot?.turn.utteranceId === recognitionId;
	const text = current
		? snapshot.turn.status === "recognizing"
			? join(snapshot.prefix, snapshot.turn.text || preview)
			: snapshot.turn.text
		: join(pendingText(snapshot), preview);
	return text ? { id: recognitionId, text } : null;
}
