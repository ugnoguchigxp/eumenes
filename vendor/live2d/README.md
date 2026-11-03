# Live2D runtime

Official Cubism SDK for Web **5-r.5**, used only when the Hiyori background is selected.

- Core: `Core/live2dcubismcore.min.js` from https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip, preserved as `web/public/live2d/live2dcubismcore.min.js`. Its header identifies it as Redistributable Code under the Live2D Proprietary Software License.
- Framework: https://github.com/Live2D/CubismWebFramework/tree/5-r.5 (commit prefix `198a376`), bundled without source changes as `framework.js` using `bun build --target browser --format esm --minify`. The exported SDK classes are CubismFramework, CubismMoc, CubismMatrix44, CubismModelMatrix, CubismRenderer_WebGL, CubismShaderManager_WebGL, CubismPhysics and CubismPose, from the corresponding files under `src/`. `framework.d.ts` describes only the public surface consumed here.
- Shaders: the unchanged Framework `Shaders/WebGL/` directory is at `web/public/live2d/shaders/`. They are code, not model assets. The new SDK loads them from that same-origin path on first draw.
- Framework license: `LICENSE.md`, with the full Open Software License in `web/public/live2d/open-license.html`. Full Core and material license documents are adjacent there.
- Local Hiyori data was obtained from CubismWebSamples **5-r.5**, commit `ed1e0b714826d92469b9e51cacc3346f4e393f03`. Model data is excluded from Git; only the installation directory is retained. See `docs/avatar.md` for placement and usage conditions. No model design changes were made.

`assets.json` records source versions and SHA-256 hashes for verifying acquisition, including the ignored local model files. License terms for the runtime and model are separate from Eumenes source licensing. This task does not publish or distribute an application or model.
