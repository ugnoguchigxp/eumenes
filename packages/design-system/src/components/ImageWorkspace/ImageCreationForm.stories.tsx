import type { Meta, StoryObj } from "@storybook/react";
import { ImageCreationForm } from "./ImageCreationForm";
const meta = {
	title: "Artifacts/ImageCreationForm",
	component: ImageCreationForm,
	args: {
		initialValues: {
			prompt: "",
			width: 768,
			height: 512,
			format: "png",
			seed: 42,
		},
		onGenerate: () => {},
	},
} satisfies Meta<typeof ImageCreationForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Choices: Story = {};
export const EditedPrompt: Story = {
	args: {
		initialValues: {
			prompt: "自由に入力した画像の希望",
			width: 768,
			height: 512,
			format: "png",
			seed: 42,
		},
	},
};
