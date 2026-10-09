import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	createAudioController,
	type CreateAudio,
	createAudioStore,
	type AudioController,
} from "../../audio";
import { useVoiceDialogue } from "..";

test("speech interruption prevents a fetched old answer from starting playback", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let speech = () => {};
	let segment = (_wav: Uint8Array) => {};
	const play = vi.fn(async () => {});
	const createAudio = (
		_onState: Parameters<typeof createAudioController>[0],
		onSpeech: () => void,
		onSegment: (wav: Uint8Array) => void,
	): AudioController => {
		speech = onSpeech;
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play,
		};
	};
	let sessionId = "";
	let utteranceId = "";
	let resolveAudio: ((wav: Uint8Array) => void) | undefined;
	const voiceAudio = vi.fn(
		() =>
			new Promise<Uint8Array>((resolve) => {
				resolveAudio = resolve;
			}),
	);
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart: async (id: string) => {
			sessionId = id;
			return { sessionId: id, generation: 1 };
		},
		voiceStop: async () => ({ stopped: true }),
		voiceSend: async (
			_session: string,
			_generation: number,
			_sequence: number,
			id: string,
		) => {
			utteranceId = id;
			return { utteranceId: id };
		},
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: "ready",
			text: "質問",
			runId: "run",
			error: null,
			revision: 3,
		}),
		voiceAudio,
		voicePlayed: async () => ({}),
		voiceCancel: async () => ({}),
	} as unknown as VoiceDialogueClient;
	const store = createAudioStore();
	const hook = renderHook(() => useVoiceDialogue(client, store, createAudio), {
		wrapper,
	});
	await act(async () => hook.result.current.start());
	act(() => segment(new Uint8Array(44)));
	await waitFor(() => expect(voiceAudio).toHaveBeenCalledWith(utteranceId));
	act(() => speech());
	await act(async () => {
		resolveAudio?.(new Uint8Array(44));
		await Promise.resolve();
	});
	expect(play).not.toHaveBeenCalled();
	hook.unmount();
	query.clear();
});

test("stopping during session creation prevents a late microphone start", async () => {
	const query = new QueryClient();
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let resolveStart: (() => void) | undefined;
	const voiceStart = vi.fn(
		() =>
			new Promise<{ sessionId: string; generation: number }>((resolve) => {
				resolveStart = () => resolve({ sessionId: "started", generation: 1 });
			}),
	);
	const voiceStop = vi.fn(async () => ({ stopped: true }));
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart,
		voiceStop,
	} as unknown as VoiceDialogueClient;
	const createAudio = vi.fn(() => ({
		start: async () => {},
		stop: async () => {},
		stopPlayback: () => {},
		play: async () => {},
	})) as unknown as CreateAudio;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	let startPromise: Promise<void> | undefined;
	act(() => {
		startPromise = hook.result.current.start();
		void hook.result.current.start();
	});
	expect(voiceStart).toHaveBeenCalledTimes(1);
	await act(async () => hook.result.current.stop());
	await act(async () => {
		resolveStart?.();
		await startPromise;
	});
	expect(voiceStop).toHaveBeenCalledTimes(1);
	expect(createAudio).not.toHaveBeenCalled();
	expect(hook.result.current.active).toBe(false);
	hook.unmount();
	query.clear();
});

test("failure to read an accepted voice turn is shown instead of leaving silent waiting", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let segment = (_bytes: Uint8Array) => {};
	const createAudio = (
		_state: Parameters<typeof createAudioController>[0],
		_speech: () => void,
		onSegment: (bytes: Uint8Array) => void,
	): AudioController => {
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play: async () => {},
		};
	};
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart: async (id: string) => ({ sessionId: id, generation: 1 }),
		voiceStop: async () => ({ stopped: true }),
		voiceSend: async () => ({}),
		voiceTurn: async () => {
			throw new Error("unavailable");
		},
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	try {
		await act(async () => hook.result.current.start());
		act(() => segment(new Uint8Array(44)));
		await waitFor(() =>
			expect(hook.result.current.error).toBe(
				"音声処理の結果を取得できません。接続を再確認してください。",
			),
		);
	} finally {
		hook.unmount();
		query.clear();
	}
});

