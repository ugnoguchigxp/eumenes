import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { createClient } from "../../client";
import { createAudioStore } from "./domains/audio";
import { Workspace } from "./workspace/Workspace";
import { drawingLocation } from "./domains/excalidraw/location";

const DrawingEditor = lazy(() => import("./domains/excalidraw/DrawingEditor"));
export function App() {
	const [hash, setHash] = useState(window.location.hash);
	useEffect(() => {
		const change = () => setHash(window.location.hash);
		window.addEventListener("hashchange", change);
		return () => window.removeEventListener("hashchange", change);
	}, []);
	const drawing = drawingLocation(hash);
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { refetchOnWindowFocus: true, staleTime: 2_000 },
				},
			}),
	);
	const [store] = useState(() => createAudioStore());
	const [client] = useState(() => createClient(window.location.origin));
	return (
		<QueryClientProvider client={queryClient}>
			<Suspense fallback={<p role="status">編集画面を読み込み中です。</p>}>
				{drawing ? (
					<DrawingEditor
						key={hash}
						client={client}
						referenceId={drawing.referenceId}
						revision={drawing.revision}
						conversationId={drawing.conversationId}
					/>
				) : (
					<Workspace client={client} store={store} />
				)}
			</Suspense>
		</QueryClientProvider>
	);
}
