import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { MusicWorkspace } from "./MusicWorkspace";
import {
	MusicLibraryControls,
	type MusicLibraryFilter,
} from "../MusicLibraryControls";
import { demoAudio } from "../MusicPlayer/demo.fixture";

const meta: Meta<typeof MusicWorkspace> = {
	title: "Components/MusicWorkspace",
	component: MusicWorkspace,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof MusicWorkspace>;
function Demo({ busy = false }: { busy?: boolean }) {
	const [src, setSrc] = useState("");
	const [selected, setSelected] = useState("0");
	const [favorites, setFavorites] = useState<string[]>([]);
	const [filter, setFilter] = useState<MusicLibraryFilter>({
		q: "",
		tags: [],
		sort: "createdAt",
		order: "desc",
	});
	useEffect(() => {
		const url = URL.createObjectURL(demoAudio());
		setSrc(url);
		return () => URL.revokeObjectURL(url);
	}, []);
	const tracks = Array.from({ length: 12 }, (_, i) => ({
		id: String(i),
		title:
			i === 0
				? "Soft electronic instrumental with a simple piano melody and gentle percussion"
				: `テスト曲 ${i + 1}`,
		subtitle: "Storybook用テストトーン",
		durationSeconds: 30,
		favorite: favorites.includes(String(i)),
		tags: ["テスト音源"],
	}));
	const track = tracks.find((t) => t.id === selected);
	return (
		<div style={{ maxWidth: 1100 }}>
			<MusicWorkspace
				tracks={tracks}
				currentTrackId={selected}
				track={src && track ? { ...track, src } : null}
				busy={busy}
				onSelect={setSelected}
				onFavorite={(id, favorite) =>
					setFavorites(
						favorite ? [...favorites, id] : favorites.filter((x) => x !== id),
					)
				}
				controls={
					<MusicLibraryControls
						compact
						filter={filter}
						tags={[{ tag: "テスト音源", count: 12 }]}
						total={12}
						onSearch={setFilter}
						onMore={() => {}}
						onRefresh={() => {}}
					/>
				}
			/>
		</div>
	);
}
export const Desktop: Story = { render: () => <Demo /> };
export const Busy: Story = { render: () => <Demo busy /> };
export const Narrow: Story = {
	render: () => (
		<div style={{ width: 320 }}>
			<Demo />
		</div>
	),
};
export const Empty: Story = {
	args: { tracks: [], track: null, onSelect: () => {} },
};
export const CreateMusic: Story = {
	args: {
		tracks: [],
		track: null,
		onSelect: () => {},
		creation: { onGenerate: () => {} },
	},
	decorators: [
		(Story) => (
			<div style={{ width: "100%", maxWidth: 1400, height: 900 }}>
				<Story />
			</div>
		),
	],
};
