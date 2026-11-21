export const embeddingProvider = {
	name: "embedding",
	protocol: "larm.embedding.v1",
	endpoint: "/v1/embed",
	model: "ruri-v3-130m",
	embeddingSpace: {
		contractVersion: "embedding-space.v1",
		workload: "search",
		model: {
			id: "cl-nagoya/ruri-v3-130m",
			revision: "e3114c6ee10dbab8b4b235fbc6dcf9dd4d5ac1a6",
			artifactDigest: "artifact",
		},
		dimension: 512,
		inputTypes: ["query", "passage"],
		prefixes: { query: "検索クエリ: ", passage: "検索文書: " },
		normalization: "l2",
		tokenization: {
			kind: "sentencepiece-unigram",
			tokenizerDigest: "tokenizer",
			maxTokens: 8192,
			truncation: "end",
			pooling: "mean",
			extra: "retained",
		},
	},
};
