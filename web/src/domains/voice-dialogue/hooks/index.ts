import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	type AudioController,
	type AudioStore,
	createAudioController,
} from "../../audio";
import { invalidateDialogueViews } from "../../dialogue";
export function useVoiceDialogue(
	client: VoiceDialogueClient,
	store: AudioStore,
	createAudio: typeof createAudioController = createAudioController,
) {
	const cache = useQueryClient();
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
	const [turnId, setTurnId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const turn = useQuery({
		queryKey: ["voice-dialogue", client.identity, turnId],
		enabled: !!turnId,
		queryFn: () => {
			if (!turnId) throw new Error("turn_id_missing");
			return client.voiceTurn(turnId);
		},
		refetchInterval: (q) =>
			q.state.data &&
			["ready", "played", "failed", "cancelled", "interrupted"].includes(
				q.state.data.status,
			)
				? false
				: 500,
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
					if (
						session.current !== active ||
						current.current !== value.utteranceId
					)
						return;
					return controller.current?.play(bytes, () => {
						void client
							.voicePlayed(value.utteranceId)
							.then(() =>
								cache.invalidateQueries({
									queryKey: ["voice-dialogue", client.identity, turnId],
								}),
							)
							.catch((e) => setError(String(e)));
					});
				})
				.catch((e) => setError(String(e)));
		}
	}, [turn.data, client, cache, turnId]);
	async function start() {
		if (session.current || pendingStart.current) return;
		setError(null);
		const pending = { cancelled: false };
		pendingStart.current = pending;
		setStarting(true);
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
				(state) => store.setState(state),
				() => {
					controller.current?.stopPlayback();
					const old = current.current;
					current.current = null;
					if (old) void client.voiceCancel(old).catch(() => {});
				},
				(wav) => {
					const active = session.current;
					if (!active || active.failed) return;
					if (active.pending >= 2) {
						setError("音声の送信待ちが上限に達しました");
						return;
					}
					const id = crypto.randomUUID();
					const sequence = ++active.sequence;
					active.pending++;
					current.current = id;
					setTurnId(id);
					delivered.current.delete(id);
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
								await client.voiceSend(
									active.id,
									active.generation,
									sequence,
									id,
									wav,
								);
							}
							await cache.invalidateQueries({
								queryKey: ["voice-dialogue", client.identity, id],
							});
						})
						.catch((e) => {
							active.failed = true;
							setError(String(e));
						})
						.finally(() => {
							active.pending--;
						});
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
				setStarting(false);
			}
		}
	}
	async function stop() {
		if (pendingStart.current) {
			pendingStart.current.cancelled = true;
			pendingStart.current = null;
		}
		setStarting(false);
		const active = session.current;
		session.current = null;
		current.current = null;
		const audio = controller.current;
		controller.current = null;
		await audio?.stop();
		if (active)
			await client
				.voiceStop(active.id, active.generation)
				.catch((e) => setError(String(e)));
		setTurnId(null);
	}
	useEffect(
		() => () => {
			if (pendingStart.current) pendingStart.current.cancelled = true;
			void controller.current?.stop();
			const active = session.current;
			if (active)
				void client.voiceStop(active.id, active.generation).catch(() => {});
			session.current = null;
		},
		[client],
	);
	return {
		start,
		stop,
		turn: turn.data,
		error,
		active: !!session.current || starting,
	};
}
