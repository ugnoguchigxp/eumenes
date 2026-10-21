import { mkdirSync, writeFileSync } from "node:fs";
/** Explicit live runner. No server, setting writes, provider claims or automatic POST retries. */
import { createComputeClient } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";
if (!process.argv.includes("--run"))
	throw new Error(
		"use --run for live discovery; add --execute for three CPU calculations",
	);
const saved = liveLarmSettings(),
	token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_or_control_credential_unconfigured");
const client = createComputeClient({ baseUrl: saved.baseUrl, token });
try {
	const found = await client.discover(AbortSignal.timeout(15000));
	console.log(
		JSON.stringify({
			stage: "environment",
			url: found.url,
			environmentRevision: found.environment.environmentRevision,
			packages: found.environment.packages,
		}),
	);
	if (process.argv.includes("--execute")) {
		const cases = [
			{
				code: "import numpy as np\nresult = int(np.sum(inputs['values']))",
				expected: 6,
			},
			{
				code: "import sympy as sp\nx=sp.Symbol('x')\nresult=str(sp.integrate(sp.sin(x),x))",
				expected: "-cos(x)",
			},
			{
				code: "from scipy.optimize import minimize_scalar\nresult=float(minimize_scalar(lambda x:(x-3)**2).x)",
				expected: 3,
			},
		];
		const directory = `verification-reports/compute-cpu/live-${Date.now()}`;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const [index, scenario] of cases.entries()) {
			const { code } = scenario,
				key = crypto.randomUUID();
			const body = {
				code,
				inputs: { values: [1, 2, 3] },
				timeoutSec: 30,
				accelerator: "cpu" as const,
			};
			writeFileSync(
				`${directory}/${index}.json`,
				JSON.stringify({ key, body }),
				{ mode: 0o600 },
			);
			const jobId = await client.submit(
				found.url,
				body,
				key,
				AbortSignal.timeout(15000),
			);
			const end = Date.now() + 370000;
			let finished = false;
			while (Date.now() < end) {
				await Bun.sleep(1000);
				const job = await client.get(
					found.url,
					jobId,
					AbortSignal.timeout(15000),
				);
				if (["completed", "failed", "cancelled"].includes(job.status)) {
					console.log(
						JSON.stringify({
							stage: "calculation",
							jobId,
							status: job.status,
							errorCode: job.error?.code,
							hasResult: !!job.result,
						}),
					);
					finished = true;
					const value = job.result?.value;
					const correct =
						typeof scenario.expected === "number"
							? typeof value === "number" &&
								Math.abs(value - scenario.expected) < 1e-6
							: value === scenario.expected;
					writeFileSync(
						`${directory}/${index}.json`,
						JSON.stringify({
							key,
							body,
							jobId,
							status: job.status,
							correct,
							value,
							errorCode: job.error?.code,
						}),
						{ mode: 0o600 },
					);
					if (job.status !== "completed" || !correct)
						throw new Error("compute_live_result_failed");
					break;
				}
			}
			if (!finished) {
				await client.cancel(found.url, jobId, AbortSignal.timeout(15000));
				throw new Error("compute_live_follow_timeout");
			}
		}
	}
} catch (e) {
	const code =
		e && typeof e === "object" && "code" in e && typeof e.code === "string"
			? e.code
			: "compute_unavailable";
	console.log(JSON.stringify({ stage: "connection", code }));
	process.exitCode = 1;
}
