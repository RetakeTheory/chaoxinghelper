export function secureQueryResponse(url: URL, response: Response) {
  if (!(url.pathname === "/query" || url.pathname.startsWith("/query/") || url.pathname.startsWith("/api/query/"))) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  // A restrictive framing policy does not break the existing map/script loaders.
  headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (url.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=15552000");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
