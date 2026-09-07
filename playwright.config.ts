import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/client/test",
  workers: 1,
  use: {
    headless: true,
    launchOptions: process.env.RPS_BROWSER_EXECUTABLE || process.platform === "win32" ? {
      executablePath: process.env.RPS_BROWSER_EXECUTABLE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    } : {},
    screenshot: "only-on-failure"
  }
});
