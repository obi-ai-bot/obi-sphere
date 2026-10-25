// What the Sphere's Durable Objects (src/doorbell.ts, src/relay.ts) take from workerd, in one Node
// process: `cloudflare:workers`' DurableObject (main.ts resolves that import to this file),
// WebSocketPair, a Response that carries a WebSocket, the Hibernation API's calls on `ctx`, storage,
// alarms, and the namespaces the routes reach the objects through. Each object is one instance in
// memory, made the first time it's asked for. A restart closes every socket, and sockets are what
// an object's storage and alarms are about, so those stay in memory too.

const OPEN = 1;
const CLOSED = 3;

type Data = string | ArrayBuffer;
type Happening = { kind: "message"; data: Data } | { kind: "close"; code: number; reason: string };

const copy = (data: ArrayBuffer | ArrayBufferView): ArrayBuffer =>
  data instanceof ArrayBuffer ? data.slice(0) : (new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer as ArrayBuffer);

/** One end of a WebSocketPair. */
export class PairedSocket extends EventTarget {
  peer!: PairedSocket;
  readyState = OPEN;
  /** The object's state, once it took this end with `ctx.acceptWebSocket`: its handlers get what arrives. */
  state: State | null = null;
  private attachment: unknown = null;
  /** What arrived before anyone accepted this end, given out once someone does and has added listeners. */
  private queue: Happening[] | null = [];

  accept(): void {
    const queued = this.queue ?? [];
    this.queue = null;
    queueMicrotask(() => queued.forEach((h) => this.dispatch(h)));
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== OPEN) return;
    this.peer.deliver({ kind: "message", data: typeof data === "string" ? data : copy(data) });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSED;
    this.state?.drop(this);
    this.peer.deliver({ kind: "close", code, reason });
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  deliver(h: Happening): void {
    if (h.kind === "close") {
      if (this.readyState !== OPEN) return;
      this.readyState = CLOSED;
      this.state?.drop(this);
    }
    if (this.state) this.state.received(this, h);
    else if (this.queue) this.queue.push(h);
    else this.dispatch(h);
  }

  private dispatch(h: Happening): void {
    if (h.kind === "message") this.dispatchEvent(new MessageEvent("message", { data: h.data }));
    else this.dispatchEvent(Object.assign(new Event("close"), { code: h.code, reason: h.reason, wasClean: true }));
  }
}

export class WebSocketPair {
  0: PairedSocket;
  1: PairedSocket;
  constructor() {
    this[0] = new PairedSocket();
    this[1] = new PairedSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

export class WebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

/** workerd's Response takes status 101 with the WebSocket to hand over; Node's refuses any status under 200. */
class WorkerResponse extends Response {
  readonly webSocket: PairedSocket | null;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: PairedSocket | null }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.webSocket = init?.webSocket ?? null;
    if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
  }
}

Object.assign(globalThis, { WebSocketPair, WebSocketRequestResponsePair, Response: WorkerResponse });

interface Handlers {
  fetch(request: Request): Promise<Response> | Response;
  webSocketMessage?(ws: PairedSocket, message: Data): Promise<void> | void;
  webSocketClose?(ws: PairedSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void;
  alarm?(): Promise<void> | void;
}

const failed = (what: string) => (e: unknown) => console.error(`sphere: a Durable Object's ${what} failed`, e instanceof Error ? e.name : typeof e);

class Storage {
  private values = new Map<string, unknown>();
  private alarmAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly state: State;
  constructor(state: State) {
    this.state = state;
  }

  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    for (const [k, v] of typeof key === "string" ? [[key, value] as const] : Object.entries(key)) this.values.set(k, structuredClone(v));
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    clearTimeout(this.timer);
    const when = Number(at);
    this.alarmAt = when;
    this.timer = setTimeout(() => {
      this.alarmAt = null;
      Promise.resolve(this.state.object.alarm?.()).catch(failed("alarm"));
    }, Math.max(0, when - Date.now()));
    this.timer.unref();
  }
}

/** An object's `ctx`: its sockets with their tags, the auto-response, and its storage. */
export class State {
  object!: Handlers;
  readonly storage = new Storage(this);
  private sockets = new Map<PairedSocket, string[]>();
  private auto: WebSocketRequestResponsePair | null = null;
  private autoAt = new WeakMap<PairedSocket, Date>();

  acceptWebSocket(ws: PairedSocket, tags: string[] = []): void {
    ws.state = this;
    this.sockets.set(ws, tags);
  }

  getWebSockets(tag?: string): PairedSocket[] {
    return [...this.sockets].filter(([, tags]) => tag === undefined || tags.includes(tag)).map(([ws]) => ws);
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void {
    this.auto = pair ?? null;
  }

  getWebSocketAutoResponseTimestamp(ws: PairedSocket): Date | null {
    return this.autoAt.get(ws) ?? null;
  }

  drop(ws: PairedSocket): void {
    this.sockets.delete(ws);
  }

  received(ws: PairedSocket, h: Happening): void {
    if (h.kind === "message" && this.auto && h.data === this.auto.request) {
      this.autoAt.set(ws, new Date());
      return ws.send(this.auto.response);
    }
    const done = h.kind === "message" ? this.object.webSocketMessage?.(ws, h.data) : this.object.webSocketClose?.(ws, h.code, h.reason, true);
    Promise.resolve(done).catch(failed("WebSocket handler"));
  }
}

/** `cloudflare:workers`' base class: the object's `ctx` and `env`. */
export class DurableObject<Env = unknown> {
  readonly ctx: State;
  readonly env: Env;
  constructor(ctx: State, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * A Durable Object namespace: `get(idFromName(name))` is a stub whose `fetch` and methods reach the
 * one instance for that name, asynchronously, as RPC does.
 * ponytail: instances are never evicted; there is one per Obi that polled (the Doorbells) and one
 * per phone relay, each a few hundred bytes without sockets. Evict idle ones if that ever adds up.
 */
export function namespace(Class: new (ctx: State, env: never) => Handlers, env: unknown) {
  const objects = new Map<string, Handlers>();
  return {
    idFromName: (name: string) => name,
    get(id: string) {
      let o = objects.get(id);
      if (!o) {
        const state = new State();
        objects.set(id, (o = state.object = new Class(state, env as never)));
      }
      const object = o as unknown as Record<string, (...args: unknown[]) => unknown>;
      return new Proxy({}, {
        get: (_, prop: string) =>
          prop === "then" ? undefined : prop === "fetch" ? async (url: string, init?: RequestInit) => o.fetch(new Request(url, init)) : async (...args: unknown[]) => object[prop]!(...args),
      });
    },
  };
}
