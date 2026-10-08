import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	type AudioController,
	type AudioStore,
	createAudioController,
} from "../../audio";
import { invalidateDialogueViews } from "../../dialogue";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import type { AvatarCue } from "../../avatar";
export function useVoiceDialogue(
	client: VoiceDialogueClient,
	store: AudioStore,
	createAudio: typeof createAudioController = createAudioController,
	settings?: Settings["voice"],
) {
	const cache = useQueryClient();
	const options = useRef(settings);
	options.current = settings;
	const controller = useRef<AudioController | null>(null);
	const session = useRef<{
		id: string;
		generation: number;
		sequence: number;
		pending: number;
		failed: boolean;
		tail: Promise<void>;
	} | null>(null);
	const current = useRef<string | null>(null);
	const pendingStart = useRef<{ cancelled: boolean } | null>(null);
	const delivered = useRef(new Set<string>());
	const player = useRef<{
		id: string;
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
	function cancelPlayback() {
		player.current?.finish?.();
		player.current = null;
		setSubtitle(null);
		setAvatarCue(null);
	}
	function partial(wav: Uint8Array) {
		const active = session.current,
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
					session.current === active &&
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
		queryKey: ["voice-dialogue", client.identity, turnId],
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
		const active = session.current;
		const valid = () =>
			session.current === active &&
			!!active &&
			current.current === value.utteranceId;
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
			let playback = player.current;
			if (playback?.id !== value.utteranceId) {
				playback = { id: value.utteranceId, tail: Promise.resolve() };
				player.current = playback;
			}
			const queue = playback;
			for (const chunk of value.audioChunks) {
				const key = `${value.utteranceId}:${chunk.index}`;
				if (delivered.current.has(key)) continue;
				delivered.current.add(key);
				queue.tail = queue.tail
					.then(async () => {
						if (!canPlay() || player.current !== queue) return;
						const bytes = await client.voiceAudio(
							value.utteranceId,
							chunk.index,
						);
						if (!canPlay() || player.current !== queue) return;
						await new Promise<void>((resolve, reject) => {
							queue.finish = resolve;
							const ended = () => {
								queue.finish = undefined;
								setSubtitle((s) => (s?.key === key ? null : s));
								setAvatarCue((cue) => (cue?.key === key ? null : cue));
								if (!valid() || player.current !== queue) {
									resolve();
									return;
								}
								void client
									.voicePlayed(value.utteranceId, chunk.index)
									.then(() =>
										cache.invalidateQueries({
											queryKey: [
												"voice-dialogue",
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
									shouldPlay: () => canPlay() && player.current === queue,
									onStarted: () => {
										if (!canPlay() || player.current !== queue) return;
										if ((options.current?.outputVolume ?? 1) > 0)
											setAvatarCue({
												key,
												motion: chunk.delivery?.motion ?? "neutral",
												speaking: true,
											});
									},
								})
								.then(() => {
									if (!valid() || player.current !== queue) resolve();
									else if (chunk.text.trim())
										setSubtitle({ key, text: chunk.text.trim() });
								}, reject);
						});
					})
					.catch((e) => {
						if (valid()) {
							setError(String(e));
							controller.current?.stopPlayback();
							cancelPlayback();
							current.current = null;
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
			current.current === value.utteranceId &&
			!delivered.current.has(value.utteranceId)
		) {
			delivered.current.add(value.utteranceId);
			void client
				.voiceAudio(value.utteranceId)
				.then((bytes) => {
					if (session.current !== active || !canPlay()) return;
					return controller.current?.play(
						bytes,
						() => {
							void client
								.voicePlayed(value.utteranceId)
								.then(() =>
									cache.invalidateQueries({
										queryKey: ["voice-dialogue", client.identity, turnId],
									}),
								)
								.catch((e) => setError(String(e)));
						},
						{
							waitForPrevious: options.current?.bargeIn === false,
							volume: options.current?.outputVolume,
							shouldPlay: () => session.current === active && canPlay(),
						},
					);
				})
				.catch((e) => setError(String(e)));
		}
	}, [turn.data, client, cache, turnId]);
	async function start() {
		if (session.current || pendingStart.current) return;
		setError(null);
		setRecognitionId(null);
		setPreviewText(null);
		setTurnId(null);
		const pending = { cancelled: false };
		pendingStart.current = pending;
		setActive(true);
		const next = {
			id: crypto.randomUUID(),
			generation: 1,
			sequence: 0,
			pending: 0,
			failed: false,
			tail: Promise.resolve(),
		};
		try {
			await client.voiceStart(next.id, next.generation);
			if (pending.cancelled) {
				await client.voiceStop(next.id, next.generation);
				return;
			}
			session.current = next;
			const audio = createAudio(
				(state) => {
					if (session.current === next) store.setState(state);
				},
				() => {
					if (session.current !== next || next.failed) return;
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
						const old = current.current;
						current.current = null;
						if (old)
							void next.tail
								.then(() => client.voiceCancel(old))
								.catch(() => {});
					}
				},
				(wav) => {
					const active = session.current;
					if (active !== next || active.failed) return;
					if (active.pending >= 2) {
						setError("音声の送信待ちが上限に達しました");
						return;
					}
					const old = current.current;
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
					const sequence = ++active.sequence;
					active.pending++;
					current.current = id;

					delivered.current.clear();
					active.tail = active.tail
						.then(async () => {
							if (session.current !== active || active.failed) return;
							try {
								await client.voiceSend(
									active.id,
									active.generation,
									sequence,
									id,
									wav,
								);
							} catch (error) {
								if (!(error instanceof TypeError) || session.current !== active)
									throw error;
								await new Promise((resolve) => setTimeout(resolve, 250));
								if (session.current !== active) return;
								await client.voiceSend(
									active.id,
									active.generation,
									sequence,
									id,
									wav,
								);
							}
							if (session.current !== active) return;
							// Keep the previous answer until the replacement has been accepted.
							if (old && old !== id)
								await client.voiceCancel(old).catch(() => {});
							if (session.current !== active) return;
							setTurnId(id);
							await cache.invalidateQueries({
								queryKey: ["voice-dialogue", client.identity, id],
							});
						})
						.catch((e) => {
							if (session.current !== active) return;
							active.failed = true;
							setError(String(e));
							// The failed upload also drops any unsent segments behind it.
							candidate.current?.controller?.abort();
							candidate.current = null;
							setPreviewText(null);
							current.current = old;
							setRecognitionId(old);
							cancelPlayback();
							if (old)
								void cache.invalidateQueries({
									queryKey: ["voice-dialogue", client.identity, old],
								});
						})
						.finally(() => {
							active.pending--;
						});
				},
				{
					...options.current,
					onPartial: (wav) => {
						if (session.current === next) partial(wav);
					},
					// Without barge-in nothing may interrupt a reply, so it must not be heard either.
					halfDuplex: () => options.current?.bargeIn === false,
				},
			);
			controller.current = audio;
			try {
				await audio.start();
			} catch (error) {
				if (pending.cancelled) return;
				await stop();
				setError(
					error instanceof Error ? error.message : "マイクを開始できません",
				);
			}
		} catch (error) {
			const report = !pending.cancelled;
			if (session.current === next) await stop();
			if (report)
				setError(
					error instanceof Error ? error.message : "音声を開始できません",
				);
		} finally {
			if (pendingStart.current === pending) {
				pendingStart.current = null;
				setActive(!!session.current);
			}
		}
	}
	async function stop() {
		if (pendingStart.current) {
			pendingStart.current.cancelled = true;
			pendingStart.current = null;
		}
		setActive(false);
		setRecognitionId(null);
		candidate.current?.controller?.abort();
		candidate.current = null;
		setPreviewText(null);
		cancelPlayback();
		const active = session.current;
		session.current = null;
		current.current = null;
		const audio = controller.current;
		controller.current = null;
		setTurnId(null);
		store.setState({ phase: "idle", level: 0 });
		await audio?.stop();
		if (active)
			await client.voiceStop(active.id, active.generation).catch((e) => {
				if (!session.current && !pendingStart.current) setError(String(e));
			});
	}
	const autoSpeak = settings?.autoSpeak;
	useEffect(() => {
		// Muting takes effect now: drop what is playing and release the turn.
		if (autoSpeak !== false) return;
		controller.current?.stopPlayback();
		// oxlint-disable-next-line react/set-state-in-effect
		cancelPlayback();
		const id = current.current;
		if (!id) return;
		current.current = null;
		void client.voiceCancel(id).catch(() => {});
	}, [autoSpeak, client]);
	useEffect(
		() => () => {
			if (pendingStart.current) pendingStart.current.cancelled = true;
			void controller.current?.stop();
			candidate.current?.controller?.abort();
			cancelPlayback();
			const active = session.current;
			if (active)
				void client.voiceStop(active.id, active.generation).catch(() => {});
			session.current = null;
		},
		[client],
	);
	const transcriptionText =
		previewText ||
		(turn.data?.utteranceId === recognitionId ? turn.data.text : null);
	return {
		start,
		stop,
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
