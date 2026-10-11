export const artifactMimes = [
	"image/png",
	"image/webp",
	"audio/mpeg",
	"audio/wav",
	"audio/x-wav",
	"audio/flac",
	"audio/ogg",
];

export function musicMime(format: unknown): string {
	switch (format) {
		case "opus":
			return "audio/ogg";
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "flac":
			return "audio/flac";
		default:
			throw new Error("invalid_artifact_type");
	}
}

export function assertArtifactContent(content: Uint8Array, mime: string) {
	if (!content.length) throw new Error("invalid_artifact_empty");
	const tag = (start: number, end: number) =>
		new TextDecoder().decode(content.slice(start, end));
	// Ogg's first page stores the Opus identification packet after its segment table.
	const segments = content[26] ?? 0;
	const packet = 27 + segments;
	if (
		(mime === "image/png" &&
			![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => content[i] === n)) ||
		(mime === "image/webp" &&
			(tag(0, 4) !== "RIFF" || tag(8, 12) !== "WEBP")) ||
		(["audio/wav", "audio/x-wav"].includes(mime) &&
			(tag(0, 4) !== "RIFF" || tag(8, 12) !== "WAVE")) ||
		(mime === "audio/flac" && tag(0, 4) !== "fLaC") ||
		(mime === "audio/mpeg" &&
			tag(0, 3) !== "ID3" &&
			!(content[0] === 255 && ((content[1] ?? 0) & 224) === 224)) ||
		(mime === "audio/ogg" &&
			(tag(0, 4) !== "OggS" ||
				content[4] !== 0 ||
				((content[5] ?? 0) & 2) !== 2 ||
				segments === 0 ||
				(content[27] ?? 0) < 19 ||
				content.length < packet + 19 ||
				tag(packet, packet + 8) !== "OpusHead"))
	)
		throw new Error("invalid_artifact_content");
}
