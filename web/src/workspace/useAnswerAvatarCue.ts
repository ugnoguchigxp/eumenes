import { useEffect, useRef, useState } from "react";
import type { Message } from "../../../api/domains/conversation/contracts";
import { deliveryAvatarCue, type AvatarCue } from "../domains/avatar";

const answerExpressionMs = 2600;

export function useAnswerAvatarCue(
	messages: readonly Message[] | undefined,
	blocked: boolean,
) {
	const seen = useRef<Set<string> | null>(null);
	const [cue, setCue] = useState<AvatarCue | null>(null);
	const latest = messages?.findLast(
		(message) => message.presentation !== "artifact",
	);
	useEffect(() => {
		if (!messages) return;
		const fresh = seen.current && latest && !seen.current.has(latest.id);
		seen.current ??= new Set();
		for (const { id } of messages) seen.current.add(id);
		if (blocked || (fresh && latest.role !== "assistant")) {
			setCue(null);
			return;
		}
		if (fresh) {
			const key = `message:${latest.id}`;
			const next = deliveryAvatarCue(key, latest.delivery);
			setCue(next.emotion ? { ...next, gestureKey: key } : null);
		}
	}, [blocked, latest, messages]);
	useEffect(() => {
		if (!cue) return;
		const timer = setTimeout(() => setCue(null), answerExpressionMs);
		return () => clearTimeout(timer);
	}, [cue]);
	return !blocked && cue?.key === `message:${latest?.id}` ? cue : null;
}
