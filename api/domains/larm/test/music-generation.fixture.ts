export const musicProviderFixture = {
	providers: [
		{
			id: "local-audio",
			models: [
				{
					id: "fixture-bgm",
					task: "music" as const,
					defaultDurationSeconds: 120,
					maxDurationSeconds: 120,
				},
				{
					id: "fixture-vocal",
					task: "vocals" as const,
					defaultDurationSeconds: 180,
					maxDurationSeconds: 600,
				},
				{
					id: "fixture-sfx",
					task: "sound-effect" as const,
					defaultDurationSeconds: 5,
					maxDurationSeconds: 120,
				},
			],
		},
	],
};
