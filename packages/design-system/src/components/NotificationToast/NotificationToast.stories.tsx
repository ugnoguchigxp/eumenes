import type { Meta, StoryObj } from "@storybook/react-vite";

import { NotificationToast } from "./NotificationToast";

const meta: Meta<typeof NotificationToast> = {
	title: "Components/NotificationToast",
	component: NotificationToast,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{ padding: "2rem", backgroundColor: "hsl(var(--background))" }}
				>
					<Story />
				</div>
			</>
		),
	],
	args: {
		type: "info",
		title: "システム情報",
		message: "定期メンテナンスが予定されています（明日 2:00-4:00）",
		showCloseButton: true,
	},
};

export default meta;

type Story = StoryObj<typeof NotificationToast>;

export const Info: Story = {};

export const Success: Story = {
	args: {
		type: "success",
		title: "完了",
		message: "保存しました",
	},
};

export const Warning: Story = {
	args: {
		type: "warning",
		title: "注意",
		message: "入力内容を確認してください",
	},
};

export const ErrorToast: Story = {
	args: {
		type: "error",
		title: "エラー",
		message: "サーバーとの通信に失敗しました",
	},
};

export const WithLink: Story = {
	args: {
		type: "info",
		title: "新しい通知",
		message: "詳細を確認してください",
		linkLabel: "詳細を見る",
		onClickLink: () => {},
	},
};
