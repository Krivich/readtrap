// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright конфиг для "Читаем вместе"
 * 
 * npm test            — запуск всех тестов headless
 * npm run test:ui     — UI режим для отладки
 * npm run dev         — локальный сервер (порт 8080)
 * npm run stress      — стресс-тест с видимым браузером
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
    viewport: { width: 375, height: 812 }, // iPhone размер
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx http-server -p 8081 -c-1 --cors .',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
