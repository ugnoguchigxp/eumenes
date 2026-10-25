import { mkdirSync, writeFileSync } from "node:fs";
import { readStoredLarm } from "../api/domains/settings";
import {
	readApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";

/** Explicit acceptance only. Never prints/saves a ticket, cookie, credential or upstream body. */
async function main() {
	const args = process.argv.slice(2),
		negative = args.includes("--negative");
	if (!negative && !args.includes("--check"))
		throw new Error("docling_live_mode_required");
	const value = (name: string, fallback: string) =>
		args.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) ??
		fallback;
	const api = new URL(value("--api", "http://127.0.0.1:8787"));
	if (
		api.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(api.hostname) ||
		api.username ||
		api.password
	)
		throw new Error("docling_live_api_invalid");
	const dbPath = value(
		"--db",
		process.env.EUMENES_DB || "./data/eumenes.sqlite3",
	);
	const saved = readStoredLarm(dbPath),
		credential = resolveLarmToken(process.env);
	if (!saved.baseUrl || !credential)
		throw new Error("docling_live_unconfigured");
	const auth = {
		Authorization: `Bearer ${readApiToken({ ...process.env, EUMENES_DB: dbPath })}`,
	};
	const output: Record<string, unknown> = {
		checkedAt: new Date().toISOString(),
		mode: negative ? "negative-acceptance" : "read-only",
		apiOrigin: api.origin,
	};
	const request = (url: URL | string, init: RequestInit = {}) =>
		fetch(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(200_000),
		});
	const setting = await request(new URL("/api/settings/docling", api), {
		headers: auth,
	});
	if (!setting.ok) throw new Error("docling_live_settings_failed");
	const connection = (await setting.json()) as {
		gatewayUrl: string;
		publicOrigin: string;
	};
	if (!connection.gatewayUrl || !connection.publicOrigin)
		throw new Error("docling_live_gateway_missing");
	const gateway = (path: string, init: RequestInit = {}) =>
		request(new URL(path, connection.gatewayUrl), {
			...init,
			headers: {
				Authorization: `Bearer ${credential}`,
				Host: "127.0.0.1:28765",
				...init.headers,
			},
		});
	const state = async () => {
		const r = await request(
			new URL("/v1/local-services/docling-desk", saved.baseUrl!),
			{ headers: { Authorization: `Bearer ${credential}` } },
		);
		if (!r.ok) throw new Error("docling_live_control_failed");
		const v = await r.json();
		return { state: v.state, generation: v.generation };
	};
	output.service = await state();
	const health = await request(new URL("/health/live", connection.gatewayUrl));
	output.gatewayHealth = health.status;
	await health.body?.cancel();
	const directory = "spec/verification/docling-desk-2026-10-25";
	const save = () => {
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			`${directory}/${negative ? "live-negative" : "live-status"}.json`,
			JSON.stringify(output, null, 2) + "\n",
		);
	};
	if (negative) {
		const wrong = await request(
			new URL("/auth/ui-tickets", connection.gatewayUrl),
			{
				method: "POST",
				headers: {
					Authorization: "Bearer acceptance-invalid-credential",
					Host: "127.0.0.1:28765",
				},
			},
		);
		output.invalidAuthStatus = wrong.status;
		await wrong.body?.cancel();
		if (![401, 403].includes(wrong.status))
			throw new Error("docling_live_auth_check_failed");
		const ticket = async () => {
			const r = await request(new URL("/api/docling/ui-tickets", api), {
				method: "POST",
				headers: auth,
			});
			if (!r.ok) throw new Error("docling_live_ticket_failed");
			const v = (await r.json()) as { url: string; expiresIn: number };
			if (new URL(v.url).origin !== connection.publicOrigin)
				throw new Error("docling_live_origin_failed");
			return v;
		};
		// A separate test ticket, never the URL opened for the user's browser.
		const first = await ticket(),
			exchanged = await request(first.url);
		const cookie = exchanged.headers.get("set-cookie") ?? "";
		output.exchangeStatus = exchanged.status;
		output.cookieAttributes = {
			secure: /;\s*Secure/i.test(cookie),
			httpOnly: /;\s*HttpOnly/i.test(cookie),
			sameSiteNone: /;\s*SameSite=None/i.test(cookie),
		};
		await exchanged.body?.cancel();
		const repeated = await request(first.url);
		output.reusedTicketStatus = repeated.status;
		await repeated.body?.cancel();
		if (
			exchanged.status !== 303 ||
			repeated.status !== 401 ||
			!Object.values(output.cookieAttributes as Record<string, boolean>).every(
				Boolean,
			)
		)
			throw new Error("docling_live_exchange_check_failed");
		const expired = await ticket();
		console.log(JSON.stringify({ phase: "ticket-expiry-window", seconds: 61 }));
		await Bun.sleep(30_000);
		await Bun.sleep(31_000);
		const elapsed = await request(expired.url);
		output.expiredTicketStatus = elapsed.status;
		await elapsed.body?.cancel();
		if (elapsed.status !== 401)
			throw new Error("docling_live_expiry_check_failed");
		const upload = async (name: string, bytes: Uint8Array) => {
			const form = new FormData();
			form.append("file", new File([new Uint8Array(bytes).buffer], name));
			form.append("ocr_provider", "disabled");
			return gateway("/api/upload", { method: "POST", body: form });
		};
		const oversized = await upload(
			"acceptance-limit.pdf",
			new Uint8Array(50 * 1024 ** 2 + 1),
		);
		output.oversizedUploadStatus = oversized.status;
		await oversized.body?.cancel();
		if (oversized.status !== 413)
			throw new Error("docling_live_upload_limit_failed");
		const cases = [
			{
				name: "acceptance-failed.pdf",
				text: "%PDF-1.7\ninvalid acceptance fixture\n",
				expected: "failed",
			},
			{
				name: "acceptance-partial.tex",
				text: "\\documentclass{article}\n\\begin{document}\nEUMENES DOCLING PARTIAL ACCEPTANCE\n\\end{document}\n",
				expected: "partial",
			},
		];
		const jobs: unknown[] = [];
		for (const entry of cases) {
			const r = await upload(entry.name, new TextEncoder().encode(entry.text));
			if (r.status !== 202) throw new Error("docling_live_upload_rejected");
			const job = (await r.json()) as { id: string };
			if (!/^[a-f0-9]{32}$/.test(job.id))
				throw new Error("docling_live_job_invalid");
			let terminal = false;
			for (let i = 0; i < 60; i++) {
				const poll = await gateway(`/api/jobs/${job.id}`),
					current = await poll.json();
				if (["success", "partial", "failed"].includes(current.state)) {
					jobs.push({
						id: job.id,
						name: entry.name,
						expected: entry.expected,
						state: current.state,
						hasError: !!current.error,
						warningCount: current.warnings?.length ?? 0,
						hasTexError: !!current.tex_error,
					});
					if (current.state !== entry.expected)
						throw new Error("docling_live_job_outcome_unexpected");
					terminal = true;
					break;
				}
				await Bun.sleep(1000);
			}
			if (!terminal) throw new Error("docling_live_job_timeout");
		}
		output.jobs = jobs;
	}
	save();
	console.log(JSON.stringify(output));
}
main().catch((error: unknown) => {
	console.error(
		error instanceof Error && /^docling_live_[a-z_]+$/.test(error.message)
			? error.message
			: "docling_live_failed",
	);
	process.exitCode = 1;
});
