import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EumenesClient } from "../../../client";
import type { ScreenOutput } from "../domains/audio";
import type { useVoiceDialogue } from "../domains/voice-dialogue";
import { useScreenPresence } from "./useScreenPresence";
import type { NoticeScreen } from "./useNotificationAudio";

/** A voice turn speaks on the session's controller while it responds and until its audio is played. */
const SPEAKING = ["responding", "synthesizing", "ready"];

/**
 * The screen's sound (spec tts-single-lane §4.2–4.4). The workspace makes one screen output that speech
 * and notices share and never sound together on; this adds whether this screen is the one that plays sound
 * (the one holding the microphone's session first), the backend claim that lets a speech or notice
 * sound once, and the voice turn counted as speech on the screen's output.
 */
export function useScreenSound(
	client: Pick<
		EumenesClient,
		"screenPresence" | "playbackScreen" | "subscribeChanges" | "claimSpeech"
	>,
	output: ScreenOutput,
	voice: Pick<ReturnType<typeof useVoiceDialogue>, "active" | "turn">,
) {
	useEffect(() => () => output.release(), [output]);
	const voiceSpeaking = !!voice.turn && SPEAKING.includes(voice.turn.status);
	const voiceSpeakingNow = useRef(voiceSpeaking);
	useEffect(() => {
		output.setSpeechElsewhere(() => voiceSpeakingNow.current);
	}, [output]);
	useEffect(() => {
		voiceSpeakingNow.current = voiceSpeaking;
		output.changed();
	}, [output, voiceSpeaking]);
	const presence = useScreenPresence(client, voice.active);
	const playbackNow = useRef(presence.playbackScreen);
	useEffect(() => {
		playbackNow.current = presence.playbackScreen;
	}, [presence.playbackScreen]);
	const claim = useCallback(
		(sourceKey: string) => client.claimSpeech(presence.screenId, sourceKey),
		[client, presence.screenId],
	);
	const notice = useMemo<NoticeScreen>(
		() => ({ output, playback: () => playbackNow.current, claim }),
		[output, claim],
	);
	return { playbackScreen: presence.playbackScreen, claim, notice };
}
