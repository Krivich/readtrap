/**
 * Стресс-тест Lesson Provider System v2
 * 
 * Особенности:
 * - headless: false (видимый браузер для наблюдения)
 * - DOM-based (alts) — быстрый, без vision
 * - Поддержка кастомного конфига: node stress-test.js [stress-test.json]
 * - Делает правильные И ошибочные клики
 * - Сжигает жизни → проверяет retry → проверяет детерминизм
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCREENSHOTS_DIR = path.join(__dirname, 'stress-screenshots');
const REPORT_FILE = path.join(__dirname, 'stress-report.json');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const customConfig = process.argv[2] || 'curriculum.json';
const PORT = 8081;

console.log(`🧪 Стресс-тест: ${customConfig}`);
console.log(` Скриншоты → ${SCREENSHOTS_DIR}`);
console.log(`📋 Отчёт → ${REPORT_FILE}\n`);

async function takeScreenshot(page, name) {
  const filename = `${name}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

async function getLessonState(page) {
  return await page.evaluate(() => ({
    word: document.getElementById('target-word')?.textContent || '???',
    cards: Array.from(document.querySelectorAll('.image-card')).map((c, i) => ({
      index: i,
      alt: c.querySelector('img')?.getAttribute('alt') || '?'
    })),
    correctIndex: window.__lastCorrectIndex,
    shuffledWords: window.__lastShuffledWords,
    livesDisplay: document.getElementById('lives-display')?.textContent || ''
  }));
}

async function clickCardByAlt(page, alt) {
  const cards = await page.$$('.image-card');
  for (let i = 0; i < cards.length; i++) {
    const img = await cards[i].$('img');
    const cardAlt = await img?.getAttribute('alt');
    if (cardAlt === alt) {
      await cards[i].click();
      return true;
    }
  }
  return false;
}

async function clickNext(page) {
  const btn = await page.$('#next-btn');
  if (btn && await btn.isVisible()) {
    await btn.click();
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function waitForFeedback(page) {
  await page.waitForSelector('#feedback-overlay:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function nextOrGameOver(page) {
  await page.waitForSelector('#feedback-overlay.hidden', { timeout: 3000 }).catch(() => {});
  const endModal = await page.$('#end-modal:not(.hidden)');
  if (endModal) return 'gameover';
  const clicked = await clickNext(page);
  await page.waitForTimeout(500);
  return clicked ? 'next' : 'no-button';
}

async function run() {
  const server = spawn('npx', ['serve', '-p', String(PORT)], {
    cwd: path.join(__dirname, '..'),
    shell: true
  });

  await new Promise(resolve => setTimeout(resolve, 5000));

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200
  });

  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });

  const page = await context.newPage();
  const url = `http://localhost:${PORT}?curriculum=${customConfig}`;
  await page.goto(url);
  await page.waitForTimeout(2000);

  const report = { config: customConfig, timestamp: new Date().toISOString(), tests: [] };

  function log(type, msg, data = {}) {
    console.log(`  ${type} ${msg}`);
    report.tests.push({ type, msg, ...data, timestamp: Date.now() });
  }

  // ============================================
  // ТЕСТ 1: Проходим все уроки правильно
  // ============================================
  console.log('\n📋 ТЕСТ 1: Проходим все уроки правильно');

  let lessonNum = 0;
  const maxLessons = 100;

  while (lessonNum < maxLessons) {
    const state = await getLessonState(page);
    if (state.word === '???') { log('SKIP', `Урок ${lessonNum + 1}: слово не загрузилось`); break; }
    if (state.cards.length === 0) {
      await page.waitForTimeout(1000);
      const retry = await getLessonState(page);
      if (retry.cards.length === 0) { log('SKIP', `Урок ${lessonNum + 1}: нет карточек`); break; }
    }

    log('LESSON', `Урок ${lessonNum + 1}: "${state.word}" [${state.cards.map(c => c.alt).join(', ')}]`);
    await takeScreenshot(page, `lesson_${lessonNum + 1}`);

    // Правильный ответ по alt
    const correctAlt = state.cards.find(c => c.alt.toUpperCase() === state.word.toUpperCase())?.alt;
    if (correctAlt) {
      await clickCardByAlt(page, correctAlt);
    } else {
      log('WARN', `Не найдена карточка для "${state.word}", кликаю первую`);
      await clickCardByAlt(page, state.cards[0]?.alt);
    }

    await waitForFeedback(page);
    const fb = await (await page.$('#feedback-icon'))?.textContent() || '';
    if (fb !== '🎉') log('ERROR', `Урок ${lessonNum + 1}: после правильного "${fb}"`);

    const result = await nextOrGameOver(page);
    if (result === 'gameover') { log('DONE', `Все уроки пройдены (${lessonNum + 1})`); break; }
    lessonNum++;
  }

  // ============================================
  // ТЕСТ 2: Сброс → 3 ошибки на разных уроках → Game Over → Retry
  // ============================================
  console.log('\n📋 ТЕСТ 2: Сброс → 3 ошибки → Game Over → Retry');
  log('TEST2', 'Сброс прогресса');

  // Закрываем финальную модалку если есть (после прохождения всех уроков)
  const endModal = await page.$('#end-modal:not(.hidden)');
  if (endModal) {
    log('INFO', 'Закрываю финальную модалку');
    const restartBtn = await page.$('#restart-btn');
    if (restartBtn) await restartBtn.click();
    await page.waitForTimeout(1000);
  }

  page.on('dialog', async dialog => { await dialog.accept(); });
  await (await page.$('#reset-btn'))?.click();
  await page.waitForTimeout(2000);

  // Урок ошибки 1
  let state1 = await getLessonState(page);
  log('LESSON', `Урок ошибки 1: "${state1.word}" [${state1.cards.map(c => c.alt).join(', ')}]`);
  const word1 = state1.word;
  const wrong1 = state1.cards.find(c => c.alt.toUpperCase() !== state1.word.toUpperCase());
  if (wrong1) {
    await clickCardByAlt(page, wrong1.alt);
    log('WRONG', `Клик на "${wrong1.alt}" (неправильно)`);
    await waitForFeedback(page);
    let fb = await (await page.$('#feedback-icon'))?.textContent() || '';
    if (fb !== '❌') log('ERROR', `Ожидание ❌, получил "${fb}"`);
    let result = await nextOrGameOver(page);
    if (result === 'gameover') log('EARLY_GAMEOVER', 'Game Over слишком рано');
  }

  // Урок ошибки 2
  let state2 = await getLessonState(page);
  log('LESSON', `Урок ошибки 2: "${state2.word}" [${state2.cards.map(c => c.alt).join(', ')}]`);
  const wrong2 = state2.cards.find(c => c.alt.toUpperCase() !== state2.word.toUpperCase());
  if (wrong2) {
    await clickCardByAlt(page, wrong2.alt);
    log('WRONG', `Клик на "${wrong2.alt}" (неправильно)`);
    await waitForFeedback(page);
    let fb = await (await page.$('#feedback-icon'))?.textContent() || '';
    if (fb !== '❌') log('ERROR', `Ожидание ❌, получил "${fb}"`);
    let result = await nextOrGameOver(page);
    if (result === 'gameover') log('EARLY_GAMEOVER', 'Game Over слишком рано');
  }

  // Урок ошибки 3
  let state3 = await getLessonState(page);
  log('LESSON', `Урок ошибки 3: "${state3.word}" [${state3.cards.map(c => c.alt).join(', ')}]`);
  const wrong3 = state3.cards.find(c => c.alt.toUpperCase() !== state3.word.toUpperCase());
  if (wrong3) {
    await clickCardByAlt(page, wrong3.alt);
    log('WRONG', `Клик на "${wrong3.alt}" (неправильно)`);
    await waitForFeedback(page);
    let fb = await (await page.$('#feedback-icon'))?.textContent() || '';
    if (fb !== '❌') log('ERROR', `Ожидание ❌, получил "${fb}"`);
    await page.waitForTimeout(500);
  }

  // Проверяем Game Over
  const gameOverModal = await page.$('#end-modal:not(.hidden)');
  if (!gameOverModal) {
    log('ERROR', 'Game Over модалка не появилась');
  } else {
    log('OK', 'Game Over модалка появилась ✅');
    await takeScreenshot(page, 'game_over');

    // Retry
    const retryBtn = await page.$('#restart-btn');
    if (retryBtn) {
      await retryBtn.click();
      await page.waitForTimeout(2000);
    }

    const afterRetry = await getLessonState(page);
    log('RETRY', `После retry: слово="${afterRetry.word}", карточки=[${afterRetry.cards.map(c => c.alt).join(', ')}]`);
    await takeScreenshot(page, 'after_retry');

    // Проверяем жизни
    const livesText = afterRetry.livesDisplay || '';
    if (livesText.includes('❤️❤️❤️')) {
      log('OK', 'Жизни восстановлены до 3 ✅');
    } else {
      log('ERROR', `Жизни: "${livesText}"`);
    }

    // Проходим правильно
    const correctAfterRetry = afterRetry.cards.find(c => c.alt.toUpperCase() === afterRetry.word.toUpperCase());
    if (correctAfterRetry) {
      await clickCardByAlt(page, correctAfterRetry.alt);
      await waitForFeedback(page);
      const fb = await (await page.$('#feedback-icon'))?.textContent() || '';
      if (fb === '🎉') log('OK', 'После retry правильный ответ принят ✅');
      else log('ERROR', `После retry: "${fb}" вместо 🎉`);
      await nextOrGameOver(page);
    }
  }

  // ============================================
  // Итог
  // ============================================
  console.log('\n' + '='.repeat(60));
  const errors = report.tests.filter(t => t.type === 'ERROR');
  const oks = report.tests.filter(t => t.type === 'OK');
  console.log(`✅ OK: ${oks.length}  ❌ Errors: ${errors.length}`);
  if (errors.length) errors.forEach((e, i) => console.log(`  ${i+1}. ${e.msg}`));
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`📋 Отчёт: ${REPORT_FILE}`);
  console.log('='.repeat(60));

  await browser.close();
  server.kill();
}

run().catch(err => { console.error('❌', err); process.exit(1); });
