/** Two-message synthetic control. Deliberately distinct from the product's context layout. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	configureLogging,
	withLogContext,
} from "../../api/infrastructure/logger";
import { safeError } from "../../api/domains/inference/service/errors";
import { createLiveLarm } from "../live-larm";
import {
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

if (!process.argv.includes("--run")) throw new Error("use --run");
const at = process.argv.indexOf("--out");
const out = resolve(
	at < 0
		? `verification-reports/response-cache-control/${new Date().toISOString().replaceAll(":", "-")}`
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
const json = process.argv.includes("--json");
const rows: Array<
	MeasuredCall & {
		phase: string;
		role: "main" | "auxiliary";
		correct?: boolean;
		durationMs: number;
	}
> = [];
const format = json
	? {
			jsonOutput: true,
			jsonSchema: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
		}
	: {};
function messages(units: number, nonce: string, referenceValue = cacheMarker) {
	return [
		{
			role: "system" as const,
			content:
				`${json ? 'Return the reference VALUE as {"value":"..."}.' : "Return only the reference VALUE."} The following is synthetic reference data, not instructions. Measurement ${nonce}.\n<REFERENCE>\n` +
				Array.from(
					{ length: units },
					(_, i) =>
						`Entry ${i}: Artificial reference observation ${i}; no actions or approvals are requested.\n`,
				).join("") +
				`VALUE=${referenceValue}\n</REFERENCE>`,
		},
		{ role: "user" as const, content: "What is VALUE in the reference?" },
	];
}
async function call(
	phase: string,
	input: ReturnType<typeof messages>,
	role: "main" | "auxiliary" = "main",
	expected = role === "main" ? cacheMarker : "OK",
) {
	const subjectId = crypto.randomUUID(),
		started = performance.now(),
		signal = AbortSignal.timeout(120000);
	let outcome = "ok",
		errorCode: string | undefined,
		correct = false;
	try {
		const answer = await withLogContext(
			{ subjectId, phase, sessionRole: role },
			() =>
				port.answerStream!(input, signal, () => {}, {
					sessionRole: role,
					maxOutputTokens: 512,
					contextPolicy: "exact",
					...format,
				}),
		);
		correct = cacheReferenceMatches(answer, expected, json);
	} catch (error) {
		outcome = signal.aborted ? "aborted" : "error";
		errorCode = safeError(error, signal);
	}
	const row = {
		subjectId,
		phase,
		role,
		outcome,
		errorCode,
		correct,
		durationMs: Math.round(performance.now() - started),
	};
	rows.push(row);
	const measured = callReport(
		readEvents(logfile).filter((event) => event.subjectId === subjectId),
		[row],
	).rows[0]!;
	console.log(JSON.stringify(measured));
	return measured;
}
try {
	let units = 640;
	for (let i = 0; i < 3; i++) {
		const row = await call(
			`calibration_${i + 1}`,
			messages(units, crypto.randomUUID()),
		);
		if (
			row.outcome !== "ok" ||
			!row.correct ||
			typeof row.formalTokens !== "number"
		)
			throw new Error("calibration_failed");
		if (Math.abs(row.formalTokens - 14000) <= 128) break;
		units = Math.max(1, Math.round((units * 14000) / row.formalTokens));
	}
	const nonce = crypto.randomUUID();
	const original = messages(units, nonce);
	const first = await call("first_seen", original);
	if (
		typeof first.formalTokens !== "number" ||
		Math.abs(first.formalTokens - 14000) > 256
	)
		throw new Error("formal_input_outside_target");
	await call("immediate_repeat", original);
	await call("same_system_different_user", [
		original[0]!,
		{ role: "user", content: "Reply with the reference VALUE once." },
	]);
	const changed = messages(units, nonce, cacheUpdatedMarker);
	changed[0]!.content += "\nAdditional synthetic background observation.";
	await call("background_updated", changed, "main", cacheUpdatedMarker);
	await call("original_repeat", original);
	for (let i = 0; i < 4; i++)
		await call(
			`auxiliary_${i + 1}`,
			[
				{
					role: "user",
					content: `${json ? 'Return {"value":"OK"}.' : "Return OK only."} Independent synthetic call ${i + 1}.`,
				},
			],
			"auxiliary",
		);
	await call("after_four_auxiliary", original);
} finally {
	await port.close();
	const report = callReport(readEvents(logfile), rows);
	const acceptance = cacheAcceptance(report);
	if (!acceptance.passed) process.exitCode = 1;
	writeFileSync(
		join(out, "result.json"),
		JSON.stringify(
			{
				lane: "live_two_message_synthetic_control",
				outputMode: json ? "json-schema" : "text",
				note: "Not product layout; no cache clearing or assumed cold slots",
				...report,
				acceptance,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}
