import { afterEach, expect, test, vi } from "vitest";
import { notificationSoundWav } from "./notification-sound";
const timerToneWav = () => {
	const bytes = new Uint8Array(44);
	bytes.set(new TextEncoder().encode("RIFF"));
	bytes.set(new TextEncoder().encode("WAVE"), 8);
	return bytes;
};
afterEach(() => vi.unstubAllGlobals());
test("beep remains available offline and an aborted request cannot produce audio", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	expect(
		await notificationSoundWav("beep", new AbortController().signal),
	).toBeUndefined();
	expect(fetcher).not.toHaveBeenCalled();
	const abort = new AbortController();
	abort.abort();
	await expect(
		notificationSoundWav("soft-chime", abort.signal),
	).rejects.toThrow();
});
test("the selected bundled WAV is loaded; HTTP failures and non-audio are rejected", async () => {
	const wav = timerToneWav();
	const fetcher = vi.fn(
		async (_url: string) => new Response(new Uint8Array(wav)),
	);
	vi.stubGlobal("fetch", fetcher);
	expect(
		await notificationSoundWav("water-drop", new AbortController().signal),
	).toEqual(wav);
	expect(fetcher.mock.calls[0]?.[0]).toContain("water-drop.wav");
	fetcher.mockImplementationOnce(
		async () => new Response("missing", { status: 404 }),
	);
	await expect(
		notificationSoundWav("soft-chime", new AbortController().signal),
	).rejects.toThrow("notification_sound_unavailable");
	fetcher.mockImplementationOnce(
		async () => new Response("<html>no audio</html>"),
	);
	await expect(
		notificationSoundWav("soft-chime", new AbortController().signal),
	).rejects.toThrow("notification_sound_invalid");
});
test("cancellation after download discards the late bytes", async () => {
	const abort = new AbortController();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			abort.abort();
			return new Response(new Uint8Array(timerToneWav()));
		}),
	);
	await expect(
		notificationSoundWav("soft-chime", abort.signal),
	).rejects.toThrow();
});
