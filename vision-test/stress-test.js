/**
 * Быстрый стресс-тест — минимальные таймауты, мгновенный фэйл
 * 
 * Использование: node vision-test/stress-test.js [config|scientific]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCREENSHOTS_DIR = path.join(__dirname, 'stress-screenshots');
const REPORT_FILE = path.join(__dirname, 'stress-report.json');
const PORT = 8081;

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const customConfig = process.argv[2] || 'curriculum.json';

async function run() {
  const server = spawn('npx', ['http-server', '-p', String(PORT), '-c-1', '--cors', '.'], {
    cwd: path.join(__dirname, '..'), shell: true
  });
  await new Promise(r => setTimeout(r, 2000));

  const browser = await chromium.launch({ headless: false, slowMo: 500 }); // Замедляем для наблюдения
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });

  // Включаем логирование кликов для отладки
  page.on('console', msg => console.log(`📢 [Browser] ${msg.text()}`));

  // Перехват ошибок в консоли
  const errors = [];
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') errors.push(text);
    logs.push(text);
  });
  page.on('pageerror', err => errors.push(err.message));

  let url = customConfig === 'scientific'
    ? `http://localhost:${PORT}?level=scientific`
    : `http://localhost:${PORT}?curriculum=${customConfig}`;

  console.log(`🧪 Тест: ${customConfig} | ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

  // Ждём пока слово загрузится (не "Загрузка..." и не "❌")
  // Для scientific провайдера может потребоваться больше времени на загрузку манифеста
  const loadTimeout = customConfig === 'scientific' ? 15000 : 5000;
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('target-word');
      return el && el.textContent !== 'Загрузка...' && !el.textContent.includes('❌');
    }, { timeout: loadTimeout });
  } catch (e) {
    // Выводим диагностику
    const wordText = await page.$eval('#target-word', el => el.textContent).catch(() => 'N/A');
    const pageContent = await page.content();
    console.log(`❌ Таймаут загрузки. Слово: "${wordText}"`);
    if (pageContent.includes('error') || pageContent.includes('Error')) {
      console.log('⚠️ На странице есть ошибки');
    }
    return kill();
  }

  // Фильтруем ошибки: игнорируем favicon и картинки (они fallback'аются)
  const criticalErrors = errors.filter(e => 
    !e.includes('favicon') && 
    !e.includes('icon') && 
    !e.includes('Failed to load resource') // картинки с 404 fallback'аются в SVG
  );
  if (criticalErrors.length) { console.log(`❌ Ошибка загрузки: ${criticalErrors[0]}`); return kill(); }
  console.log('✅ Игра загрузилась');

  // Выведем первые 5 логов для диагностики
  console.log(`📜 Логи: ${logs.slice(0, 5).join(' | ')}`);

  // Проверка: есть ли карточки на первом уроке
  const initialCards = await page.$$('.image-card');
  console.log(`📊 Карточек на старте: ${initialCards.length}`);
  if (initialCards.length === 0) {
    const wordText = await page.$eval('#target-word', el => el.textContent);
    console.log(`❌ Нет карточек! Слово: "${wordText}"`);
    return kill();
  }

  // Проверка видимости карточек
  const firstCardBox = await initialCards[0].boundingBox();
  console.log(`📐 Первая карточка: x=${firstCardBox?.x}, y=${firstCardBox?.y}, w=${firstCardBox?.width}, h=${firstCardBox?.height}`);
  const viewport = page.viewportSize();
  console.log(`📺 Viewport: ${viewport?.width}x${viewport?.height}`);
  if (firstCardBox && firstCardBox.y > viewport.height) {
    console.log(`⚠️ Карточка ниже viewport! Скроллю...`);
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // Проходим уроки
  let passed = 0, failed = 0;
  const maxLessons = parseInt(process.env.MAX_LESSONS) || 15;

  for (let i = 0; i < maxLessons; i++) {
    // Фильтруем критические ошибки (игнорируем 404 картинок и favicon)
    const criticalErrors = errors.filter(e => 
      !e.includes('favicon') && 
      !e.includes('icon') && 
      !e.includes('Failed to load resource')
    );
    if (criticalErrors.length) { console.log(`❌ Краш на уроке ${i + 1}: ${criticalErrors[criticalErrors.length - 1]}`); break; }

    // Проверяем, не закончился ли курс
    const endModal = await page.$('#end-modal:not(.hidden)');
    if (endModal) {
      console.log(`🏁 Курс завершён после ${passed} уроков`);
      break;
    }

    const word = await page.$eval('#target-word', el => el.textContent);
    if (word.includes('❌') || word === 'Загрузка...') {
      console.log(`❌ Ошибка на уроке ${i + 1}: "${word}"`);
      break;
    }

    const cards = await page.$$('.image-card');

    // Проверка: 4 карточки
    if (cards.length !== 4) {
      console.log(`❌ Урок ${i + 1} ("${word}"): ${cards.length} карточек вместо 4`);
      failed++;
      break;
    }

    // Находим правильную карточку по alt
    let correctIdx = -1;
    const alts = [];
    for (let j = 0; j < cards.length; j++) {
      const alt = await cards[j].$eval('img', img => img.alt);
      alts.push(alt);
      if (alt.toUpperCase() === word.toUpperCase()) correctIdx = j;
    }

    if (correctIdx === -1) {
      console.log(`❌ Урок ${i + 1} ("${word}"): не найдена карточка среди [${alts.join(', ')}]`);
      failed++;
      break;
    }

    // Скроллим и кликаем через JS (overlay не блокирует)
    await cards[correctIdx].scrollIntoViewIfNeeded();
    await page.evaluate((idx) => {
      document.querySelectorAll('.image-card')[idx]?.click();
    }, correctIdx);

    // Ждём фидбек (макс 3 сек)
    await page.waitForSelector('#feedback-overlay:not(.hidden)', { timeout: 3000 }).catch(() => {});
    const fb = await page.$eval('#feedback-icon', el => el.textContent).catch(() => '?');

    if (fb !== '🎉') {
      console.log(`❌ Урок ${i + 1}: после правильного ответа иконка="${fb}"`);
      failed++;
      break;
    }

    // Ждём кнопку "Дальше" и кликаем через JS
    console.log(`🔍 [Test] Ищу кнопку #next-btn...`);
    await page.waitForSelector('#next-btn', { state: 'visible', timeout: 3000 }).catch(() => {});
    const hasButton = await page.$('#next-btn');
    console.log(`🔍 [Test] Кнопка найдена?`, !!hasButton);
    
    // Запоминаем слово ДО клика
    const wordBefore = await page.$eval('#target-word', el => el.textContent);
    console.log(`📝 [Test] Слово ДО клика: "${wordBefore}"`);

    if (hasButton) {
      console.log(`🔍 [Test] Пробую прямой вызов nextLesson()...`);
      const wordBefore = await page.$eval('#target-word', el => el.textContent);
      console.log(`📝 [Test] Слово ДО: "${wordBefore}"`);
      
      // Вызываем функцию напрямую, минуя DOM-клик
      await page.evaluate(() => {
        if (window.nextLesson) window.nextLesson();
        else document.getElementById('next-btn')?.click();
      });
      
      // Ждем изменения слова
      try {
        await page.waitForFunction((oldWord) => {
          const current = document.getElementById('target-word').textContent;
          return current !== oldWord && current !== 'Loading...';
        }, { timeout: 5000 }, wordBefore);
        
        const wordAfter = await page.$eval('#target-word', el => el.textContent);
        console.log(`✅ [Test] Урок сменился! Было: "${wordBefore}", Стало: "${wordAfter}"`);
      } catch (e) {
        console.log(`❌ [Test] ОШИБКА: Слово НЕ сменилось! Всё ещё "${wordBefore}"`);
        failed++;
        break;
      }
    } else {
      // Проверяем game over, если кнопки нет
      const endModal = await page.$('#end-modal:not(.hidden)');
      if (endModal) {
        console.log(`🏁 Game Over после ${passed} уроков`);
        break;
      }
    }

    await page.waitForTimeout(100);
    passed++;

    if (passed % 10 === 0) console.log(`  → пройдено ${passed} уроков...`);
  }

  console.log(`📊 Итог: ${passed} уроков пройдено, ${failed} ошибок`);
  if (errors.length) console.log(`⚠️ Ошибки: ${errors.slice(-3).join(' | ')}`);
  if (logs.length > 5) console.log(`📜 Логи: ${logs.slice(-5).join(' | ')}`);

  kill();

  function kill() {
    server.kill();
    browser.close();
  }
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