test("chunk playback stays ordered and interruption releases the old queue for a new utterance", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let speech = () => {},
		segment = (_wav: Uint8Array) => {},
		sessionId = "";
	const endings: Array<() => void> = [];
	const starts: Array<() => void> = [];
	const play = vi.fn(
		async (
			_bytes: Uint8Array,
			onEnded: () => void,
			options?: Parameters<AudioController["play"]>[2],
		) => {
			endings.push(onEnded);
			starts.push(options?.onStarted ?? (() => {}));
		},
	);
	const createAudio: CreateAudio = (_state, onSpeech, onSegment) => {
		speech = onSpeech;
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play,
		};
	};
	const voiceAudio = vi.fn(
		async (_id: string, _index?: number) => new Uint8Array(44),
	);
	const voicePlayed = vi.fn(async (_id: string, _index?: number) => ({})),
		voiceCancel = vi.fn(async (_id: string) => ({}));
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart: async (id: string) => {
			sessionId = id;
			return {};
		},
		voiceStop: async () => ({}),
		voiceSend: async () => ({}),
		voiceAudio,
		voicePlayed,
		voiceCancel,
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: "ready",
			text: "質問",
			runId: "run",
			error: null,
			revision: 3,
			audioChunks: [
				{ index: 0, text: "先。", delivery: { motion: "greeting" } },
				{ index: 1, text: "続き。" },
			],
			audioComplete: true,
		}),
	} as unknown as VoiceDialogueClient;
	const store = createAudioStore();
	const hook = renderHook(() => useVoiceDialogue(client, store, createAudio), {
		wrapper,
	});
	await act(async () => hook.result.current.start());
	act(() => segment(new Uint8Array(44)));
	await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
	expect(voiceAudio).toHaveBeenCalledTimes(1);
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => starts[0]?.());
	expect(hook.result.current.avatarCue?.motion).toBe("greeting");
	expect(hook.result.current.avatarCue?.speaking).toBe(true);
	const oldId = voiceAudio.mock.calls[0]?.[0];
	act(() => {
		speech();
		segment(new Uint8Array(44));
	});
	await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => starts[0]?.());
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => starts[1]?.());
	const newCue = hook.result.current.avatarCue;
	expect(newCue?.motion).toBe("greeting");
	act(() => endings[0]?.());
	expect(hook.result.current.avatarCue).toEqual(newCue);
	expect(voiceCancel).toHaveBeenCalledWith(oldId);
	await act(async () => {
		endings[0]?.();
		endings[1]?.();
	});
	await waitFor(() => expect(play).toHaveBeenCalledTimes(3));
	act(() => starts[2]?.());
	expect(hook.result.current.avatarCue).toMatchObject({
		motion: "neutral",
		speaking: true,
	});
	await act(async () => endings[2]?.());
	expect(hook.result.current.avatarCue).toBeNull();
	expect(voicePlayed).not.toHaveBeenCalledWith(oldId, expect.anything());
	expect(voiceAudio.mock.calls.map((call) => call[1])).toEqual([0, 0, 1]);
	hook.unmount();
	query.clear();
});

test("an unfinalized speech candidate neither cancels nor hides an accepted recognition", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let speech = () => {},
		segment = (_wav: Uint8Array) => {},
		sessionId = "";
	let acceptFirst = () => {};
	const order: string[] = [];
	const createAudio: CreateAudio = (state, onSpeech, onSegment) => {
		speech = onSpeech;
		segment = onSegment;
		return {
			start: async () => state({ phase: "listening", level: 0 }),
			stop: async () => {},
			stopPlayback: () => {},
			play: async () => {},
		};
	};
	const voiceSend = vi.fn(
		async (
			_session: string,
			_generation: number,
			sequence: number,
			id: string,
		) => {
			if (sequence === 1)
				await new Promise<void>((resolve) => {
					acceptFirst = resolve;
				});
			order.push(`accepted:${id}`);
			return {};
		},
	);
	const voiceCancel = vi.fn(async (id: string) => {
		order.push(`cancelled:${id}`);
		return {};
	});
	const voiceTurn = vi.fn(async (id: string) => ({
		utteranceId: id,
		sessionId,
		generation: 1,
		sequence: 1,
		status: "responding",
		text: "認識できています。",
		runId: "run",
		error: null,
		revision: 2,
		audioChunks: [],
		audioComplete: false,
	}));
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceSend,
		voiceCancel,
		voiceTurn,
		voiceStart: async (id: string) => {
			sessionId = id;
			return {};
		},
		voiceStop: async () => ({}),
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	try {
		await act(async () => hook.result.current.start());
		act(() => {
			speech();
			segment(new Uint8Array(44));
		});
		await waitFor(() => expect(voiceSend).toHaveBeenCalledTimes(1));
		const firstId = voiceSend.mock.calls[0]![3];
		act(() => speech());
		expect(voiceCancel).not.toHaveBeenCalled();
		await act(async () => acceptFirst());
		await waitFor(() =>
			expect(hook.result.current.turn?.text).toBe("認識できています。"),
		);
		expect(voiceTurn).toHaveBeenCalledWith(firstId);
		expect(hook.result.current.transcription).toBeNull(); // result belongs to the previous utterance
		act(() => segment(new Uint8Array(44)));
		await waitFor(() => expect(voiceSend).toHaveBeenCalledTimes(2));
		expect(voiceCancel).toHaveBeenCalledWith(firstId);
		await waitFor(() =>
			expect(hook.result.current.transcription?.text).toBe(
				"認識できています。",
			),
		);
		expect(hook.result.current.transcription?.id).toBe(
			voiceSend.mock.calls[1]![3],
		);
		await act(async () => hook.result.current.stop());
		expect(hook.result.current.transcription).toBeNull();
		expect(order).toEqual([
			`accepted:${firstId}`,
			`accepted:${voiceSend.mock.calls[1]![3]}`,
			`cancelled:${firstId}`,
		]);
	} finally {
		hook.unmount();
		query.clear();
	}
});

