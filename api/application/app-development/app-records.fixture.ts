export const readingRequest =
	"読んだ本の題名と感想を記録し、後から感想を編集できるアプリを作ってください";
export const readingNotes = {
	version: 1,
	title: "読書メモ",
	schemas: [
		{
			name: "note",
			schema: {
				type: "object",
				properties: {
					title: {
						type: "string",
						title: "題名",
						minLength: 1,
						maxLength: 120,
					},
					memo: { type: "string", title: "感想", maxLength: 4000 },
				},
				required: ["title"],
				additionalProperties: false,
			},
		},
	],
	storage: {
		version: 1,
		collections: [
			{
				id: "notes",
				schema: "note",
				operations: ["list", "get", "create", "update", "delete"],
			},
		],
	},
	screen: {
		definition: {
			view: "form",
			title: "本を記録",
			fields: [
				{ id: "title", label: "題名", type: "text", required: true },
				{ id: "memo", label: "感想", type: "textarea" },
			],
		},
		storage: { collection: "notes", inputs: { title: "title", memo: "memo" } },
	},
};
