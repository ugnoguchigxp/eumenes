import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=", "base64");
export const gravity = `
import { useEffect, useRef, useState } from "react";
import { Color, BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { World, Body, Vec3 } from "cannon-es";
import { mount, type Adapter } from "eumenes-prototype/app";
import "./style.css";

function App({ adapter }: { adapter: Adapter }) {
 const canvas = useRef<HTMLCanvasElement>(null);
 const state = useRef<HTMLOutputElement>(null);
 const [setting, setSetting] = useState(() => localStorage.getItem("project-setting") || "empty");
 useEffect(() => {
  const scene = new Scene();
  scene.background = new Color("#1b3548");
  const camera = new PerspectiveCamera(50, 1, 0.1, 50);
  camera.position.set(2, 2, 4);
  camera.lookAt(0, 0, 0);
  const cube = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({color:"#fab05c"}));
  scene.add(cube);
  const gravity = new World({gravity: new Vec3(0, -9.81, 0)});
  gravity.addBody(new Body({mass:1}));
  gravity.step(1/60);
  try {
   const renderer = new WebGLRenderer({canvas: canvas.current!});
   renderer.setSize(180, 180, false);
   renderer.render(scene, camera);
   canvas.current!.dataset.rendered = "yes";
  } catch {}
  void new GLTFLoader().loadAsync(adapter.asset("assets/block.gltf")).then(() => {
   state.current!.textContent = "GLTF + texture ready";
  });
 }, [adapter]);
 return <main><h1>Gravity 1</h1><p>{adapter.mode}</p><canvas ref={canvas}></canvas>
  <img src={adapter.asset("assets/texture.png")} alt="Block texture" />
  <output ref={state} /><button onClick={() => {
   localStorage.setItem("project-setting", "block setting");
   setSetting("block setting");
  }}>Save setting</button><p id="setting">{setting}</p></main>;
}
mount(({ adapter, root }) => root.render(<App adapter={adapter} />));
`;

export const gallery = `
import { mount } from "eumenes-prototype/app";
import "./style.css";
mount(({ adapter, root }) => root.render(<main><h1>Image board 1</h1><p>{adapter.mode}</p>
 <img src={adapter.asset("assets/texture.png")} alt="Example from gallery" />
 <button onClick={() => { localStorage.setItem("project-setting", "gallery setting"); document.querySelector("#setting")!.textContent = "gallery setting"; }}>Save setting</button>
 <p id="setting">{localStorage.getItem("project-setting") || "empty"}</p></main>));
`;

export function fixtureSources(root: string, entry: string) {
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "assets"), { recursive: true });
	writeFileSync(join(root, "src", "main.tsx"), entry);
	writeFileSync(join(root, "src", "style.css"), "h1 { color: rgb(23, 119, 96); } img { width: 30px; height: 30px; }");
	writeFileSync(join(root, "assets", "texture.png"), pixel);
	writeFileSync(join(root, "assets", "block.gltf"), JSON.stringify({ asset: { version: "2.0" }, scenes: [{}], scene: 0 }));
}
