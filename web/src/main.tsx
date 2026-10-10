import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@eumenes/design-system/styles";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");
createRoot(root).render(
	<StrictMode>
		<ErrorBoundary label="app">
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
