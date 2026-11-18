/**
 * The loopback listener a sign-in comes back to (docs/ai-plans.md §2):
 * `http://127.0.0.1:<port>/auth/callback`, on a port the system picks.
 *
 * Bound to 127.0.0.1 alone — never `localhost`, never every interface — and
 * up only while a sign-in page is out: it answers the one callback (or the
 * wait is given up) and closes. Anything else that reaches it gets a 404;
 * what a callback is worth is decided by its `state`, by the caller.
 *
 * The page it answers with is the last thing the person sees in their
 * browser: whether it worked, and that Pistachio is where to go next. It
 * names nothing from the query.
 */

import { createServer, type Server } from "node:http";
import { CALLBACK_PATH } from "./siwc";

export interface CallbackListener {
  port: number;
  close(): void;
}

/** What the browser is shown once the callback is in. */
export type CallbackOutcome = { ok: true } | { ok: false; message: string };

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

export function callbackPage(outcome: CallbackOutcome): string {
  const title = outcome.ok ? "You're signed in" : "Sign-in didn't finish";
  const body = outcome.ok ? "Pistachio is now using your ChatGPT plan. You can close this tab and go back to Pistachio." : outcome.message;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — Pistachio</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>
`;
}

/**
 * Listen for one callback. `handle` is given its query and answers what the
 * browser is told; it is called for the first request to the callback path
 * and never again.
 */
export function listenForCallback(handle: (search: URLSearchParams) => Promise<CallbackOutcome>): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== CALLBACK_PATH || answered) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      answered = true;
      void handle(url.searchParams)
        .catch((): CallbackOutcome => ({ ok: false, message: "Something went wrong finishing the sign-in. Go back to Pistachio and try again." }))
        .then((outcome) => {
          response.writeHead(outcome.ok ? 200 : 400, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            // The code and state were in this page's address: nothing it loads or links to should learn them.
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(callbackPage(outcome));
          // The one callback is answered: nothing more is expected here.
          server.close();
          server.closeAllConnections();
        });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("the sign-in listener has no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
