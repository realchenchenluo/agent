import backend, { ReviewService } from "./worker.js";

export { ReviewService };

export default {
  async fetch(request, env, ctx) {
    if (!new URL(request.url).pathname.startsWith("/api/mot/"))
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    return backend.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx) { return backend.scheduled(event, env, ctx); }
};
