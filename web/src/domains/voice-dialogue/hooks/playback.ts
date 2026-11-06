import type { QueryClient } from "@tanstack/react-query";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { describeError } from "../../../errorMessages";
import { queryRoots } from "../../../queryKeys";
import { type AudioController } from "../../audio";
import type { AvatarCue } from "../../avatar";
import { invalidateDialogueViews } from "../../dialogue";
import { queueChunks, type ChunkQueue } from "./chunk-player";
import { createVoiceMachine, isCurrent } from "./machine";
import { useVoiceTurn } from "./turn";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;
type Replacement = { id: string; previous: string | null } | null;
/** Follows the same voice machine and refs as capture; it owns no second session state. */
export function followVoicePlayback(deps: {
	value: ReturnType<typeof useVoiceTurn>["data"];
	client: VoiceDialogueClient;
	cache: QueryClient;
	turnId: string | null;
	machine: ReturnType<typeof createVoiceMachine>;
	controller: Ref<AudioController | null>;
	options: Ref<Settings["voice"] | undefined>;
	replacement: Ref<Replacement>;
	queue: Ref<ChunkQueue | null>;
	cancelPlayback: () => void;
	setError: Setter<string | null>;
	setTurnId: Setter<string | null>;
	setRecognitionId: Setter<string | null>;
	setSubtitle: Setter<{ key: string; text: string } | null>;
	setAvatarCue: Setter<AvatarCue | null>;
	noticeQuiet?: () => Promise<void>;
}) {
	const {
		value,
		client,
		cache,
		turnId,
		machine,
		controller,
		options,
		replacement,
		queue,
		cancelPlayback,
		setError,
		setTurnId,
		setRecognitionId,
		setSubtitle,
		setAvatarCue,
		noticeQuiet,
	} = deps;

	if (!value) return;
	if (value.status === "failed")
		// Keep the failure visible when restoring a previous accepted turn.
		setError(
			value.error ? describeError(value.error) : "音声処理に失敗しました",
		);
	const pending = replacement.current;
	if (pending?.id === value.utteranceId) {
		if (
			value.text?.trim() &&
			value.runId &&
			!["failed", "cancelled", "interrupted"].includes(value.status)
		) {
			replacement.current = null;
			machine.dispatch({
				type: "turn_selected",
				utteranceId: value.utteranceId,
			});
			if (
				pending.previous &&
				pending.previous !== value.utteranceId &&
				options.current?.bargeIn !== false
			) {
				controller.current?.stopPlayback();
				cancelPlayback();
				void client.voiceCancel(pending.previous).catch(() => {});
			}
		} else if (
			["completed", "failed", "cancelled", "interrupted"].includes(value.status)
		) {
			replacement.current = null;
			setTurnId(pending.previous);
			setRecognitionId(pending.previous);
			return;
		}
	}
	if (value.runId && value.text)
		invalidateDialogueViews(cache, client.identity, "main");
	const active = machine.get().session;
	const valid = () =>
		!!active && isCurrent(machine.get(), active.token, value.utteranceId);
	if (
		value.audioChunks !== undefined &&
		active &&
		value.sessionId === active.id &&
		value.generation === active.generation &&
		valid()
	) {
		if (["failed", "cancelled", "interrupted"].includes(value.status)) {
			controller.current?.stopPlayback();
			cancelPlayback();
			return;
		}
		let playback = queue.current;
		if (playback?.id !== value.utteranceId) {
			const installed = machine.dispatch({
				type: "player_installed",
				id: value.utteranceId,
			});
			playback = {
				id: value.utteranceId,
				epoch: installed.player!.epoch,
				tail: Promise.resolve(),
			};
			queue.current = playback;
		}
		queueChunks(value, playback, {
			client,
			cache,
			controller: () => controller.current,
			volume: () => options.current?.outputVolume,
			delivered: (key) => machine.get().delivered.has(key),
			markDelivered: (key) =>
				machine.dispatch({ type: "delivered_marked", key }),
			queued: () => machine.get().player?.epoch === playback.epoch,
			valid,
			setSubtitle,
			setAvatarCue,
			noticeQuiet,
			fail: (e) => {
				if (!valid()) return;
				setError(describeError(e));
				controller.current?.stopPlayback();
				cancelPlayback();
				machine.dispatch({ type: "turn_released" });
				void client.voiceCancel(value.utteranceId).catch(() => {});
			},
		});
		return;
	}

	if (
		value.status === "ready" &&
		active &&
		value.sessionId === active.id &&
		value.generation === active.generation &&
		machine.get().current === value.utteranceId &&
		!machine.get().delivered.has(value.utteranceId)
	) {
		machine.dispatch({ type: "delivered_marked", key: value.utteranceId });
		void client
			.voiceAudio(value.utteranceId)
			.then((bytes) => {
				if (!valid()) return;
				return controller.current?.play(
					bytes,
					() => {
						void client
							.voicePlayed(value.utteranceId)
							.then(() =>
								cache.invalidateQueries({
									queryKey: [queryRoots.voiceDialogue, client.identity, turnId],
								}),
							)
							.catch((e) => setError(describeError(e)));
					},
					{
						waitForPrevious: options.current?.bargeIn === false,
						volume: options.current?.outputVolume,
						shouldPlay: valid,
					},
				);
			})
			.catch((e) => setError(describeError(e)));
	}
}
