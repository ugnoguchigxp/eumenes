/** Stroke paths (24px grid) of the icon each kind of resource is drawn with. */
const ICONS: Record<string, string> = {
	image: "M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9.5h.01",
	music:
		"M9 18V6l10-2v12 M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
	cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9",
	draw: "M4 20l4-1 11-11a2 2 0 0 0-3-3L5 16z M14 7l3 3",
	screen: "M4 5h16v14H4z M4 9h16 M9 9v10",
	document: "M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7",
	calculator:
		"M6 3h12v18H6z M9 7h6 M9 12h.01 M12 12h.01 M15 12h.01 M9 16h.01 M12 16h.01 M15 16h.01",
	camera:
		"M4 8h4l2-3h4l2 3h4v11H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
	flow: "M4 5h6v4H4z M14 15h6v4h-6z M7 9v4a2 2 0 0 0 2 2h5",
	code: "M9 8l-5 4 5 4 M15 8l5 4-5 4 M13.5 5l-3 14",
	list: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
	chat: "M4 5h16v11H9l-5 4z",
	file: "M6 3h9l4 4v14H6z M14 3v5h5",
};

const ICON_OF_KIND: Record<string, keyof typeof ICONS> = {
	image: "image",
	"music.track": "music",
	"music.playlist": "music",
	"model3d.asset": "cube",
	drawing: "draw",
	"ui.composition": "screen",
	report: "document",
	"compute.result": "calculator",
	capture: "camera",
	document: "document",
	pipeline: "flow",
	"code.task": "code",
	todo: "list",
	event: "chat",
};

export function KindIcon({ kind }: { kind: string }) {
	const path = ICONS[ICON_OF_KIND[kind] ?? "file"];
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
