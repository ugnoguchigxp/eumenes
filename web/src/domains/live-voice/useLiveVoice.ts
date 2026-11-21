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
import { createLiveAudioUpload } from "./audio-upload";

type LiveRuntime = {
	id: string;
	ready: boolean;
	stopping: boolean;
	controller: AbortController;
	audio: Awaited<ReturnType<typeof createLivePcm>>;
	upload: ReturnType<typeof createLiveAudioUpload>;
	output: number;
};

function stopMedia(runtime: LiveRuntime) {
	if (runtime.stopping) return;
	runtime.stopping = true;
	runtime.ready = false;
	runtime.upload.stop();
	runtime.audio.close();
}

function keepTerminalState(
	previous: LiveSnapshot | null | undefined,
	next: LiveSnapshot | null,
) {
	if (
		previous &&
		next?.id === previous.id &&
		!activeStatuses.includes(previous.status) &&
		activeStatuses.includes(next.status)
	)
		return previous;
	return next;
}

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
		queryFn: async () => {
			const latest = await client.liveCurrent("main");
			return keepTerminalState(
				cache.getQueryData<LiveSnapshot | null>(queryKey),
				latest,
			);
		},
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
			cache.setQueryData<LiveSnapshot | null>(
				["live-voice", client.identity, "main"],
				(previous) => keepTerminalState(previous, value),
			),
		[cache, client.identity],
	);
	const [error, setError] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	const [busy, setBusy] = useState(false);
	const runtime = useRef<LiveRuntime | null>(null);
	const stopRef = useRef<() => Promise<void>>(async () => {});
	useEffect(
		() => () => {
			const old = runtime.current;
			runtime.current = null;
			if (old) {
				stopMedia(old);
				old.controller.abort();
				void client
					.liveStop(old.id)
					.then((value) => {
						if (value) setSession(value);
					})
					.catch(() => {});
			}
		},
		[client, setSession],
	);
	const stop = useCallback(async () => {
		const old = runtime.current;
		const id = old?.id ?? session?.id;
		if (!id || old?.stopping || session?.status === "closing") return;
		if (old) stopMedia(old);
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
						if (runtime.current?.stopping) return;
						setError("マイクの接続が切れました。");
						void stopRef.current();
					},
					onInput: (chunk) => {
						const rt = runtime.current;
						if (rt?.ready) rt.upload.push(chunk);
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
				const rt: LiveRuntime = {
					id: created.id,
					ready: false,
					stopping: false,
					audio,
					controller: new AbortController(),
					upload: createLiveAudioUpload(
						(sequence, chunk, signal) =>
							client.liveAudio(created.id, sequence, chunk, signal),
						(reason) => {
							if (runtime.current !== rt || rt.stopping) return;
							setError(
								reason === "backpressure"
									? "音声の送信が追いつかないため停止します。"
									: "音声の接続が切れました。",
							);
							void stopRef.current();
						},
					),
					output: 0,
				};
				runtime.current = rt;
				void readSse((signal) => client.liveStream(rt.id, signal), {
					signal: rt.controller.signal,
					idleMs: 45000,
					maxFrame: 1_000_000,
					connectMs: 10000,
					onEvent: (event) => {
						if (runtime.current !== rt) return true;
						if (!event.data) return;
						const value = parseLiveEvent(JSON.parse(event.data));
						if (value.type === "audio") {
							if (rt.stopping || value.sequence <= rt.output) return;
							rt.output = value.sequence;
							rt.audio.play(value.audio);
							return;
						}
						setSession(value.state);
						if (value.state.error) setError(describeError(value.state.error));
						if (!activeStatuses.includes(value.state.status)) {
							stopMedia(rt);
							runtime.current = null;
							return true;
						}
						if (value.state.status === "closing") {
							stopMedia(rt);
						} else if (!rt.stopping) {
							rt.ready = value.state.status === "active";
							rt.audio.mute(value.state.muted || !rt.ready);
						}
					},
				})
					.catch(() => {})
					.finally(() => {
						if (runtime.current !== rt) return;
						const disconnected = !rt.stopping && !rt.controller.signal.aborted;
						stopMedia(rt);
						runtime.current = null;
						if (!disconnected) return;
						setError("音声会話の接続が切れました。");
						void client
							.liveStop(rt.id)
							.then((v) => {
								if (v) setSession(v);
							})
							.catch(() => {});
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
