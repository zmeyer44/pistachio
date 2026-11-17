// A stand-in local web app for the address bar's local-apps specs
// (e2e/tests/local-apps-harness.ts): its own process, run in its own project
// folder, so main reads a project and a server off it as it would off a real
// dev server. argv: <title or ""> <icon colour or ""> <server word>. The last
// is only there for main to recognize ("vite", "next", …); it does nothing.
// Prints the port it took, then serves until killed.
import http from "node:http";

const [title, colour] = process.argv.slice(2);
const icon = colour
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colour}"/><circle cx="16" cy="16" r="7" fill="white" fill-opacity=".9"/></svg>`
  : null;

const server = http.createServer((request, response) => {
  if (request.url === "/icon.svg" && icon !== null) {
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end(icon);
    return;
  }
  if (request.url === "/" || request.url?.startsWith("/?")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const head = `${title ? `<title>${title}</title>` : ""}${icon !== null ? '<link rel="icon" type="image/svg+xml" href="/icon.svg">' : ""}`;
    response.end(`<!doctype html><html><head>${head}</head><body style="font:16px system-ui;padding:40px"><h1>${title || "Untitled app"}</h1></body></html>`);
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", () => console.log(String(server.address().port)));
