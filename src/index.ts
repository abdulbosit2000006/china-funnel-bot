import { createApp } from "./app";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch: (request, env) => app.fetch(request, env),
  scheduled: (controller, env) => app.scheduled(controller, env),
} satisfies ExportedHandler<Env>;