test("muting stops playback at once and releases the running turn", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let segment = (_wav: Uint8Array) => {},
		sessionId = "";
	const stopPlayback = vi.fn();
	const play = vi.fn(async () => {});
	const createAudio: CreateAudio = (_state, _onSpeech, onSegment) => {
		segment = onSegment;
		return { start: async () => {}, stop: async () => {}, stopPlayback, play };
	};
	const voiceCancel = vi.fn(async (_id: string) => ({}));
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart: async (id: string) => {
			sessionId = id;
			return {};
		},
		voiceStop: async () => ({}),
		voiceSend: async () => ({}),
		voiceAudio: async () => new Uint8Array(44),
		voicePlayed: async () => ({}),
		voiceCancel,
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: "ready",
			text: "質問",
			runId: "run",
			error: null,
			revision: 3,
			audioChunks: [{ index: 0, text: "先。" }],
			audioComplete: true,
		}),
	} as unknown as VoiceDialogueClient;
	const store = createAudioStore();
	const voice = (autoSpeak: boolean) =>
		({ autoSpeak, outputVolume: 1, bargeIn: true }) as never;
	const hook = renderHook(
		({ autoSpeak }) =>
			useVoiceDialogue(client, store, createAudio, voice(autoSpeak)),
		{ wrapper, initialProps: { autoSpeak: true } },
	);
	await act(async () => hook.result.current.start());
	act(() => segment(new Uint8Array(44)));
	await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
	stopPlayback.mockClear();
	hook.rerender({ autoSpeak: false });
	expect(stopPlayback).toHaveBeenCalled();
	expect(voiceCancel).toHaveBeenCalledTimes(1);
	hook.unmount();
	query.clear();
});

test("callbacks and upload failures from a stopped microphone cannot affect a new session", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	const microphones: Array<{
		speech: () => void;
		segment: (wav: Uint8Array) => void;
		partial?: (wav: Uint8Array) => void;
	}> = [];
	const createAudio: CreateAudio = (_state, speech, segment, options) => {
		microphones.push({ speech, segment, partial: options?.onPartial });
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play: async () => {},
		};
	};
	let rejectOld = (_error: Error) => {};
	const voiceSend = vi.fn(
		() =>
			new Promise<void>((_resolve, reject) => {
				rejectOld = reject;
			}),
	);
	const voicePreview = vi.fn(async () => ({ text: "古い入力" }));
	const client = {
		identity: "stale-microphone",
		voiceStart: async () => ({}),
		voiceStop: async () => ({}),
		voiceSend,
		voicePreview,
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	try {
		await act(async () => hook.result.current.start());
		act(() => {
			microphones[0]!.speech();
			microphones[0]!.segment(new Uint8Array(44));
		});
		await waitFor(() => expect(voiceSend).toHaveBeenCalledTimes(1));
		await act(async () => hook.result.current.stop());
		await act(async () => hook.result.current.start());
		await act(async () => {
			microphones[0]!.speech();
			microphones[0]!.partial?.(new Uint8Array(44));
			microphones[0]!.segment(new Uint8Array(44));
			rejectOld(new Error("old_upload_failed"));
		});
		expect(hook.result.current.recognitionId).toBeNull();
		expect(hook.result.current.error).toBeNull();
		expect(hook.result.current.active).toBe(true);
		expect(voicePreview).not.toHaveBeenCalled();
		expect(voiceSend).toHaveBeenCalledTimes(1);
	} finally {
		hook.unmount();
		query.clear();
	}
});

