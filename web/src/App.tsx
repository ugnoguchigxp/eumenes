import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createClient } from "../../client";
import { createAudioStore } from "./domains/audio";
import { Workspace } from "./workspace/Workspace";

export function App() {
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
			<Workspace client={client} store={store} />
		</QueryClientProvider>
	);
}
