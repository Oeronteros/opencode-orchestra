import { defineConfig } from "@playwright/test"
export default defineConfig({ testDir: "./fixtures", testMatch: "browser-regression.spec.ts", workers: 1, reporter: "list", outputDir: "../.orchestra-test-report/browser-e2e", ...(process.env.ORCHESTRA_TEST_CHROME ? { use: { launchOptions: { executablePath: process.env.ORCHESTRA_TEST_CHROME } } } : {}) })
