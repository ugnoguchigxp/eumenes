/** VOICEVOX fails on clauses with no phoneme (e.g. "。", "…", "！？"). */
const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** Incremental speech clauses, independent of provider token boundaries. */
export class SpeechSentences {
	private buffer = "";
	private prefix = "";
	append(prefix: string, final = false): string[] {
		if (!prefix.startsWith(this.prefix))
			throw new Error("speech_stream_diverged");
		if (prefix.length > 65536) throw new Error("speech_source_too_large");
		this.buffer += prefix.slice(this.prefix.length);
		this.prefix = prefix;
		const chunks: string[] = [];
		for (;;) {
			let boundary = 0;
			for (let i = 0; i < this.buffer.length; i++) {
				const char = this.buffer[i] ?? "";
				if (!/[。！？、!?.,;\n]/.test(char)) continue;
				const before = this.buffer.slice(0, i + 1);
				if (/[.,]/.test(char)) {
					if (/(?:https?:\/\/|www\.)\S*$/.test(before)) continue;
					if (i === this.buffer.length - 1 && !final) break;
					if (
						/\d/.test(this.buffer[i - 1] ?? "") &&
						/\d/.test(this.buffer[i + 1] ?? "")
					)
						continue;
				}
				boundary = i + 1;
				break;
			}
			if (!boundary && this.buffer.length >= 240) {
				boundary = 240;
				while (
					boundary > 120 &&
					/[a-zA-Z0-9]/.test(this.buffer[boundary - 1] ?? "") &&
					/[a-zA-Z0-9]/.test(this.buffer[boundary] ?? "")
				)
					boundary--;
			}
			if (!boundary) {
				if (final && speakable(this.buffer.trim()))
					chunks.push(this.buffer.trim());
				if (final) this.buffer = "";
				return chunks;
			}
			const chunk = this.buffer.slice(0, boundary).trim();
			this.buffer = this.buffer.slice(boundary);
			if (speakable(chunk)) chunks.push(chunk);
		}
	}
}
