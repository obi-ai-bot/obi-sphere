// The Worker's entry: `handle` (src/app.ts) on the real clock.

import { handle } from "./app.ts";
import type { Env } from "./env.ts";

export { ChannelRelay } from "./channel.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { now: () => Date.now() });
  },
} satisfies ExportedHandler<Env>;
