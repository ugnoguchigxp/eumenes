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
		if (value.text) invalidateDialogueViews(cache, client.identity, "main");
		if (value.status === "failed")
			// Keep the failure visible after the query changes, until a new session starts.
			// oxlint-disable-next-line react/set-state-in-effect
			setError(value.error ?? "音声処理に失敗しました");
		const active = machine.get().session;
		const valid = () =>
			!!active && isCurrent(machine.get(), active.token, value.utteranceId);
		const canPlay = () =>
			valid() && !(candidate.current && options.current?.bargeIn !== false);
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
		if (machine.get().phase !== "idle") return;
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
					if (!live() || machine.get().session?.failed) return;
					candidate.current?.controller?.abort();
					const nextCandidate = {
						id: crypto.randomUUID(),
						finalized: false,
						busy: false,
					};
					candidate.current = nextCandidate;
					setRecognitionId(nextCandidate.id);
					setPreviewText(null);
					if (options.current?.bargeIn === false) return;
					const playing = store.getState().phase === "playing";
					controller.current?.stopPlayback();
					cancelPlayback();
					// An energy candidate can be noise. Stop audible output immediately,
					// but preserve recognition/generation until another segment is finalized.
					if (playing) {
						const old = machine.get().current;
						machine.dispatch({ type: "turn_released" });
						if (old)
							void upload.current?.tail
								.then(() => client.voiceCancel(old))
								.catch(() => {});
					}
				},
				(wav) => {
					const active = machine.get().session;
					if (!live() || !active || active.failed) return;
					if (active.pending >= 2) {
						setError("音声の送信待ちが上限に達しました");
						return;
					}
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
							// Keep the previous answer until the replacement has been accepted.
							if (old && old !== id)
								await client.voiceCancel(old).catch(() => {});
							if (!live()) return;
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
				},
				{
					...options.current,
					onPartial: (wav) => {
						if (live()) partial(wav);
					},
					// Without barge-in nothing may interrupt a reply, so it must not be heard either.
					halfDuplex: () => options.current?.bargeIn === false,
					onLost: (reason) => {
						if (!live()) return;
						void stop().then(() => setError(describeError(reason)));
					},
					onNotice: (reason) => {
						if (live()) setError(describeError(reason));
					},
				},
			);
			controller.current = audio;
			try {
				await audio.start();
			} catch (error) {
				if (cancelled()) return;
				await stop();
				setError(
					error instanceof Error ? error.message : "マイクを開始できません",
				);
			}
		} catch (error) {
			const report = !cancelled();
			if (live()) await stop();
			if (report)
				setError(
					error instanceof Error ? error.message : "音声を開始できません",
				);
		} finally {
			if (machine.get().startToken === startToken) {
				setActive(
					!!machine.dispatch({ type: "start_settled", token: startToken })
						.session,
				);
			}
		}
	}
	async function stop() {
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
