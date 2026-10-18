import type {
	BrowserCaptureItem,
	BrowserTabItem,
	BrowserTaskItem,
} from "./types";

export const sampleTabs: BrowserTabItem[] = [
	{
		tabRef: "t1",
		title: "天気予報",
		url: "https://example.com/weather",
		active: true,
		status: "busy",
		currentTaskLabel: "明日の天気を調べる",
	},
	{
		tabRef: "t2",
		title: "ニュース",
		url: "https://example.com/news",
		active: false,
		status: "open",
	},
	{
		tabRef: "t3",
		title: "フォーム",
		url: "https://example.com/form",
		active: false,
		status: "lost",
	},
	{
		tabRef: "t4",
		title: "旧ページ",
		url: "https://example.com/old",
		active: false,
		status: "closed",
	},
	{
		tabRef: "t5",
		title: "保護されたページ",
		url: "",
		active: false,
		status: "blocked",
	},
];

export const sampleTasks: BrowserTaskItem[] = [
	{ taskId: "k1", requestSummary: "明日の天気を調べる", state: "running" },
	{
		taskId: "k2",
		requestSummary: "ニュースの見出しを読む",
		state: "completed",
		resultSummary: "見出しを3件確認しました。",
	},
	{
		taskId: "k3",
		requestSummary: "フォームに入力する",
		state: "needs_input",
		resultSummary: "住所の入力で止まっています。",
	},
	{ taskId: "k4", requestSummary: "予約を確認する", state: "indeterminate" },
];

export const sampleCaptures: BrowserCaptureItem[] = [
	{
		captureId: "c1",
		range: "viewport",
		capturedAt: "2026-10-18T01:00:00Z",
		width: 1280,
		height: 720,
		bytes: 52_300,
		reductionPercent: 86.4,
		state: "local_ready",
	},
	{
		captureId: "c2",
		range: "full-page",
		capturedAt: "2026-10-18T01:05:00Z",
		width: 1280,
		height: 2400,
		bytes: 0,
		reductionPercent: 0,
		state: "encoding",
	},
	{
		captureId: "c3",
		range: "element",
		capturedAt: "2026-10-18T01:10:00Z",
		width: 300,
		height: 200,
		bytes: 0,
		reductionPercent: 0,
		state: "failed",
	},
];
