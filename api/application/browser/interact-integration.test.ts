import { systemContext } from "../../infrastructure/system-context";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../toolchain/toolchain.fixture";
import { buildBrowser } from "./browser-composition";
import { createConversationService } from "../../domains/conversation";
import type { Config } from "../../infrastructure/config";
import { registerBrowser } from "../../domains/browser";
import { fakeInference } from "./browser-task.fixture";
import { until } from "../../domains/browser/test/fakes";
import type { BrowserAssembly } from "./browser-composition";
import { loadInteractRelease } from "./interact-release";
import provenance from "../../../vendor/interact/provenance.json";
import pkg from "../../../package.json";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARTIFACT = "artifact:browser.interact.workspace@1";
const invoke = (tool: string, args: unknown, text: string | null = null) =>
	JSON.stringify({ action: "invoke", tool, arguments: args, text });

test("the Interact archive, adoption patch and installed release match the pinned distribution", () => {
	const vendor = new URL("../../../vendor/interact/", import.meta.url);
	const archive = readFileSync(new URL(provenance.archive, vendor));
	const sha256 = (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex");
	expect(sha256(archive)).toBe(provenance.archiveSha256);
	expect(sha256(readFileSync(new URL("adoption-source.patch", vendor)))).toBe(
		provenance.adoptionSourcePatchSha256,
	);
	expect(pkg.dependencies["eumenes-interact"]).toBe(
		`file:vendor/interact/${provenance.archive}`,
	);
	const lock = readFileSync(
		new URL("../../../bun.lock", import.meta.url),
		"utf8",
	);
	expect(lock).toContain(
		`eumenes-interact@vendor/interact/${provenance.archive}`,
	);
	expect(lock).toContain(
		`sha512-${createHash("sha512").update(archive).digest("base64")}`,
	);
	const release = loadInteractRelease();
	expect(Object.keys(release.manifest.files)).toHaveLength(164);
	expect(systemContext("browser.contexts.interact.skill", {})).toBe(
		release.body,
	);
});

test.skipIf(!existsSync(CHROME))(
	"isolated HTTP pilot uses the common action ledger, real browser, explicit capture approval and authenticated WebP deletion",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "interact-http-"));
		let app: Awaited<ReturnType<typeof harness>>["app"] | undefined;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				return new URL(req.url).pathname === "/fixture"
					? new Response(
							'<!DOCTYPE html><title>Pilot fixture</title><nav>OMIT-NAV</nav><main><h1>Public result</h1><p>Result 42</p><a href="/fixture?choice=1">Unfamiliar choice</a><p style="display:none">OMIT-HIDDEN</p></main>',
							{ headers: { "content-type": "text/html" } },
						)
					: app
						? app.fetch(req)
						: new Response("not ready", { status: 503 });
			},
		});
		const origin = `http://127.0.0.1:${server.port}`;
		const model = fakeInference([
			JSON.stringify({
				action: "reply",
				tool: null,
				arguments: null,
				text: "作業の対象を確認してください。",
			}),
			invoke("page.find", {
				text: null,
				role: null,
				within: null,
				cursor: null,
				inspect: true,
			}),
			invoke("page.read", { target: null, maxChars: 1000 }),
			invoke("page.capture", {
				range: "viewport",
				item: null,
				phase: "prepare",
			}),
			(messages) => {
				const raw = messages.map((m) => m.content).join("\n");
				const token = [...raw.matchAll(/"confirmation":"([^"]+)"/g)].at(
					-1,
				)?.[1];
				if (!token) throw new Error("fixture_confirmation_missing");
				return invoke("page.capture", {
					range: "viewport",
					item: null,
					phase: "save",
					confirmation: token,
					assessment: "The observed viewport contains the fixture result.",
				});
			},
			invoke(
				"done",
				{ evidence: ["r2", "r4"], outcome: "achieved", basis: "observed" },
				"Result 42を確認し、撮影を保存しました。",
			),
			JSON.stringify({
				outcome: "achieved",
				explanation: "Fixture result and capture are observed",
			}),
		]);
		let browser: BrowserAssembly | undefined;
		let h: Awaited<ReturnType<typeof harness>> | undefined;
		const api = async (path: string, input?: unknown) =>
			fetch(origin + path, {
				method: input ? "POST" : "GET",
				headers: {
					authorization: "Bearer fixture-token-for-toolchain-browser",
					...(input ? { "content-type": "application/json" } : {}),
				},
				body: input ? JSON.stringify(input) : undefined,
			});
		try {
			h = await harness({
				browser: (store, queue) =>
					(browser = buildBrowser(
						{ dbPath: join(dir, "db"), origin } as Config,
						{
							core: { store, queue },
							conversation: createConversationService(store),
							inference: model.ports,
						},
					)),
			});
			registerBrowser(h.app, browser!.service, OWNER);
			app = h.app;
			await browser!.service.setting.save(CHROME);
			const registration = (await (
				await api(`/api/toolchain-artifacts/${encodeURIComponent(ARTIFACT)}`)
			).json()) as any;
			expect(registration.artifactRevisionId).toBe(ARTIFACT);
			expect(registration.scopeRef).toBeTruthy();
			expect(
				h.store.read(
					(db) =>
						h!.toolchain.capabilities.instructionInTransaction(
							db,
							loadInteractRelease().skill.ref,
						).body,
				),
			).toBe(loadInteractRelease().body);
			const send = async (
				actionId: string,
				source: string,
				input: unknown,
				revision = 0,
				targetRef?: string,
				eventId = crypto.randomUUID(),
			) => {
				const event = {
					version: 1,
					eventId,
					eventCreatedAt: new Date().toISOString(),
					eventExpiresAt: new Date(Date.now() + 60000).toISOString(),
					artifactId: "browser-interact-pilot",
					artifactRevisionId: ARTIFACT,
					scopeRef: registration.scopeRef,
					source,
					sourceRevision: revision,
					actionId,
					input,
					...(targetRef ? { targetRef } : {}),
				};
				const res = await api("/api/toolchain-actions", event);
				expect(res.status).toBe(200);
				return { event, body: (await res.json()) as any };
			};
			const start = await send("start", "setup", {
				request:
					"ページのResult 42を読み、画像を保存してください。PRIVATE-REQUEST-MARKER",
				url: origin + "/fixture?token=PRIVATE-URL-MARKER",
				conversationId: "main",
			});
			expect(start.body.status).toBe("accepted");
			const storedInput = h.store.read((db) =>
				db
					.query(
						"SELECT canonical_input_json FROM tool_action_requests WHERE event_id=?",
					)
					.get(start.event.eventId),
			);
			expect(JSON.stringify(storedInput)).not.toContain(
				"PRIVATE-REQUEST-MARKER",
			);
			expect(JSON.stringify(storedInput)).not.toContain("PRIVATE-URL-MARKER");
			const runId = start.body.result.receipt.runId as string;
			// The principal is issued by the host; use its public constant below, rather than trusting event input.
			const status = () =>
				h!.store.read((db) =>
					browser!.interact!.statusInTransaction(db, OWNER, "main", runId),
				);
			await until(() => status().state === "needs_input", { timeout: 20000 });
			const textQuestion = status();
			expect(textQuestion.question?.kind).toBe("text");
			const clarified = await send(
				"answer",
				"reply",
				{
					runId,
					conversationId: "main",
					questionId: textQuestion.question!.id,
					generation: String(textQuestion.generation),
					expectedRevision: String(textQuestion.revision),
					text: "PRIVATE-ANSWER-MARKER",
				},
				textQuestion.revision,
				runId,
			);
			expect(clarified.body.status).toBe("accepted");
			const storedAnswer = h.store.read((db) =>
				db
					.query(
						"SELECT canonical_input_json FROM tool_action_requests WHERE event_id=?",
					)
					.get(clarified.event.eventId),
			);
			expect(JSON.stringify(storedAnswer)).not.toContain(
				"PRIVATE-ANSWER-MARKER",
			);
			await until(
				() =>
					status().state === "needs_input" &&
					status().question?.id !== textQuestion.question!.id,
				{ timeout: 20000 },
			);
			const q = status();
			expect(q.question?.kind).toBe("capture");
			const readResult = model.state.calls[3]!.find(
				(m) =>
					m.content.startsWith("PART_RESULT=") &&
					m.content.includes('"part":"page.read"'),
			)!.content;
			expect(readResult).toContain("Result 42");
			expect(readResult).not.toContain("OMIT-HIDDEN");
			const answer = await send(
				"answer",
				"reply",
				{
					runId,
					conversationId: "main",
					questionId: q.question!.id,
					generation: String(q.generation),
					expectedRevision: String(q.revision),
					decision: "allow",
				},
				q.revision,
				runId,
			);
			expect(answer.body.status).toBe("accepted");
			await until(() => status().state === "completed", { timeout: 20000 });
			const end = status();
			expect(end.calls).toBe(7);
			expect(end.captures).toHaveLength(1);
			const image = await api(
				`/api/browser/captures/${end.captures[0]!.captureId}/content`,
			);
			expect(image.status).toBe(200);
			expect(image.headers.get("content-type")).toContain("image/webp");
			expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
			const denied = await fetch(
				origin + `/api/browser/captures/${end.captures[0]!.captureId}/content`,
			);
			expect(denied.status).toBe(401);
			const old = await send(
				"answer",
				"reply",
				answer.event.input,
				q.revision,
				runId,
			);
			expect(old.body.status).toBe("rejected");
			const forgotten = await send(
				"forget",
				"forget",
				{ confirmed: true },
				end.revision,
				runId,
			);
			expect(forgotten.body.status).toBe("accepted");
			const replay = await api("/api/toolchain-actions", forgotten.event);
			expect(((await replay.json()) as any).status).toBe("accepted");
			expect(replay.headers.get("idempotent-replay")).toBe("true");
			const gone = await api(
				`/api/browser/captures/${end.captures[0]!.captureId}/content`,
			);
			expect(gone.status).toBe(404);
			expect(model.state.subjects).toHaveLength(7);
			expect(
				model.state.sessions.every((s: any) => s.sessionRole === "auxiliary"),
			).toBe(true);
		} finally {
			await browser?.close();
			await h?.close();
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	},
	60000,
);
import { CONVERSATION_DEFAULT_PRINCIPAL as OWNER } from "../../domains/conversation/contracts";
