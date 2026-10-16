import { harness } from "../api/application/toolchain/toolchain.fixture";

const h = await harness({
	uiCompositions: true,
	uiDesignOutput: {
		title: "来場者アンケート",
		description: "イベントのご感想をお聞かせください。",
		fields: [
			{ id: "name", label: "お名前", type: "text", required: true },
			{
				id: "rating",
				label: "満足度",
				type: "radio",
				required: true,
				options: ["満足", "普通", "不満"],
			},
			{
				id: "interests",
				label: "興味のあるテーマ",
				type: "checkbox",
				required: true,
				options: ["技術", "デザイン"],
			},
			{ id: "comment", label: "感想", type: "textarea", required: false },
		],
	},
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
