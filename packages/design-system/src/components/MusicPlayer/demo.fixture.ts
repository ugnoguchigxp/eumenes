/** A local, quiet 30-second test tone, never a generated or remotely fetched song. */
export function demoAudio() {
	const samples = 8000 * 30;
	const buffer = new ArrayBuffer(44 + samples * 2);
	const view = new DataView(buffer);
	const text = (offset: number, value: string) =>
		[...value].forEach((c, i) => {
			view.setUint8(offset + i, c.charCodeAt(0));
		});
	text(0, "RIFF");
	view.setUint32(4, 36 + samples * 2, true);
	text(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 8000, true);
	view.setUint32(28, 16000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, samples * 2, true);
	for (let i = 0; i < samples; i++)
		view.setInt16(44 + i * 2, Math.sin((i / 8000) * Math.PI * 440) * 300, true);
	return new Blob([buffer], { type: "audio/wav" });
}
