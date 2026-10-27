import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { AudioController } from "../../audio";
import { queueChunks, type ChunkQueue } from "../hooks/chunk-player";

afterEach(() => vi.restoreAllMocks());

const turn = {
	utteranceId: "u",
	audioChunks: [
		{ index: 0, text: "先。" },
		{ index: 1, text: "続き。" },
	],
} as unknown as VoiceTurn;

it("fetches every listed chunk at once, plays the next without waiting for the played report, and reports the gap", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const fetched: number[] = [];
	const played: Array<{ index?: number; gap?: unknown }> = [];
	let releaseReport = () => {};
	const client = {
		identity: "x",
		voiceAudio: vi.fn(async (_id: string, index?: number) => {
			fetched.push(index!);
			return new Uint8Array(44);
		}),
		// The first report never answers until released: the next chunk must not wait for it.
		voicePlayed: vi.fn(
			(_id: string, index?: number, gap?: unknown) =>
				new Promise((resolve) => {
					played.push({ index, gap });
					releaseReport = () => resolve({});
				}),
		),
	} as unknown as VoiceDialogueClient;
	const endings: Array<() => void> = [];
	const starts: Array<() => void> = [];
	let currentDone = Promise.resolve();
	const controller = {
		play: vi.fn(async (_bytes, onEnded, options) => {
			if (options?.waitForPrevious) await currentDone;
			let finish = () => {};
			currentDone = new Promise<void>((resolve) => {
				finish = resolve;
			});
			endings.push(() => {
				finish();
				onEnded();
			});
			starts.push(() => options?.onStarted?.());
		}),
	} as unknown as AudioController;
	const delivered = new Set<string>();
	const queue: ChunkQueue = { id: "u", epoch: 1, tail: Promise.resolve() };
	queueChunks(turn, queue, {
		client,
		cache: new QueryClient(),
		controller: () => controller,
		volume: () => 1,
		delivered: (key) => delivered.has(key),
		markDelivered: (key) => void delivered.add(key),
		queued: () => true,
		valid: () => true,
		setSubtitle: () => {},
		setAvatarCue: () => {},
		fail: (e) => {
			throw e;
		},
	});
	await vi.waitFor(() => expect(starts).toHaveLength(1));
	expect(fetched).toEqual([0, 1]);
	starts[0]!();
	now = 1000;
	endings[0]!(); // chunk 0 ends; its report stays unanswered
	await vi.waitFor(() => expect(starts).toHaveLength(2));
	now = 1040;
	starts[1]!();
	endings[1]!();
	await vi.waitFor(() => expect(played).toHaveLength(2));
	expect(played[0]).toEqual({ index: 0, gap: undefined });
	expect(played[1]).toEqual({ index: 1, gap: { gapMs: 40, fetchLateMs: 0 } });
	releaseReport();
});

it("discards prefetched chunks after cancellation and never reports them played", async () => {
	let live = true;
	let releaseAudio!: (bytes: Uint8Array) => void;
	const second = new Promise<Uint8Array>((resolve) => (releaseAudio = resolve));
	const client = {
		identity: "x",
		voiceAudio: vi.fn(async (_id: string, index: number) =>
			index === 0 ? new Uint8Array(44) : second,
		),
		voicePlayed: vi.fn(async () => ({})),
	} as unknown as VoiceDialogueClient;
	let ended = () => {};
	const controller = {
		play: vi.fn(async (_bytes, onEnded) => {
			ended = onEnded;
		}),
	} as unknown as AudioController;
	const delivered = new Set<string>();
	const queue: ChunkQueue = { id: "u", epoch: 1, tail: Promise.resolve() };
	queueChunks(turn, queue, {
		client,
		cache: new QueryClient(),
		controller: () => controller,
		volume: () => 1,
		delivered: (key) => delivered.has(key),
		markDelivered: (key) => void delivered.add(key),
		queued: () => live,
		valid: () => true,
		setSubtitle: () => {},
		setAvatarCue: () => {},
		fail: (error) => {
			throw error;
		},
	});
	await vi.waitFor(() => expect(controller.play).toHaveBeenCalledTimes(1));
	expect(client.voiceAudio).toHaveBeenCalledTimes(2);
	live = false;
	releaseAudio(new Uint8Array(44));
	ended();
	await queue.tail;
	expect(controller.play).toHaveBeenCalledTimes(1);
	expect(client.voicePlayed).not.toHaveBeenCalled();
});

