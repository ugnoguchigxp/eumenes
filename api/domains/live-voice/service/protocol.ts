/** UTF-8 byte budget also bounds byte-level tokens, with room for message framing (8192 tokens/128 messages). */
export function historyInput(
	history: Array<{ role: "user" | "assistant"; text: string }>,
) {
	let bytes = 6000;
	const kept: Array<{
		type: "message";
		role: "user" | "assistant";
		content: Array<{ type: "input_text" | "output_text"; text: string }>;
	}> = [];
	const encoder = new TextEncoder();
	for (const message of history.slice(-40).reverse()) {
		const points = Array.from(message.text);
		let text = "";
		for (let i = points.length - 1; i >= 0; i--) {
			const point = points[i]!;
			const length = encoder.encode(point).length;
			if (length > bytes) break;
			text = point + text;
			bytes -= length;
		}
		if (text)
			kept.unshift({
				type: "message",
				role: message.role,
				content: [
					{
						type: message.role === "user" ? "input_text" : "output_text",
						text,
					},
				],
			});
		if (bytes < 4) break;
	}
	return kept;
}
export function validPcm(audio: string, limit: number) {
	const bytes = Buffer.from(audio, "base64");
	return (
		bytes.length >= 2 &&
		bytes.length <= limit &&
		bytes.length % 2 === 0 &&
		bytes.toString("base64") === audio
	);
}
