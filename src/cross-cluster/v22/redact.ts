/**
 * cross-cluster/v22/redact.ts
 *
 * Error text from the RPC / fetch stack can embed the request URL, including `?api-key=<secret>`. v2.2 error text
 * reaches logs AND `/health` (`jobs.*.lastError`, `layoutProblems`), and /health binds 0.0.0.0 with no auth (#205),
 * so every v2.2 string goes through this redactor first.
 *
 * GH#225: the path is dropped as well as the query. Helius carries its key in the query
 * (`?api-key=`), but Alchemy (`/v2/<key>`), QuickNode (`/<token>/`), Ankr (`/solana/<key>`) and
 * Triton (`/<key>`) all carry it in the PATH, so keeping `url.pathname` published the credential
 * verbatim. Host and scheme are enough to identify an endpoint in a log; no path segment of an RPC
 * URL is diagnostic enough to be worth a secret.
 */
export function redactErrorText(s: string, max = 160): string {
  return s
    .replace(/(api[-_]?key|apikey|token|secret|auth)=[^&\s"')]+/gi, "$1=***")
    .replace(/https?:\/\/[^\s"')]+/gi, (u) => {
      try {
        const url = new URL(u);
        return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : "/***"}${url.search ? "?***" : ""}`;
      } catch {
        return "<url>";
      }
    })
    .slice(0, max);
}
