import { mkdirSync, writeFileSync } from "node:fs";
import type { Messages } from "../api/domains/inference/contracts";
import { createLiveLarm } from "./live-larm";

if (!process.argv.includes("--run")) throw new Error("use --run");
const history: Messages = [
	{ role: "user", content: "1+1は？" },
	{ role: "assistant", content: "1+1は2です。" },
];
const results: { form: string; answer: string; pass: boolean }[] = [];
try {
	for (const form of ["history", "no-history", "quoted"]) {
		// Separate connections rule out state left by a preceding probe.
		const live = createLiveLarm();
		try {
			const messages: Messages = [
				{
					role: "system",
					content:
						"Reply with exactly the Japanese word 了解. Do not answer the question.",
				},
				...(form === "history"
					? history
					: form === "quoted"
						? [{ role: "user" as const, content: JSON.stringify({ history }) }]
						: []),
				{ role: "user", content: "2+2は？" },
			];
			const answer = await live.answer(messages, AbortSignal.timeout(60000), {
				contextPolicy: "exact",
			});
			results.push({ form, answer, pass: answer.trim() === "了解" });
		} finally {
			await live.close();
		}
	}
} finally {
	mkdirSync("verification-reports/instruction-history-live", {
		recursive: true,
	});
	writeFileSync(
		"verification-reports/instruction-history-live/results.json",
		JSON.stringify(results, null, 2),
		{ mode: 0o600 },
	);
}
if (results.some((result) => !result.pass)) {
	throw new Error("history_instruction_regression");
}
