import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	type AudioController,
	type CreateAudio,
	type AudioStore,
	createAudioController,
} from "../../audio";
import { invalidateDialogueViews } from "../../dialogue";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import type { AvatarCue } from "../../avatar";
import { queryRoots } from "../../../queryKeys";
import { createVoiceMachine, isCurrent } from "./machine";
import { describeError } from "../../../errorMessages";
export function useVoiceDialogue(
	client: VoiceDialogueClient,
	store: AudioStore,
	createAudio: CreateAudio = createAudioController,
	settings?: Settings["voice"],
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
	const queue = useRef<{
		id: string;
		epoch: number;
		tail: Promise<void>;
		finish?: () => void;
	} | null>(null);
	const candidate = useRef<{
		id: string;
		finalized: boolean;
		busy: boolean;
		controller?: AbortController;
		latest?: Uint8Array;
	} | null>(null);
	const [previewText, setPreviewText] = useState<string | null>(null);
	const [avatarCue, setAvatarCue] = useState<AvatarCue | null>(null);
	const [subtitle, setSubtitle] = useState<{
		key: string;
		text: string;
	} | null>(null);
	const [recognitionId, setRecognitionId] = useState<string | null>(null);
	const cancelPlayback = useCallback(() => {
		queue.current?.finish?.();
		queue.current = null;
		machine.dispatch({ type: "playback_cancelled" });
		setSubtitle(null);
		setAvatarCue(null);
	}, [machine]);
	function partial(wav: Uint8Array) {
		const active = machine.get().session,
			u = candidate.current;
		if (!active || !u || u.finalized || active.failed) return;
		if (u.busy) {
			u.latest = wav;
			return;
		}
		u.busy = true;
		u.controller = new AbortController();
		void client
			.voicePreview(
				active.id,
				active.generation,
				u.id,
				wav,
				u.controller.signal,
			)
			.then((value) => {
				if (
					isCurrent(machine.get(), active.token) &&
					candidate.current === u &&
					!u.finalized &&
					value.text
				)
					setPreviewText(value.text);
			})
			.catch(() => {
				/* Provisional decoding never blocks the final request. */
			})
			.finally(() => {
				u.busy = false;
				const latest = u.latest;
				u.latest = undefined;
				if (latest && candidate.current === u && !u.finalized) partial(latest);
			});
	}
	const [turnId, setTurnId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState(false);
	const turn = useQuery({
		queryKey: [queryRoots.voiceDialogue, client.identity, turnId],
		enabled: !!turnId,
		queryFn: () => {
			if (!turnId) throw new Error("turn_id_missing");
			return client.voiceTurn(turnId);
		},
		retry: 0,
	});
	useEffect(() => {
		const value = turn.data;
		if (!value) return;
		if (value.status === "failed")
			// Keep the failure visible when restoring a previous accepted turn.
			// oxlint-disable-next-line react/set-state-in-effect
			setError(value.error ?? "音声処理に失敗しました");
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
				["completed", "failed", "cancelled", "interrupted"].includes(
					value.status,
				)
			) {
				replacement.current = null;
				setTurnId(pending.previous);
				setRecognitionId(pending.previous);
				return;
			}
		}
		if (value.text) invalidateDialogueViews(cache, client.identity, "main");
		const active = machine.get().session;
		const valid = () =>
			!!active && isCurrent(machine.get(), active.token, value.utteranceId);
		const canPlay = () => valid();
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
			const chunkQueue = playback;
			const queued = () => machine.get().player?.epoch === chunkQueue.epoch;
			for (const chunk of value.audioChunks) {
				const key = `${value.utteranceId}:${chunk.index}`;
				if (machine.get().delivered.has(key)) continue;
				machine.dispatch({ type: "delivered_marked", key });
				chunkQueue.tail = chunkQueue.tail
					.then(async () => {
						if (!canPlay() || !queued()) return;
						const bytes = await client.voiceAudio(
							value.utteranceId,
							chunk.index,
						);
						if (!canPlay() || !queued()) return;
						await new Promise<void>((resolve, reject) => {
							chunkQueue.finish = resolve;
							const ended = () => {
								chunkQueue.finish = undefined;
								setSubtitle((s) => (s?.key === key ? null : s));
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
								if (!valid() || !queued()) {
									resolve();
									return;
								}
								void client
									.voicePlayed(value.utteranceId, chunk.index)
									.then(() =>
										cache.invalidateQueries({
											queryKey: [
												queryRoots.voiceDialogue,
												client.identity,
												value.utteranceId,
											],
										}),
									)
									.then(() => resolve(), reject);
							};
							void controller.current
								?.play(bytes, ended, {
									waitForPrevious: true,
									volume: options.current?.outputVolume,
									shouldPlay: () => canPlay() && queued(),
									onStarted: () => {
										if (!canPlay() || !queued()) return;
										if ((options.current?.outputVolume ?? 1) > 0)
											setAvatarCue({
												key,
												motion: chunk.delivery?.motion ?? "neutral",
												speaking: true,
											});
									},
								})
								.then(() => {
									if (!valid() || !queued()) resolve();
									else if (chunk.text.trim())
										setSubtitle({ key, text: chunk.text.trim() });
								}, reject);
						});
					})
					.catch((e) => {
						if (valid()) {
							setError(describeError(e));
							controller.current?.stopPlayback();
							cancelPlayback();
							machine.dispatch({ type: "turn_released" });
							void client.voiceCancel(value.utteranceId).catch(() => {});
						}
					});
			}
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
					if (!isCurrent(machine.get(), active.token) || !canPlay()) return;
					return controller.current?.play(
						bytes,
						() => {
							void client
								.voicePlayed(value.utteranceId)
								.then(() =>
									cache.invalidateQueries({
										queryKey: [
											queryRoots.voiceDialogue,
											client.identity,
											turnId,
										],
									}),
								)
								.catch((e) => setError(describeError(e)));
						},
						{
							waitForPrevious: options.current?.bargeIn === false,
							volume: options.current?.outputVolume,
							shouldPlay: () =>
								isCurrent(machine.get(), active.token) && canPlay(),
						},
					);
				})
				.catch((e) => setError(describeError(e)));
		}
	}, [turn.data, client, cache, turnId, machine, cancelPlayback]);
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
				setActive(true);
				setError(null);
				try {
					await controller.current.start();
				} catch (error) {
					inputEnabled.current = false;
					setActive(false);
					setError(describeError(error));
				}
			}
			return;
		}
		inputEnabled.current = true;
		replacement.current = null;
		setError(null);
		setRecognitionId(null);
		setPreviewText(null);
		setTurnId(null);
		const startToken = ++tokens.current;
		machine.dispatch({ type: "start_requested", token: startToken });
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
					setRecognitionId(nextCandidate.id);
					setPreviewText(null);
					// Energy alone cannot distinguish speech from noise. Keep the answer
					// until the replacement has a nonempty accepted transcript.
				},
				(wav) => {
					const active = machine.get().session;
					if (!inputLive() || !active || active.failed) return;
					const pauseAfterUpload = active.pending >= 2;
					const old = machine.get().current;
					const pending = candidate.current;
					if (pending) {
						pending.finalized = true;
						pending.controller?.abort();
						pending.latest = undefined;
					}
					candidate.current = null;
					setPreviewText(null);
					const id = pending?.id ?? crypto.randomUUID();
					setRecognitionId(id);
					// Also becomes the current turn and drops the previous turn's delivered chunks.
					const sequence = machine.dispatch({
						type: "segment_accepted",
						utteranceId: id,
						preserveCurrent: true,
					}).session!.sequence;
					const uploads = upload.current;
					if (!uploads) return;
					uploads.tail = uploads.tail
						.then(async () => {
							if (!live() || machine.get().session?.failed) return;
							try {
								await client.voiceSend(
									active.id,
									active.generation,
									sequence,
									id,
									wav,
								);
							} catch (error) {
								if (!(error instanceof TypeError) || !live()) throw error;
								await new Promise((resolve) => setTimeout(resolve, 250));
								if (!live()) return;
								await client.voiceSend(
									active.id,
									active.generation,
									sequence,
									id,
									wav,
								);
							}
							if (!live()) return;
							replacement.current = { id, previous: old };
							setTurnId(id);
							await cache.invalidateQueries({
								queryKey: [queryRoots.voiceDialogue, client.identity, id],
							});
						})
						.catch((e) => {
							if (!live()) return;
							setError(describeError(e));
							// The failed upload also drops any unsent segments behind it.
							candidate.current?.controller?.abort();
							candidate.current = null;
							setPreviewText(null);
							machine.dispatch({
								type: "upload_failed",
								sessionToken,
								previous: old,
							});
							suspendInput();
							setRecognitionId(old);
							cancelPlayback();
							if (old)
								void cache.invalidateQueries({
									queryKey: [queryRoots.voiceDialogue, client.identity, old],
								});
						})
						.finally(() => {
							machine.dispatch({ type: "upload_settled", sessionToken });
						});
					if (pauseAfterUpload) {
						// Retain this final segment, then prevent more recording from piling up.
						suspendInput();
						setError(
							"録音を送信待ちに追加しました。送信が進んだらマイクを再開してください。",
						);
					}
				},
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
								"録音が60秒に達したため送信し、マイクを停止しました。続きはマイクを再開して話してください。",
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
		store.setState({ phase: "idle", level: 0 });
		await audio?.stop();
		if (active)
			await client.voiceStop(active.id, active.generation).catch((e) => {
				if (machine.get().phase === "idle") setError(describeError(e));
			});
	}
	function pause() {
		const audio = controller.current;
		if (!audio?.pauseInput) return stop();
		// The controller flushes a final spoken segment before detaching the mic.
		audio.pauseInput();
		inputEnabled.current = false;
		setActive(false);
		candidate.current?.controller?.abort();
		candidate.current = null;
		setPreviewText(null);
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
	const autoSpeak = settings?.autoSpeak;
	useEffect(() => {
		// Muting takes effect now: drop what is playing and release the turn.
		if (autoSpeak !== false) return;
		controller.current?.stopPlayback();
		// oxlint-disable-next-line react/set-state-in-effect
		cancelPlayback();
		const id = machine.get().current;
		if (!id) return;
		machine.dispatch({ type: "turn_released" });
		void client.voiceCancel(id).catch(() => {});
	}, [autoSpeak, client, machine, cancelPlayback]);
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
	const transcriptionText =
		previewText ||
		(turn.data?.utteranceId === recognitionId ? turn.data.text : null);
	return {
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
		transcription:
			recognitionId && transcriptionText
				? { id: recognitionId, text: transcriptionText }
				: null,
		error:
			error ??
			(turn.isError
				? "音声処理の結果を取得できません。接続を再確認してください。"
				: null),
		active,
		avatarCue,
	};
}