it("ignores a late audio fetch error after its playback queue was cancelled", async () => {
	let live = true;
	let rejectAudio!: (reason: Error) => void;
	const pending = new Promise<Uint8Array>(
		(_resolve, reject) => (rejectAudio = reject),
	);
	const client = {
		identity: "x",
		voiceAudio: vi.fn(() => pending),
	} as unknown as VoiceDialogueClient;
	const queued = vi.fn(() => live);
	const fail = vi.fn();
	const queue: ChunkQueue = { id: "u", epoch: 1, tail: Promise.resolve() };
	queueChunks({ ...turn, audioChunks: turn.audioChunks!.slice(0, 1) }, queue, {
		client,
		cache: new QueryClient(),
		controller: () => null,
		volume: () => 1,
		delivered: () => false,
		markDelivered: () => {},
		queued,
		valid: () => true,
		setSubtitle: () => {},
		setAvatarCue: () => {},
		fail,
	});
	await vi.waitFor(() => expect(queued).toHaveBeenCalled());
	live = false;
	rejectAudio(new Error("audio_fetch_failed"));
	await queue.tail;
	expect(fail).not.toHaveBeenCalled();
});

it("ignores a late playback acknowledgement error after its queue was cancelled", async () => {
	let live = true;
	let rejectReport!: (reason: Error) => void;
	const pending = new Promise<void>(
		(_resolve, reject) => (rejectReport = reject),
	);
	const client = {
		identity: "x",
		voiceAudio: vi.fn(async () => new Uint8Array(44)),
		voicePlayed: vi.fn(() => pending),
	} as unknown as VoiceDialogueClient;
	let ended = () => {};
	const controller = {
		play: vi.fn(async (_bytes, onEnded) => {
			ended = onEnded;
		}),
	} as unknown as AudioController;
	const fail = vi.fn();
	const queue: ChunkQueue = { id: "u", epoch: 1, tail: Promise.resolve() };
	queueChunks({ ...turn, audioChunks: turn.audioChunks!.slice(0, 1) }, queue, {
		client,
		cache: new QueryClient(),
		controller: () => controller,
		volume: () => 1,
		delivered: () => false,
		markDelivered: () => {},
		queued: () => live,
		valid: () => true,
		setSubtitle: () => {},
		setAvatarCue: () => {},
		fail,
	});
	await queue.tail;
	ended();
	expect(client.voicePlayed).toHaveBeenCalledTimes(1);
	live = false;
	rejectReport(new Error("played_report_failed"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(fail).not.toHaveBeenCalled();
});

it("a muted live chunk is acknowledged as inaudible", async () => {
	const client = {
		identity: "muted",
		voiceAudio: vi.fn(async () => new Uint8Array(44)),
		voicePlayed: vi.fn(async () => ({})),
	} as unknown as VoiceDialogueClient;
	let end!: () => void;
	const controller = {
		play: vi.fn(async (_wav, onEnded) => {
			end = onEnded;
		}),
	} as unknown as AudioController;
	const queue: ChunkQueue = { id: "u", epoch: 1, tail: Promise.resolve() };
	queueChunks({ ...turn, audioChunks: turn.audioChunks!.slice(0, 1) }, queue, {
		client,
		cache: new QueryClient(),
		controller: () => controller,
		volume: () => 0,
		delivered: () => false,
		markDelivered: () => {},
		queued: () => true,
		valid: () => true,
		setSubtitle: () => {},
		setAvatarCue: () => {},
		fail: (error) => {
			throw error;
		},
	});
	await queue.tail;
	end();
	expect(client.voicePlayed).toHaveBeenCalledWith("u", 0, { audible: false });
});
