import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { readSse } from "../../../../client/sse";
import { parseLiveEvent } from "../../../../client/live-voice";
import {
	activeStatuses,
	type LiveSnapshot,
} from "../../../../api/domains/live-voice/contracts";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { createLivePcm } from "../audio";
import { describeError } from "../../errorMessages";

export function useLiveVoice(
	client: EumenesClient,
	settings: Settings | undefined,
	beforeStart?: () => Promise<void>,
	enabled = true,
) {
	const cache = useQueryClient();
	const queryKey = ["live-voice", client.identity, "main"];
	const current = useQuery({
		queryKey,
		queryFn: () => client.liveCurrent("main"),
		enabled,
		retry: false,
		staleTime: Infinity,
		// Terminal state must still arrive after an SSE disconnect or the owning settings panel closes.
		refetchInterval: (query) =>
			query.state.data && activeStatuses.includes(query.state.data.status)
				? 3000
				: false,
	});
	const session = current.data ?? null;
	const setSession = useCallback(
		(value: LiveSnapshot | null) =>
			cache.setQueryData(["live-voice", client.identity, "main"], value),
		[cache, client.identity],
	);
	const [error, setError] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	const [busy, setBusy] = useState(false);
	const runtime = useRef<{
		id: string;
		ready: boolean;
		controller: AbortController;
		audio: Awaited<ReturnType<typeof createLivePcm>>;
		tail: Promise<void>;
		pending: number;
		sequence: number;
		output: number;
	} | null>(null);
	const stopRef = useRef<() => Promise<void>>(async () => {});
	useEffect(
		() => () => {
			const old = runtime.current;
			runtime.current = null;
			old?.audio.close();
			old?.controller.abort();
			if (old)
				void client
					.liveStop(old.id)
					.then((value) => {
						if (value) setSession(value);
					})
					.catch(() => {});
		},
		[client, setSession],
	);
	const stop = useCallback(async () => {
		const old = runtime.current;
		const id = old?.id ?? session?.id;
		if (old) {
			old.ready = false;
			old.audio.close();
		}
		if (!id) return;
		setBusy(true);
		try {
			const value = await client.liveStop(id);
			if (value) setSession(value);
			if (!old || !value || !activeStatuses.includes(value.status)) {
				old?.controller.abort();
				runtime.current = null;
			}
		} catch (e) {
			setError(describeError(e));
			old?.controller.abort();
			runtime.current = null;
		} finally {
			setBusy(false);
		}
	}, [client, session, setSession]);
	useEffect(() => {
		stopRef.current = stop;
	}, [stop]);
	const start = useCallback(
		async (test = false) => {
			if (busy || runtime.current) return;
			if (
				!settings?.live.enabled ||
				!settings.live.connectionId ||
				!settings.live.model
			) {
				setError("音声会話の接続とモデルを設定してください。");
				return;
			}
			setBusy(true);
			setError(null);
			let audio: Awaited<ReturnType<typeof createLivePcm>> | undefined;
			let id: string | undefined;
			try {
				await cache.cancelQueries({
					queryKey: ["live-voice", client.identity, "main"],
				});
				await beforeStart?.();
				audio = await createLivePcm({
					...settings.voice,
					volume: settings.voice.outputVolume,
					muted: !settings.live.startWithMicrophone,
					onPlaying: setPlaying,
					onError: () => {
						setError("マイクの接続が切れました。");
						void stopRef.current();
					},
					onInput: (chunk) => {
						const rt = runtime.current;
						if (!rt || !rt.ready || rt.controller.signal.aborted) return;
						if (++rt.pending > 25) {
							setError("音声の送信が追いつかないため停止します。");
							void stopRef.current();
							return;
						}
						const sequence = ++rt.sequence;
						rt.tail = rt.tail
							.then(() =>
								client.liveAudio(rt.id, sequence, chunk, rt.controller.signal),
							)
							.catch(() => {
								if (!rt.controller.signal.aborted) {
									setError("音声の接続が切れました。");
									void stopRef.current();
								}
							})
							.finally(() => {
								rt.pending--;
							});
					},
				});
				const created = await client.liveStart(
					crypto.randomUUID(),
					"main",
					test,
				);
				id = created.id;
				setSession(created);
				if (!activeStatuses.includes(created.status))
					throw new Error(created.error ?? "live_connect_failed");
				const rt = {
					id: created.id,
					ready: false,
					audio,
					controller: new AbortController(),
					tail: Promise.resolve(),
					pending: 0,
					sequence: 0,
					output: 0,
				};
				runtime.current = rt;
				void readSse((signal) => client.liveStream(rt.id, signal), {
					signal: rt.controller.signal,
					idleMs: 45000,
					maxFrame: 1_000_000,
					connectMs: 10000,
					onEvent: (event) => {
						if (!event.data) return;
						const value = parseLiveEvent(JSON.parse(event.data));
						if (value.type === "audio") {
							if (value.sequence <= rt.output) return;
							rt.output = value.sequence;
							rt.audio.play(value.audio);
							return;
						}
						setSession(value.state);
						rt.ready = value.state.status === "active";
						rt.audio.mute(value.state.muted || value.state.status !== "active");
						if (value.state.error) setError(describeError(value.state.error));
						if (!activeStatuses.includes(value.state.status)) {
							rt.audio.close();
							runtime.current = null;
							return true;
						}
					},
				})
					.catch(() => {
						if (!rt.controller.signal.aborted)
							setError("音声会話の接続が切れました。");
					})
					.finally(() => {
						rt.audio.close();
						if (runtime.current === rt) {
							runtime.current = null;
							void client
								.liveStop(rt.id)
								.then((v) => {
									if (v) setSession(v);
								})
								.catch(() => {});
						}
					});
			} catch (e) {
				audio?.close();
				if (id) void client.liveStop(id).catch(() => {});
				setError(describeError(e));
			} finally {
				setBusy(false);
			}
		},
		[client, settings, busy, beforeStart, setSession, cache],
	);
	const mute = useCallback(async () => {
		if (!session) return;
		const value = !session.muted;
		runtime.current?.audio.mute(true);
		try {
			await client.liveMute(session.id, value);
		} catch (e) {
			setError(describeError(e));
		}
	}, [client, session]);
	return {
		session,
		error,
		playing,
		busy,
		active: !!session && activeStatuses.includes(session.status),
		start,
		stop,
		mute,
		displayed: (notice: string) =>
			session ? client.liveDisplayed(session.id, notice) : Promise.resolve(),
	};
}
