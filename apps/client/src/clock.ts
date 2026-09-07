/** Injectable clock for animation sequences and server countdowns. */
export const browserClock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  setTimeout: (callback: () => void, delay = 0): number => window.setTimeout(callback, delay),
  clearTimeout: (timer: number): void => window.clearTimeout(timer),
  setInterval: (callback: () => void, delay: number): number => window.setInterval(callback, delay),
  clearInterval: (timer: number): void => window.clearInterval(timer)
};
