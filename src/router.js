export function createRouter({ routes, fallback }) {
  return async function dispatch(req, res) {
    const route = routes.find((candidate) => candidate.match(req));
    try {
      if (route) return await route.handler(req, res);
      return await fallback(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message || "Internal server error" }));
      } else {
        res.destroy(error);
      }
    }
  };
}
