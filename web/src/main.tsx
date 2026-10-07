import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@eumenes/design-system/styles";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
