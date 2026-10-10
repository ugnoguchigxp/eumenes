import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SamplePlayer } from "./shared";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function setup() {
	const create = vi.fn(() => "blob:sample");
	const revoke = vi.fn();
	Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const client = {
		voiceSample: vi.fn(async () => new Uint8Array([1, 2, 3])),
	};
	const view = render(
		<SamplePlayer client={client as never} voice={{} as never} />,
	);
	return { revoke, view };
}

test("stopping playback revokes the blob URL", async () => {
	const { revoke } = setup();
	fireEvent.click(screen.getByText("サンプルを再生"));
	fireEvent.click(await screen.findByText("サンプルを停止"));
	expect(revoke).toHaveBeenCalledWith("blob:sample");
});

test("unmounting during playback revokes the blob URL", async () => {
	const { revoke, view } = setup();
	fireEvent.click(screen.getByText("サンプルを再生"));
	await screen.findByText("サンプルを停止");
	view.unmount();
	expect(revoke).toHaveBeenCalledWith("blob:sample");
});
