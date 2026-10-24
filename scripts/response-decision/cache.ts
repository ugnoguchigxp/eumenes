/** Cache observation only. A new connection does not guarantee a cold slot. No service is started or restarted. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
	configureLogging,
	withLogContext,
} from "../../api/infrastructure/logger";
import { safeError } from "../../api/domains/inference/service/errors";
import {
	renderContext,
	contextPartSizes,
} from "../../api/domains/dialogue/service/context-render";
import { createLiveLarm } from "../live-larm";
import {
	cacheInput,
	cacheMarker,
	cacheUpdatedMarker,
	cacheReferenceMatches,
} from "./cache-input";
import {
	readEvents,
	callReport,
	cacheAcceptance,
	type MeasuredCall,
} from "./report";
import { markCurrentRequest } from "../../api/domains/dialogue/service/request-context";

if (!process.argv.includes("--run")) throw new Error("use --run");
const at = process.argv.indexOf("--out");
const out = resolve(
	at < 0
		? `verification-reports/response-cache/${new Date().toISOString().replaceAll(":", "-")}`
		: process.argv[at + 1]!,
);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
mkdirSync(out, { recursive: false, mode: 0o700 });
const logfile = join(out, "backend.jsonl");
configureLogging({
	file: logfile,
	level: "debug",
	destination: { write() {} },
});
const port = createLiveLarm();
const assembly = cacheInput();
const original = markCurrentRequest(
	renderContext(assembly, "current").messages,
	assembly.input,
	"synthetic-current",
);
const changed = cacheInput(14000, cacheUpdatedMarker);
changed.working.push({
	source: "memory.short_term",
	authority: "reference",
	freshness: "past",
	body: { kind: "text", text: "合成資料に一行だけ追加しました。" },
});
const rows: Array<
	MeasuredCall & {
		role: "main" | "auxiliary";
		correct?: boolean;
		regime: string;
		durationMs: number;
		errorCode?: string;
	}
> = [];
async function call(
	regime: string,
	messages: typeof original,
	sessionRole: "main" | "auxiliary",
	expected = cacheMarker,
) {
	const subjectId = crypto.randomUUID();
	const started = performance.now();
	const signal = AbortSignal.timeout(120_000);
	try {
		const answer = await withLogContext({ subjectId, phase: regime }, () =>
			port.answerStream!(messages, signal, () => {}, {
				sessionRole,
				maxOutputTokens: 128,
				contextPolicy: "exact",
			}),
		);
		rows.push({
			subjectId,
			regime,
			role: sessionRole,
			correct: cacheReferenceMatches(answer, expected),
			outcome: "ok",
			durationMs: Math.round(performance.now() - started),
		});
	} catch (error) {
		rows.push({
			subjectId,
			regime,
			role: sessionRole,
			outcome: "error",
			errorCode: safeError(error, signal),
			durationMs: Math.round(performance.now() - started),
		});
		process.exitCode = 1;
	}
	console.log(JSON.stringify(rows.at(-1)));
}
try {
	await call("first_seen", original, "main");
	await call("immediate_repeat", original, "main");
	const differentUser = structuredClone(original);
	differentUser[differentUser.length - 1]!.content +=
		" 値だけを返してください。";
	await call("same_system_different_user", differentUser, "main");
	await call(
		"background_updated",
		markCurrentRequest(
			renderContext(changed, "current").messages,
			changed.input,
			"synthetic-current",
		),
		"main",
		cacheUpdatedMarker,
	);
	await call("original_repeat", original, "main");
	for (let i = 0; i < 4; i++)
		await call(
			`auxiliary_${i + 1}`,
			[
				{
					role: "user",
					content: `合成試験の番号${i + 1}を数字だけで答えてください。`,
				},
			],
			"auxiliary",
			String(i + 1),
		);
	await call("after_four_auxiliary", original, "main");
} finally {
	await port.close();
	const measured = callReport(readEvents(logfile), rows);
	const acceptance = cacheAcceptance(measured);
	if (!acceptance.passed) process.exitCode = 1;
	writeFileSync(
		join(out, "result.json"),
		JSON.stringify(
			{
				lane: "live_adapter_synthetic_cache",
				acceptance:
					"observational_only; verify role visibility before accepting a large-context cache result",
				note: "first_seen is not guaranteed cold; compare provider counts, never infer cache from connection identity",
				estimatedParts: contextPartSizes(assembly),
				...measured,
				formalAcceptance: acceptance,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}
