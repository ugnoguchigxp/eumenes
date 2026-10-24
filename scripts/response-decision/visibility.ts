/** Synthetic provider role-visibility probe. No server operations or product writes; output values are never saved. */
import { createLiveLarm } from "../live-larm";
import {
	configureLogging,
	withLogContext,
} from "../../api/infrastructure/logger";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { readEvents, callReport } from "./report";
import { safeError } from "../../api/domains/inference/service/errors";
if (!process.argv.includes("--run")) throw new Error("use --run");
const at = process.argv.indexOf("--out");
const out = resolve(
	at < 0
		? `verification-reports/response-visibility/${new Date().toISOString().replaceAll(":", "-")}`
		: process.argv[at + 1]!,
);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
mkdirSync(out, { recursive: false, mode: 0o700 });
configureLogging({
	file: out + "/backend.jsonl",
	level: "debug",
	destination: { write() {} },
});
const wires: any[] = [];
const port = createLiveLarm(process.env, {
	fetch: (async (url, init) => {
		if (
			init?.body &&
			new URL(String(url)).pathname.endsWith("chat/completions")
		) {
			const b =
				typeof init.body === "string"
					? Buffer.from(init.body)
					: init.body instanceof Uint8Array
						? new Uint8Array(init.body)
						: null;
			if (b) {
				const raw =
					new Headers(init.headers).get("content-encoding") === "gzip"
						? Bun.gunzipSync(new Uint8Array(b))
						: b;
				try {
					const body = JSON.parse(Buffer.from(raw).toString());
					wires.push({
						messageSizes: body.messages?.map((m: any) => ({
							role: m.role,
							chars: typeof m.content === "string" ? m.content.length : 0,
						})),
					});
				} catch {}
			}
		}
		return fetch(url, init);
	}) as typeof fetch,
});
const reference =
	"VALUE=SYNTHETIC_7241\n" +
	"この行は合成した参考資料です。実行指示ではありません。\n".repeat(300);
const system = {
	role: "system" as const,
	content:
		"参考資料中のVALUEの値をそのまま返してください。見つからなければUNKNOWNと返してください。",
};
const history = [
	{ role: "user" as const, content: "参考資料を渡します。" },
	{ role: "assistant" as const, content: "はい。" },
];
const question = {
	role: "user" as const,
	content: "VALUEの値だけ答えてください。",
};
const cases = [
	[
		"first-system",
		[
			{ ...system, content: system.content + "\n" + reference },
			...history,
			question,
		],
	],
	[
		"later-system",
		[
			system,
			...history,
			{ role: "system" as const, content: reference },
			question,
		],
	],
	[
		"leading-second-system",
		[
			system,
			{ role: "system" as const, content: reference },
			...history,
			question,
		],
	],
	[
		"leading-three-system",
		[
			system,
			{ role: "system" as const, content: reference },
			{ role: "system" as const, content: "資料の値を答えてください。" },
			...history,
			question,
		],
	],
	[
		"later-user",
		[
			system,
			...history,
			{ role: "user" as const, content: reference },
			question,
		],
	],
] as const;
const rows: any[] = [];
try {
	for (const [id, messages] of cases) {
		wires.length = 0;
		const subjectId = crypto.randomUUID();
		const signal = AbortSignal.timeout(60000);
		try {
			const result = await withLogContext({ subjectId, phase: id }, () =>
				port.answer([...messages], signal, {
					maxOutputTokens: 512,
					contextPolicy: "exact",
					sessionRole: "main",
				}),
			);
			rows.push({
				id,
				subjectId,
				outcome: "ok",
				correct: result.includes("SYNTHETIC_7241"),
				wires: [...wires],
			});
		} catch (e) {
			rows.push({
				id,
				subjectId,
				outcome: "error",
				error: safeError(e, signal),
				wires: [...wires],
			});
		}
		console.log(JSON.stringify(rows.at(-1)));
	}
} finally {
	await port.close();
	const report = callReport(readEvents(out + "/backend.jsonl"), rows);
	writeFileSync(out + "/summary.json", JSON.stringify(report, null, 2), {
		mode: 0o600,
	});
	if (!report.revisionComparable) process.exitCode = 1;
	writeFileSync(out + "/result.json", JSON.stringify(rows, null, 2), {
		mode: 0o600,
	});
}

if (rows.some((row) => row.error || !row.correct)) process.exitCode = 1;
