import { build } from "vite";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const outDir = resolve("../_ai_context/submission/offline-sandbox");
await build({ configFile: false, root: resolve("scripts/offline"), base: "./", publicDir: false, resolve: { alias: { "@": resolve("src") } }, esbuild: { jsx: "automatic" }, build: { outDir, emptyOutDir: true, target: "es2022" } });
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "START.ps1"), 'Set-Location -LiteralPath $PSScriptRoot\npython -m http.server 4173 --bind 127.0.0.1\n');
await writeFile(resolve(outDir, "README.txt"), "PulseGrid offline synthetic sandbox\nTeaching model, not clinical software.\nNo npm install, cloud accounts, venue Wi-Fi or internet needed at runtime.\nRequires an installed Python 3 and a browser with Web Workers.\nWindows: right-click START.ps1 and Run with PowerShell, or run:\n  python -m http.server 4173 --bind 127.0.0.1 --directory <this folder>\nOpen http://127.0.0.1:4173 . Keep the local server running. Ctrl+C stops it.\nDo not open index.html using file:// because module workers need HTTP.\nMap, Inventory, Match Lab, Code Red and Blood Weather use the application components.\nSwitch scenes to reset transient state; map configuration persists.\nNo live registry, identity, durable workflow, push or hosted outage proof is included.\nThe recorded demo and report are sibling submission artifacts.\n");
