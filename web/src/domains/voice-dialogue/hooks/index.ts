import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { describeError } from "../../../errorMessages";
import {
	createAudioController,
	type AudioController,
	type AudioStore,
	type CreateAudio,
} from "../../audio";
import type { AvatarCue } from "../../avatar";
import { type ChunkQueue } from "./chunk-player";
import { commitIdleInput } from "./input-commit";
import { createInputLedger } from "./input-timing";
import { createVoiceMachine, isCurrent } from "./machine";
import { followVoicePlayback } from "./playback";
import { requestPreview, type RecognitionCandidate } from "./preview";
import { createSegmentUploader } from "./segment-upload";
import { useTranscription } from "./transcription";
import { useVoiceTurn } from "./turn";
/** `noticeQuiet` holds a reply chunk while a notice sounds on the screen (spec tts-single-lane §4.4). */
export function useVoiceDialogue(
	client: VoiceDialogueClient,
	store: AudioStore,
	createAudio: CreateAudio = createAudioController,
	settings?: Settings["voice"],
	noticeQuiet?: () => Promise<void>,
) {
	const cache = useQueryClient();
	const options = useRef(settings);
	options.current = settings;
	const controller = useRef<AudioController | null>(null);
	const inputEnabled = useRef(false);
	const replacement = useRef<{ id: string; previous: string | null } | null>(
		null,
	);
	// Bookkeeping lives in the machine; refs below are handles outside React.
	const [machine] = useState(createVoiceMachine);
	const tokens = useRef(0);
	const upload = useRef<{ token: number; tail: Promise<void> } | null>(null);
	const queue = useRef<ChunkQueue | null>(null);
	const candidate = useRef<RecognitionCandidate | null>(null);
	const inputs = useRef(createInputLedger());
	const [inputVersion, setInputVersion] = useState(0);
	const [previewText, setPreviewText] = useState<string | null>(null);
	const [avatarCue, setAvatarCue] = useState<AvatarCue | null>(null);
	const [subtitle, setSubtitle] = useState<{
		key: string;
		text: string;
	} | null>(null);
	const [recognitionId, setRecognitionId] = useState<string | null>(null);
	const cancelPlayback = useCallback(() => {
		queue.current = null;
		machine.dispatch({ type: "playback_cancelled" });
		setSubtitle(null);
		setAvatarCue(null);
	}, [machine]);
	function partial(wav: Uint8Array) {
		requestPreview(client, machine, candidate, setPreviewText, wav);
	}
	const [turnId, setTurnId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState(false);
	const turn = useVoiceTurn(client, turnId);
	useEffect(() => {
		followVoicePlayback({
			value: turn.data,
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
		});
	}, [turn.data, client, cache, turnId, machine, cancelPlayback, noticeQuiet]);

	useEffect(() => {
		const value = turn.data;
		if (
			!value ||
			value.utteranceId !== recognitionId ||
			value.status !== "input_ready"
		)
			return;
		commitIdleInput(
			value,
			client,
			cache,
			machine,
			inputEnabled.current,
			candidate.current,
			controller.current,
			inputs.current,
			setError,
		);
	}, [turn.data, recognitionId, inputVersion, turnId, client, cache, machine]);
	async function start() {
		if (machine.get().phase === "active" && machine.get().session?.failed) {
			await stop();
			return start();
		}
		if (machine.get().phase !== "idle") {
			if ((machine.get().session?.pending ?? 0) >= 2) return;
			if (
				machine.get().phase === "active" &&
				!active &&
				controller.current?.pauseInput
			) {
				inputEnabled.current = true;
				store.setState({ inputPhase: "starting" });
				setActive(true);
				setInputVersion((v) => v + 1);
				setError(null);
				const sessionToken = machine.get().session!.token;
				try {
					await controller.current.start();
				} catch (error) {
					if (!isCurrent(machine.get(), sessionToken)) return;
					inputEnabled.current = false;
					setActive(false);
					store.setState({ inputPhase: "idle" });
					setError(describeError(error));
				}
			}
			return;
		}
		inputEnabled.current = true;
		replacement.current = null;
		inputs.current.committing.clear();
		setError(null);
		setRecognitionId(null);
		setPreviewText(null);
		setTurnId(null);
		const startToken = ++tokens.current;
		machine.dispatch({ type: "start_requested", token: startToken });
		store.setState({ inputPhase: "starting" });
		const cancelled = () => machine.get().startToken !== startToken;
		setActive(true);
		const next = { id: crypto.randomUUID(), generation: 1 };
		const sessionToken = ++tokens.current;
		const live = () => isCurrent(machine.get(), sessionToken);
		const inputLive = () => live() && inputEnabled.current;
		try {
			await client.voiceStart(next.id, next.generation);
			if (cancelled()) {
				await client.voiceStop(next.id, next.generation);
				return;
			}
			machine.dispatch({
				type: "session_opened",
				token: startToken,
				sessionToken,
				...next,
			});
			upload.current = { token: sessionToken, tail: Promise.resolve() };
			const audio = createAudio(
				(state) => {
					if (live()) store.setState(state);
				},
				() => {
					if (!inputLive() || machine.get().session?.failed) return;
					candidate.current?.controller?.abort();
					const nextCandidate = {
						id: crypto.randomUUID(),
						finalized: false,
						busy: false,
					};
					candidate.current = nextCandidate;
					setError(null);
					setInputVersion((v) => v + 1);
					setRecognitionId(nextCandidate.id);
					setPreviewText(null);
					// Energy alone cannot distinguish speech from noise. Keep the answer
					// until the replacement has a nonempty accepted transcript.
				},
				createSegmentUploader({
					client,
					cache,
					machine,
					candidate,
					upload,
					inputs,
					replacement,
					setInputVersion,
					setRecognitionId,
					setPreviewText,
					setTurnId,
					setError,
					suspendInput,
					cancelPlayback,
					live,
					inputLive,
					sessionToken,
				}),
				{
					...options.current,
					onPartial: (wav) => {
						if (inputLive()) partial(wav);
					},
					// Without barge-in nothing may interrupt a reply, so it must not be heard either.
					halfDuplex: () => options.current?.bargeIn === false,
					onLost: (reason) => {
						if (!inputLive()) return;
						void pause();
						setError(describeError(reason));
					},
					onNotice: (reason) => {
						if (!live()) return;
						if (reason === "recording_limit") {
							suspendInput();
							setError(
								"録音が60秒に達したため文字起こしを保存し、マイクを停止しました。続きはマイクを再開して話してください。",
							);
						} else setError(describeError(reason));
					},
				},
			);
			controller.current = audio;
			try {
				await audio.start();
			} catch (error) {
				if (cancelled()) return;
				await stop();
				setError(describeError(error));
			}
		} catch (error) {
			const report = !cancelled();
			if (report) store.setState({ inputPhase: "idle" });
			if (live()) await stop();
			if (report) setError(describeError(error));
		} finally {
			if (machine.get().startToken === startToken) {
				setActive(
					!!machine.dispatch({ type: "start_settled", token: startToken })
						.session && inputEnabled.current,
				);
			}
		}
	}
	async function stop() {
		inputEnabled.current = false;
		replacement.current = null;
		setActive(false);
		setRecognitionId(null);
		candidate.current?.controller?.abort();
		candidate.current = null;
		setPreviewText(null);
		cancelPlayback();
		const active = machine.get().session;
		// Also cancels a start in flight: its token no longer matches.
		machine.dispatch({ type: "stopped" });
		upload.current = null;
		const audio = controller.current;
		controller.current = null;
		setTurnId(null);
		store.setState({ phase: "idle", inputPhase: "idle", level: 0 });
		await audio?.stop();
		if (active)
			await client.voiceStop(active.id, active.generation).catch((e) => {
				if (machine.get().phase === "idle") setError(describeError(e));
			});
	}
	function pause() {
		const audio = controller.current;
		if (!audio?.pauseInput) return stop();
		// The controller stages the last spoken segment before detaching the mic.
		audio.pauseInput();
		inputEnabled.current = false;
		setActive(false);
		candidate.current?.controller?.abort();
		candidate.current = null;
	}
	// Used only after a final segment or failure. Keep the accepted reply alive,
	// including for injected controllers that do not expose a microphone pause.
	function suspendInput() {
		inputEnabled.current = false;
		setActive(false);
		controller.current?.pauseInput?.();
		candidate.current?.controller?.abort();
		candidate.current = null;
		setPreviewText(null);
	}
	useEffect(() => {
		// Muting takes effect now: drop what is playing and release the turn.
		if (settings?.autoSpeak !== false) return;
		controller.current?.stopPlayback();
		// eslint-disable-next-line react/set-state-in-effect
		cancelPlayback();
		const id = machine.get().current;
		if (!id) return;
		machine.dispatch({ type: "turn_released" });
		void client.voiceCancel(id).catch(() => {});
	}, [settings?.autoSpeak, client, machine, cancelPlayback]);
	useEffect(
		() => () => {
			void controller.current?.stop();
			candidate.current?.controller?.abort();
			cancelPlayback();
			const active = machine.get().session;
			if (active)
				void client.voiceStop(active.id, active.generation).catch(() => {});
			machine.dispatch({ type: "stopped" });
			upload.current = null;
		},
		[client, machine, cancelPlayback],
	);
	const transcription = useTranscription(turn.data, recognitionId, previewText);
	return {
		ownsSpeech: machine.ownsSpeech,
		start,
		stop,
		pause,
		/** The running session's controller; replay shares its gate and playback epoch. */
		audio: () => controller.current,
		/** Cuts off the reply being spoken (as barge-in does) so another playback can start. */
		interrupt: () => {
			controller.current?.stopPlayback();
			cancelPlayback();
			const id = machine.get().current;
			if (!id) return;
			machine.dispatch({ type: "turn_released" });
			void client.voiceCancel(id).catch(() => {});
		},
		subtitle: subtitle?.text ?? null,
		turn: turn.data,
		previewText,
		recognitionId,
		transcription,
		error:
			error ??
			(turn.isError
				? "音声処理の結果を取得できません。接続を再確認してください。"
				: null),
		active,
		avatarCue,
	};
}
