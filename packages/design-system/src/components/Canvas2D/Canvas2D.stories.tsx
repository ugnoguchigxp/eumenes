import type { Meta, StoryObj } from "@storybook/react-vite";
import { Canvas2D } from "./Canvas2D";

const meta: Meta<typeof Canvas2D> = {
	title: "Components/Canvas2D",
	component: Canvas2D,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Canvas2D>;

export const Grid: Story = {
	args: {
		ariaLabel: "任意の大きさの2Dグリッド",
		viewport: { x: 0, y: 0, width: 12, height: 8 },
		pixelated: true,
		draw: (context, { viewport }) => {
			context.fillStyle = "#152134";
			context.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
			context.strokeStyle = "#60748f";
			context.lineWidth = 0.025;
			for (let x = 0; x <= viewport.width; x++) {
				context.beginPath();
				context.moveTo(x, 0);
				context.lineTo(x, viewport.height);
				context.stroke();
			}
			for (let y = 0; y <= viewport.height; y++) {
				context.beginPath();
				context.moveTo(0, y);
				context.lineTo(viewport.width, y);
				context.stroke();
			}
			context.fillStyle = "#70d6b0";
			context.fillRect(3, 2, 1, 1);
		},
	},
};

export const MovingCamera: Story = {
	args: {
		ariaLabel: "移動する2Dカメラの例",
		viewport: { x: 0, y: 0, width: 16, height: 9 },
		playing: true,
		draw: (context, { viewport, elapsedMs }) => {
			const cameraX = elapsedMs / 500;
			context.fillStyle = "#13263e";
			context.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
			context.fillStyle = "#3f8f74";
			for (let x = 0; x < 64; x += 2) {
				const screenX = x - (cameraX % 2);
				context.fillRect(screenX, 7, 1, 2);
			}
			context.fillStyle = "#f7c66b";
			context.fillRect(5, 5, 1, 2);
		},
	},
};
