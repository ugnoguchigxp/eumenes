import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import { settingsFixture } from "./fixture";
import { VoiceDevices } from "./voice-devices";

afterEach(cleanup);

const device = (
	kind: MediaDeviceKind,
	deviceId: string,
	label: string,
): MediaDeviceInfo => ({ kind, deviceId, label }) as MediaDeviceInfo;

function setup(
	over: {
		devices?: MediaDeviceInfo[];
		deviceError?: string;
		outputSupported?: boolean;
		mutate?: (s: Settings) => void;
	} = {},
) {
	const value = settingsFixture();
	over.mutate?.(value);
	// Controlled inputs snap back after a change, so apply each update at once.
	const draft = settingsFixture();
	const change = vi.fn((fn: (s: Settings) => void) => fn(draft));
	const discover = vi.fn(async () => {});
	render(
		<VoiceDevices
			value={value}
			change={change}
			devices={over.devices ?? []}
			deviceError={over.deviceError ?? ""}
			discover={discover}
			outputSupported={over.outputSupported ?? true}
		/>,
	);
	const applied = () => draft;
	return { change, discover, applied };
}
const options = (select: HTMLElement) =>
	Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);

test("without any device only the system default is offered, and the error is shown", () => {
	const { discover } = setup({ deviceError: "マイクの許可を確認してください" });
	expect(options(screen.getByLabelText("マイク"))).toEqual(["システム標準"]);
	expect(options(screen.getByLabelText("再生機器"))).toEqual(["システム標準"]);
	expect(screen.getByRole("alert").textContent).toBe(
		"マイクの許可を確認してください",
	);
	fireEvent.click(screen.getByRole("button", { name: "音声機器を確認" }));
	expect(discover).toHaveBeenCalledOnce();
});

test("input and output devices are listed separately, with a fallback label", () => {
	setup({
		devices: [
			device("audioinput", "mic-1", "USBマイク"),
			device("audioinput", "mic-2", ""),
			device("audiooutput", "spk-1", "スピーカー"),
		],
	});
	expect(options(screen.getByLabelText("マイク"))).toEqual([
		"システム標準",
		"USBマイク",
		"マイク",
	]);
	expect(options(screen.getByLabelText("再生機器"))).toEqual([
		"システム標準",
		"スピーカー",
	]);
});

test("choosing devices is reported as a settings change", () => {
	const { applied } = setup({
		devices: [
			device("audioinput", "mic-1", "USBマイク"),
			device("audiooutput", "spk-1", "スピーカー"),
		],
	});
	fireEvent.change(screen.getByLabelText("マイク"), {
		target: { value: "mic-1" },
	});
	fireEvent.change(screen.getByLabelText("再生機器"), {
		target: { value: "spk-1" },
	});
	expect(applied().voice.inputDevice).toBe("mic-1");
	expect(applied().voice.outputDevice).toBe("spk-1");
});

test("a saved device that is no longer present stays visible as unavailable", () => {
	setup({
		devices: [device("audioinput", "mic-1", "USBマイク")],
		mutate: (s) => {
			s.voice.inputDevice = "gone";
			s.voice.outputDevice = "gone-out";
		},
	});
	const mic = screen.getByLabelText("マイク") as HTMLSelectElement;
	expect(mic.value).toBe("gone");
	expect(options(mic)).toContain("選択したマイクを確認できません");
	expect(options(screen.getByLabelText("再生機器"))).toContain(
		"選択した機器を確認できません",
	);
});

test("without output switching support the selector is replaced by an explanation", () => {
	setup({ outputSupported: false });
	expect(screen.queryByLabelText("再生機器")).toBeNull();
	expect(screen.getByText(/再生先の切替に対応していません/)).toBeTruthy();
});
