import { createLarm } from "../../api/domains/larm";
import { resolveLarmToken } from "../../api/infrastructure/auth-config";
import { liveLarmSettings } from "../live-larm";
import {
	TESTER_SYSTEM,
	testerUserText,
	type TesterAdapter,
	type TesterInput,
} from "./tester";

export type LarmTesterRates = {
	/** USD per million tokens. Both default to 0: a local LARM model has no metered price. */
	inUsdPerMTok: number;
	outUsdPerMTok: number;
};

const MAX_OUTPUT_TOKENS = 400;

/**
 * Tester backed by the image-capable LARM model (ornith1.5) through the backend `larm`
 * domain. The connection comes from the saved SQLite settings; the credential never leaves
 * this process and is never printed. The model sees the screenshot as an ordered image part
 * of one user message and nothing else about the product.
 */
export async function createLarmTester(
	rates: LarmTesterRates,
	env = process.env,
): Promise<TesterAdapter> {
	const saved = liveLarmSettings(env);
	const token = resolveLarmToken(env);
	if (!saved.baseUrl) throw new Error("saved_larm_connection_unconfigured");
	if (!token) throw new Error("larm_credential_unconfigured");
	let last = { input: 0, output: 0 };
	let model: string | null = null;
	const larm = createLarm({
		...saved,
		baseUrl: saved.baseUrl,
		voice: saved.voice ?? undefined,
		token,
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			const path = new URL(String(url)).pathname;
			if (response.ok && path.endsWith("/chat/completions")) {
				try {
					const body = (await response.clone().json()) as {
						usage?: { prompt_tokens?: number; completion_tokens?: number };
					};
					last = {
						input: body.usage?.prompt_tokens ?? 0,
						output: body.usage?.completion_tokens ?? 0,
					};
				} catch {
					// usage stays zero; the manifest records that metering was unavailable
				}
			}
			return response;
		},
	});
	await larm.connect();
	const status = larm.status();
	if (status.state !== "ready" || !status.chatInput)
		throw new Error("tester_vision_unavailable");
	return {
		id: "larm:image-input",
		modelId: () =>
			model ??
			larm.inspect?.().providers.find((p) => p.name === "llm")?.model ??
			null,
		async decide(input: TesterInput, signal) {
			last = { input: 0, output: 0 };
			const text = await larm.answer(
				[
					{ role: "system", content: TESTER_SYSTEM },
					{
						role: "user",
						content: testerUserText(input),
						images: [{ ...input.screenshot }],
					},
				],
				signal,
				{ maxOutputTokens: MAX_OUTPUT_TOKENS },
			);
			model =
				larm.inspect?.().providers.find((p) => p.name === "llm")?.model ??
				model;
			return {
				text,
				usage: { inputTokens: last.input, outputTokens: last.output },
				costUSD:
					(last.input * rates.inUsdPerMTok +
						last.output * rates.outUsdPerMTok) /
					1_000_000,
			};
		},
		close: () => larm.close(),
	};
}
