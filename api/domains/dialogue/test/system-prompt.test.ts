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
		sha256: "3d0ba9a25118c1f0c5837e0dfa0c3099e28aac9f0c6527cb1a5928a6ef6d7083",
	},
	{
		input: {
			persona: "butler",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "d75cf2634db4edcd063de944e16062e95de462afeb7e0e21d9412831786e8d46",
	},
	{
		input: {
			persona: "butler",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "58365d116b9deefe4b0cba110516e4054ec76b3259f8c4b965dceaa2c44f8698",
	},
	{
		input: {
			persona: "maid",
			agentName: "",
			userName: "",
		},
		sha256: "896c84b30111a7703f4b1df2bc9650f2ceb441c6fcc0a4803efee91d74aa193d",
	},
	{
		input: {
			persona: "maid",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "3af4b2b34f9aa66ae9cfc13730a5d45c2279f6afb452213245495980b2d14d05",
	},
	{
		input: {
			persona: "maid",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "dca5f33e1e46e9a6ada39e74a33e07e0cac1267e39563001b3d135a8f98278f9",
	},
	{
		input: {
			persona: "strategist",
			agentName: "",
			userName: "",
		},
		sha256: "4404f8a68bf30027adc46ff1a72213be110ff09c6796a78db965ab2c7f4d780b",
	},
	{
		input: {
			persona: "strategist",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "3bd49b87ed6db2ff93fd7abe14c63fddc7db7b909061f2bc213773171c64c471",
	},
	{
		input: {
			persona: "strategist",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "692520f46630584b7a1aa8468c850807c299d32d0c4b3b75618d23a2c882181a",
	},
	{
		input: {
			persona: "sage",
			agentName: "",
			userName: "",
		},
		sha256: "097f477c7d8559d2bf08dc896852bc3179550dd267ccd4710d4f21dd6d8fdbdf",
	},
	{
		input: {
			persona: "sage",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "80192ac57f4a410d184f931b61a7417f9fd21645e90dbae234ccce195e2d78c4",
	},
	{
		input: {
			persona: "sage",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "a7c6be5fd599c25ac3ec8f3155f2cd479e6fb5f84b43c24f272b8a34f8045a85",
	},
] as const;

test("TOML preserves the conversation instruction bytes for every persona", () => {
	for (const { input, sha256 } of cases) {
		const text = buildSystemPrompt(input);
		expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
	}
});
