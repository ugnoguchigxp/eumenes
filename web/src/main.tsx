import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./design-system/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
