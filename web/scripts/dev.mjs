import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, safePath === "/" ? "index.html" : safePath);
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Scope web app: http://127.0.0.1:${port}`);
});

