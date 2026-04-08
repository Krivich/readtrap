/**
 * Быстрый тест: открыть игру, сделать скриншот, вывести информацию
 */

const { chromium } = require('playwright');
const path = require('path');
const { exec } = require('child_process');

async function quickTest() {
  console.log('🚀 Запускаю локальный сервер...');

  // Запускаем serve в фоне
  const server = exec('npx serve -p 3456', { cwd: path.join(__dirname, '..') });
  
  // Ждём пока сервер поднимется
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('🚀 Открываю игру...');

  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 300 
  });
  
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });
  
  const page = await context.newPage();

  await page.goto('http://localhost:3456');
  
  // Ждём загрузку
  await page.waitForTimeout(3000);

  // Скриншот
  const screenshotPath = path.join(__dirname, 'first-lesson.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`📸 Скриншот: ${screenshotPath}`);

  // Собираем информацию о карточках
  const cards = await page.$$('.image-card');
  console.log(`\nНайдено карточек: ${cards.length}`);

  for (let i = 0; i < cards.length; i++) {
    const img = await cards[i].$('img');
    const src = await img?.getAttribute('src');
    const alt = await img?.getAttribute('alt');
    console.log(`  Карточка ${i}: alt="${alt}", src="${src}"`);
  }

  // Слово
  const word = await page.$('#target-word');
  const wordText = await word?.textContent();
  console.log(`\nСлово: ${wordText}`);

  // Уровень
  const level = await page.$('#level-display');
  const levelText = await level?.textContent();
  console.log(`Уровень: ${levelText}`);

  console.log('\n✅ Готово! Теперь ты можешь проанализировать скриншот');
  
  server.kill();
  await browser.close();
}

quickTest().catch(console.error);
