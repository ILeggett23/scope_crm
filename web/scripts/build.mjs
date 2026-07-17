import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const path of ["index.html", "styles.css", "src", "assets", "manifest.webmanifest"]) {
  await cp(resolve(root, path), resolve(dist, path), { recursive: true });
}
console.log("Built Scope web app to web/dist");

