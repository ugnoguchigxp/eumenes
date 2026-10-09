import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../../client";
import { settingsFixture } from "./fixture";
import { VoiceSection } from "./voice";

afterEach(cleanup);
test("voice section renders the speech and device cards", async () => {
	const client = {
		identity: "voice-section",
		larmVoices: vi.fn(async () => {
			throw new Error("catalog_unavailable");
		}),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<VoiceSection
				client={client}
				value={settingsFixture()}
				saved={settingsFixture()}
				change={vi.fn()}
				larmChanged={false}
				usage={{ data: [] } as never}
				devices={[]}
				deviceError=""
				discover={vi.fn(async () => {})}
				outputSupported={false}
			/>
		</QueryClientProvider>,
	);
	expect(screen.getByText("アバターの読み上げ音声")).toBeTruthy();
	expect(screen.getByText("声での会話")).toBeTruthy();
	cache.clear();
});
