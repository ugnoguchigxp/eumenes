/**
 * Speech end → transcript on screen, per voice input, from the API log (no text or audio is read).
 *
 *   bun scripts/voice-latency.ts [--since TIME] [--limit 20] [--file PATH]
 *
 * Browser side (voice.input_timing): silence waited before cutting the segment, encoding, upload,
 * and upload → transcript shown. Server side, matched by utteranceId: the wait for the LARM
 * connection (asr provider_ready), recognition (response_headers), the source used, and the rest of
 * upload → shown (change notification and the browser's refetch).
 */
import { existsSync } from "node:fs";
import {
	createLogReader,
	defaultLogFile,
	logGenerations,
	logTimeMs,
	type LogEntry,
} from "../api/infrastructure/log-reader";
import { jstIso, parseTimeJst } from "../api/infrastructure/jst-time";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const option = (name: string) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const file = option("--file") ?? defaultLogFile();
const since = option("--since") ? parseTimeJst(option("--since")!) : 0;
const limit = Number(option("--limit") ?? 20);
if (
	!file ||
	!logGenerations(file).some(existsSync) ||
	!Number.isFinite(since)
) {
	console.error(
		"usage: bun scripts/voice-latency.ts [--since TIME] [--limit 20] [--file PATH]",
	);
	process.exit(2);
}

type Input = {
	shown?: LogEntry;
	accepted?: number;
	prepared?: number;
	connectionMs: number;
	recognitionMs: number;
	sources: Set<string>;
	failures: string[];
};
const inputs = new Map<string, Input>();
const input = (id: string) => {
	let found = inputs.get(id);
	if (!found) {
		found = {
			connectionMs: 0,
			recognitionMs: 0,
			sources: new Set(),
			failures: [],
		};
		inputs.set(id, found);
	}
	return found;
};
const num = (value: unknown) => (typeof value === "number" ? value : 0);
await createLogReader(file).read((entry) => {
	const at = logTimeMs(entry);
	if (at === undefined || at < since) return;
	const id = String(entry.utteranceId ?? entry.subjectId ?? "");
	if (!/^[0-9a-f-]{36}$/.test(id)) return;
	if (entry.event === "voice.input_timing") input(id).shown = entry;
	else if (entry.event === "voice.input_prepared") input(id).prepared ??= at;
	else if (
		entry.purpose === "asr" &&
		entry.event === "inference.attempt_started"
	) {
		input(id).accepted ??= at;
		if (typeof entry.source === "string") input(id).sources.add(entry.source);
	} else if (
		entry.purpose === "asr" &&
		entry.event === "inference.attempt_failed"
	)
		input(id).failures.push(String(entry.reason ?? "failed"));
	else if (entry.purpose === "asr" && entry.event === "performance.stage") {
		if (entry.phase === "provider_ready")
			input(id).connectionMs += num(entry.durationMs);
		if (entry.phase === "response_headers")
			input(id).recognitionMs += num(entry.durationMs);
	}
}, /voice\.input_(timing|prepared)|"purpose":"asr"/);

const rows = [...inputs.entries()]
	.filter(([, i]) => i.shown)
	.slice(-limit)
	.map(([id, i]) => {
		const s = i.shown!;
		const server =
			i.accepted !== undefined && i.prepared !== undefined
				? i.prepared - i.accepted
				: undefined;
		const total =
			num(s.endToSegmentMs) + num(s.uploadMs) + num(s.uploadToShownMs);
		return {
			time: jstIso(logTimeMs(s)!).slice(11, 19),
			id: id.slice(0, 8),
			silence: num(s.endToSegmentMs),
			encode: num(s.encodeMs),
			upload: num(s.uploadMs),
			"larm wait": Math.round(i.connectionMs),
			asr: Math.round(i.recognitionMs),
			"asr total": server ?? "-",
			"notify+fetch":
				server === undefined ? "-" : num(s.uploadToShownMs) - server,
			"end→shown": total,
			audio: num(s.audioMs),
			"pre-roll": num(s.preRollMs),
			trail: num(s.trailMs),
			via: [...i.sources].join("+") || "-",
			failed: i.failures.join(",") || "",
		};
	});
if (!rows.length) {
	console.log(
		"No voice.input_timing yet: speak once with the updated web, then run again.",
	);
	process.exit(0);
}
console.log(
	"All values in ms. end→shown = silence + upload + (asr total + notify+fetch).",
);
console.table(rows);
