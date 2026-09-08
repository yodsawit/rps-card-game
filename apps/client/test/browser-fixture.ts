import { createApplication, type ApplicationDependencies } from "../src/application.js";
import { MatchLogView } from "../src/views/match-log.js";
import { browserClock } from "../src/clock.js";
import type { MatchSnapshot, ServerSnapshot } from "@rps/protocol";

const emitted: unknown[][] = [];
const effectEvents: unknown[][] = [];
const audioPageEvents: number[] = [];
const handlers = new Map<string, (...args: any[]) => void>();
const intervals = new Set<number>();
const clock = {
  ...browserClock,
  setInterval(callback: () => void, delay: number) {
    const id = browserClock.setInterval(callback, delay);
    intervals.add(id);
    return id;
  },
  clearInterval(id: number) { intervals.delete(id); browserClock.clearInterval(id); }
};
const socket = {
  on(event: string, handler: (...args: any[]) => void) { handlers.set(event, handler); },
  emit(...args: unknown[]) { emitted.push(args); },
  removeAllListeners() { handlers.clear(); },
  disconnect() {}
};
const client = createApplication({
  clock,
  app: document.querySelector<HTMLDivElement>("#app")!,
  toast: document.querySelector<HTMLDivElement>("#toast")!,
  socket: socket as unknown as ApplicationDependencies["socket"],
  effects: { events: { emit(...args: unknown[]) { effectEvents.push(args); } } } as unknown as ApplicationDependencies["effects"],
  audio: new Proxy({}, {
    get: (_target, property) => property === "setMusicVolumeScale"
      ? (scale: number) => audioPageEvents.push(scale)
      : () => {}
  }) as ApplicationDependencies["audio"]
});
const fixture = {
  snapshot: null as ServerSnapshot | null,
  connect() { handlers.get("connect")?.(); },
  openTutorial() { (client as unknown as { openTutorial(): void }).openTutorial(); },
  render() { handlers.get("state:snapshot")!(this.snapshot); },
  matchLogOverlay(view: MatchSnapshot) { return new MatchLogView().render(view); },
  dispose() { client.dispose(); },
  resources() { return { intervals: intervals.size, listeners: handlers.size }; }
};
Object.assign(globalThis, { emitted, effectEvents, audioPageEvents, reviewClient: fixture });
