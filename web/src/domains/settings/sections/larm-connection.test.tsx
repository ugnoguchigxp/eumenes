import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import { settingsFixture } from "./fixture";
import { LarmConnectionCard } from "./larm-connection";

afterEach(cleanup);

function setup(
	over: {
		dirty?: boolean;
		details?: unknown;
		mutate?: (s: Settings) => void;
	} = {},
) {
	const value = settingsFixture();
	over.mutate?.(value);
	const draft = settingsFixture();
	draft.larm.baseUrl = "http://127.0.0.1:8080";
	const change = vi.fn((fn: (s: Settings) => void) => fn(draft));
	const probe = vi.fn(async () => {});
	render(
		<LarmConnectionCard
			value={value}
			change={change}
			dirty={over.dirty ?? false}
			details={(over.details ?? { data: undefined }) as never}
			probe={probe}
		/>,
	);
	return { change, probe, draft };
}

test("while the provider details are unknown, only the form and the check button show", () => {
	setup();
	expect((screen.getByLabelText("Profile") as HTMLInputElement).value).toBe(
		"SAAA-gemma4-26b",
	);
	expect((screen.getByLabelText("LARMのURL") as HTMLInputElement).value).toBe(
		"",
	);
	expect(screen.queryByText(/会話:/)).toBeNull();
	expect(
		(
			screen.getByRole("button", { name: "LARMの接続を確認" }) as HTMLElement
		).hasAttribute("disabled"),
	).toBe(false);
});

test("the configured URL and each provider the LARM reports are listed", () => {
	setup({
		mutate: (s) => {
			s.larm.baseUrl = "http://127.0.0.1:8080";
		},
		details: {
			data: {
				profile: "SAAA-gemma4-26b",
				providers: [
					{
						name: "llm",
						model: "gemma-4",
						baseUrl: "http://127.0.0.1:8080/v1",
						protocol: "openai",
					},
					{
						name: "tts",
						model: "voice-1",
						baseUrl: "http://127.0.0.1:8081",
						protocol: "openai",
					},
				],
			},
		},
	});
	expect((screen.getByLabelText("LARMのURL") as HTMLInputElement).value).toBe(
		"http://127.0.0.1:8080",
	);
	expect(screen.getByText(/会話: gemma-4/)).toBeTruthy();
	expect(screen.getByText(/読み上げ: voice-1/)).toBeTruthy();
	expect(screen.getByText("http://127.0.0.1:8080/v1")).toBeTruthy();
});

test("unsaved changes disable the connection check; otherwise it probes larm", () => {
	const dirty = setup({ dirty: true });
	const button = screen.getByRole("button", { name: "LARMの接続を確認" });
	expect((button as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(button);
	expect(dirty.probe).not.toHaveBeenCalled();
	cleanup();

	const clean = setup({ dirty: false });
	fireEvent.click(screen.getByRole("button", { name: "LARMの接続を確認" }));
	expect(clean.probe).toHaveBeenCalledWith("larm");
});

test("clearing the URL field stores null so the backend default is used", () => {
	const { draft } = setup({
		mutate: (s) => {
			s.larm.baseUrl = "http://127.0.0.1:8080";
		},
	});
	fireEvent.change(screen.getByLabelText("LARMのURL"), {
		target: { value: "" },
	});
	expect(draft.larm.baseUrl).toBeNull();
});