test("a rejected next upload does not cancel the previous accepted answer", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let segment = (_wav: Uint8Array) => {};
	let sessionId = "";
	let ready = false;
	const play = vi.fn(async () => {});
	const createAudio: CreateAudio = (_state, _speech, onSegment) => {
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play,
		};
	};
	const voiceCancel = vi.fn(async () => ({}));
	const client = {
		identity: "rejected-next-upload",
		voiceStart: async (id: string) => {
			sessionId = id;
			return {};
		},
		voiceStop: async () => ({}),
		voiceCancel,
		voiceAudio: async () => new Uint8Array(44),
		voiceSend: async (
			_session: string,
			_generation: number,
			sequence: number,
		) => {
			if (sequence === 2) throw new Error("upload_rejected");
			return {};
		},
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: ready ? "ready" : "responding",
			text: "質問",
			runId: "run",
			error: null,
			revision: 2,
			audioChunks: ready ? [{ index: 0, text: "回答" }] : [],
			audioComplete: ready,
		}),
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	try {
		await act(async () => hook.result.current.start());
		act(() => segment(new Uint8Array(44)));
		await waitFor(() => expect(hook.result.current.turn?.text).toBe("質問"));
		const firstId = hook.result.current.turn!.utteranceId;
		act(() => {
			segment(new Uint8Array(44));
			segment(new Uint8Array(44));
		});
		await waitFor(() =>
			expect(hook.result.current.error).toContain("upload_rejected"),
		);
		expect(voiceCancel).not.toHaveBeenCalled();
		expect(hook.result.current.recognitionId).toBe(firstId);
		await act(async () => {
			ready = true;
			await query.invalidateQueries();
		});
		await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
	} finally {
		hook.unmount();
		query.clear();
	}
});

test("stopping during the upload retry delay prevents a stale retry", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let segment = (_wav: Uint8Array) => {};
	const createAudio: CreateAudio = (_state, _speech, onSegment) => {
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play: async () => {},
		};
	};
	const voiceSend = vi.fn(async () => {
		throw new TypeError("offline");
	});
	const client = {
		identity: "stopped-retry",
		voiceStart: async () => ({}),
		voiceStop: async () => ({}),
		voiceSend,
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	try {
		await act(async () => hook.result.current.start());
		act(() => segment(new Uint8Array(44)));
		await waitFor(() => expect(voiceSend).toHaveBeenCalledTimes(1));
		await act(async () => hook.result.current.stop());
		await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
		expect(voiceSend).toHaveBeenCalledTimes(1);
		expect(hook.result.current.error).toBeNull();
	} finally {
		hook.unmount();
		query.clear();
	}
});

test("a delayed stop cannot clear a new turn or reset the new microphone state", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	const microphones: Array<(wav: Uint8Array) => void> = [];
	let finishStop = () => {};
	const createAudio: CreateAudio = (state, _speech, segment) => {
		microphones.push(segment);
		const first = microphones.length === 1;
		return {
			start: async () => state({ phase: "listening", level: 0.1 }),
			stop: async () => {
				if (first)
					await new Promise<void>((resolve) => {
						finishStop = resolve;
					});
				state({ phase: "idle", level: 0 });
			},
			stopPlayback: () => {},
			play: async () => {},
		};
	};
	let sessionId = "";
	const client = {
		identity: "delayed-stop",
		voiceStart: async (id: string) => {
			sessionId = id;
			return {};
		},
		voiceStop: async () => ({}),
		voiceSend: async () => ({}),
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: "responding",
			text: "新しい質問",
			runId: "run",
			error: null,
			revision: 2,
			audioChunks: [],
			audioComplete: false,
		}),
	} as unknown as VoiceDialogueClient;
	const store = createAudioStore();
	const hook = renderHook(() => useVoiceDialogue(client, store, createAudio), {
		wrapper,
	});
	try {
		await act(async () => hook.result.current.start());
		let stopped: Promise<void> | undefined;
		act(() => {
			stopped = hook.result.current.stop();
		});
		await act(async () => hook.result.current.start());
		act(() => microphones[1]!(new Uint8Array(44)));
		await waitFor(() =>
			expect(hook.result.current.turn?.text).toBe("新しい質問"),
		);
		await act(async () => {
			finishStop();
			await stopped;
		});
		expect(hook.result.current.turn?.text).toBe("新しい質問");
		expect(hook.result.current.active).toBe(true);
		expect(store.getState().phase).toBe("listening");
	} finally {
		hook.unmount();
		query.clear();
	}
});
