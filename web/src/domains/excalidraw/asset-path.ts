// Excalidraw reads this before registering its font faces. All assets are served by Eumenes.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
	"/excalidraw-assets/";
