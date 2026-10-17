import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../service/system-prompt";

// Reviewed TTS instruction fingerprints: preserve persona, names and literal
// placeholder-like input through the TOML compiler.
const cases = [
	{
		input: {
			persona: "butler",
			agentName: "",
			userName: "",
		},
		sha256: "125124fcac0f2d54630d630ccf017018c1c5c5bd4d85e3748e9b3a99626baeb4",
	},
	{
		input: {
			persona: "butler",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "2dd8c33595d58aefc33a8103c8470f962da7fb54cf651b667ebda8a1b3791dc9",
	},
	{
		input: {
			persona: "butler",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "0236d85bf4d462e7aec9d850367a1d8800712e9de12573aec7a2d6dd55cf122c",
	},
	{
		input: {
			persona: "maid",
			agentName: "",
			userName: "",
		},
		sha256: "720ab4615338c4e53d13dc7285b4c1b21e78c0d2ab87f46e3a8ff879c49985fc",
	},
	{
		input: {
			persona: "maid",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "c521514288dfa2413f9c53ac79ba5c4012e1402ee7b5a524bb3900a256056f23",
	},
	{
		input: {
			persona: "maid",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "bb71a56a473e0293f695c09dd7de1372916d2da8236a304a1906475c5b27b257",
	},
	{
		input: {
			persona: "strategist",
			agentName: "",
			userName: "",
		},
		sha256: "75bd2b6e41684c52fcf9492e8ce9609ef61bbb24d3b0955addae419df5416c3c",
	},
	{
		input: {
			persona: "strategist",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "f1aa737a7fd60c4bc21b950b6f96cbe87ab2b915bfdba1e337936ab3fe9cf329",
	},
	{
		input: {
			persona: "strategist",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "baa3cbfc173be2ab4ce41008ab83df4011cbc3bc72218dfb83e3cd1465bd7b8e",
	},
	{
		input: {
			persona: "sage",
			agentName: "",
			userName: "",
		},
		sha256: "56bff7056e73b50d10e118758106dffba907c6221cb690dce579acc01c372e5d",
	},
	{
		input: {
			persona: "sage",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "9618217159f6c6e9b532737636eef9b569a0bb8daf84780ce0257da7b635191e",
	},
	{
		input: {
			persona: "sage",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "5fc44f37294b7160cc1e0992cc1a0a572ba86f380532b92286705fb299115853",
	},
] as const;

test("TOML preserves the conversation instruction bytes for every persona", () => {
	for (const { input, sha256 } of cases) {
		const text = buildSystemPrompt(input);
		expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
	}
});
