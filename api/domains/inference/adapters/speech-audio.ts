import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { readBounded } from "../../../infrastructure/bounded-read";
import { isWav } from "../service/wav";

/** Decode provider audio in memory for the shared WAV playback contract. */
export async function decodeSpeechAsWav(
	bytes: Uint8Array,
	signal: AbortSignal,
	decoder: string,
) {
	signal.throwIfAborted();
	const child = spawn(
		decoder,
		[
			"-nostdin",
			"-v",
			"error",
			"-protocol_whitelist",
			"pipe",
			"-i",
			"pipe:0",
			"-acodec",
			"pcm_s16le",
			"-f",
			"wav",
			"pipe:1",
		],
		{ stdio: ["pipe", "pipe", "ignore"], signal, timeout: 15_000 },
	);
	const done = new Promise<boolean>((resolve) => {
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
	child.stdin.on("error", () => {});
	child.stdin.end(bytes);
	try {
		const wav = await readBounded(
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
			{
				limit: 16_000_000,
				tooLarge: "response_too_large",
				missing: "invalid_tts_audio",
			},
		);
		if (!(await done) || !isWav(wav)) throw new Error("invalid_tts_audio");
		signal.throwIfAborted();
		return wav;
	} finally {
		child.kill();
	}
}
