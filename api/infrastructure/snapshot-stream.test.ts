import { expect, test } from "bun:test";
import { snapshotStream } from "./snapshot-stream";
test("a pending reader receives each snapshot once and terminal delivery releases the observer", async () => {
	let emit: (value: { text: string; done: boolean }) => void = () => {},
		stopped = false;
	const stream = snapshotStream<{ text: string; done: boolean }>(
		(listener) => {
			emit = listener;
			listener({ text: "", done: false });
			return () => {
				stopped = true;
			};
		},
		(value) => value.done,
		new AbortController().signal,
	);
	const reader = stream.getReader();
	await reader.read();
	const first = reader.read();
	emit({ text: "先", done: false });
	expect(new TextDecoder().decode((await first).value)).toContain("先");
	let secondArrived = false;
	const second = reader.read().then((value) => {
		secondArrived = true;
		return value;
	});
	await Bun.sleep(1);
	expect(secondArrived).toBe(false);
	emit({ text: "先の回答", done: true });
	expect(new TextDecoder().decode((await second).value)).toContain("先の回答");
	expect((await reader.read()).done).toBe(true);
	expect(stopped).toBe(true);
});
test("a slow reader has bounded snapshots and still receives the final state", async () => {
	let emit: (value: { text: string; done: boolean }) => void = () => {};
	const stream = snapshotStream<{ text: string; done: boolean }>(
		(listener) => {
			emit = listener;
			return () => {};
		},
		(value) => value.done,
		new AbortController().signal,
	);
	for (let i = 0; i < 100; i++) emit({ text: String(i), done: i === 99 });
	const reader = stream.getReader(),
		frames: string[] = [];
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		frames.push(new TextDecoder().decode(next.value));
	}
	expect(frames.length).toBeLessThanOrEqual(5);
	expect(frames.at(-1)).toContain("99");
});
