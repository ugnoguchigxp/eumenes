import { expect, test } from "bun:test";
import { duckDuckGo } from "llm-fetch";
import { createWebAcquisition } from "..";
import { submitResearchSchema } from "../contracts";

for (const [language, region, locale] of [
	["ja", undefined, "jp-jp"],
	["en", undefined, "us-en"],
	["fr", undefined, "fr-fr"],
	["en", "GB", "uk-en"],
] as const)
	test(`omitted regions use the provider's language default; explicit regions survive: ${language}/${region ?? "omitted"}`, async () => {
		const urls: string[] = [];
		const search = duckDuckGo({
			fetch: Object.assign(
				async (input: string | URL | Request) => {
					urls.push(String(input));
					throw new Error("fixture stops before external network");
				},
				{ preconnect: () => {} },
			),
		});
		const acquisition = createWebAcquisition({ search });
		try {
			const request = submitResearchSchema.parse({
				requestId: crypto.randomUUID(),
				operation: "lookup",
				query: "public release information",
				language,
				...(region ? { region } : {}),
			});
			await expect(
				acquisition.execute(request, AbortSignal.timeout(2000)),
			).rejects.toMatchObject({ code: "UPSTREAM_HTTP" });
			expect(urls.length).toBeGreaterThan(0);
			expect(new URL(urls[0]!).searchParams.get("kl")).toBe(locale);
		} finally {
			await acquisition.close();
		}
	});
