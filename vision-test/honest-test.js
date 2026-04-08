/**
 * Vision-тест v3 — с проверкой по window.__lastCorrectIndex
 *
 * Цикл:
 * 1. Честно выбираю ответ по alt картинки (не зная curriculum)
 * 2. Кликаю
 * 3. Читаю window.__lastCorrectIndex (правильный индекс после шафла)
 * 4. Сверяю: правильная картинка, ловушки, подсветка
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const ANOMALIES_FILE = path.join(__dirname, 'anomalies.json');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

fs.writeFileSync(ANOMALIES_FILE, '[]');

function logAnomaly(lessonIdx, description, screenshotPath) {
  const anomalies = JSON.parse(fs.readFileSync(ANOMALIES_FILE, 'utf8'));
  anomalies.push({ lessonIdx, timestamp: new Date().toISOString(), description, screenshot: screenshotPath });
  fs.writeFileSync(ANOMALIES_FILE, JSON.stringify(anomalies, null, 2));
  console.log(`  ⚠️ АНОМАЛИЯ: ${description}`);
}

async function takeScreenshot(page, name) {
  const filename = `${name}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

/**
 * Честный выбор: вижу слово и картинки, выбираю по alt
 */
async function honestChoice(page) {
  const wordText = await (await page.$('#target-word'))?.textContent() || '???';
  const cards = await page.$$('.image-card');
  const imageAlts = [];
  for (let i = 0; i < cards.length; i++) {
    const img = await cards[i].$('img');
    imageAlts.push(await img?.getAttribute('alt') || '?');
  }

  let myChoice = -1;
  for (let i = 0; i < imageAlts.length; i++) {
    if (imageAlts[i].toUpperCase() === wordText.toUpperCase()) {
      myChoice = i;
      break;
    }
  }

  return { wordText, imageAlts, myChoice, cards };
}

/**
 * Читаю последний shuffle-лог из window
 */
async function getLastShuffleLog(page) {
  return await page.evaluate(() => ({
    correctIndex: window.__lastCorrectIndex,
    targetWord: window.__lastTargetWord,
    shuffledWords: window.__lastShuffledWords
  }));
}

async function run(maxLessons = 50) {
  console.log('🚀 Запускаю сервер...');

  const server = spawn('npx', ['serve', '-p', '3461'], {
    cwd: path.join(__dirname, '..'),
    shell: true
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });

  const page = await context.newPage();
  await page.goto('http://localhost:3461');
  await page.waitForTimeout(2000);

  // Загружаем curriculum.json локально для сверки ловушек
  const curriculum = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'curriculum.json'), 'utf8')
  );

  console.log('🎮 Честное тестирование с проверкой shuffle-лога...\n');

  let lessonCount = 0;
  let lessonIdx = 0;

  try {
    while (lessonCount < maxLessons) {
      console.log(`\n--- Урок ${lessonIdx + 1} ---`);

      const screenshotPath = await takeScreenshot(page, `lesson_${lessonIdx}`);

      // ШАГ 1: Честный выбор (не зная curriculum)
      const choice = await honestChoice(page);

      // ШАГ 2: Кликаю
      console.log(`  Слово: "${choice.wordText}" → выбираю карточку ${choice.myChoice} (${choice.imageAlts[choice.myChoice]})`);

      if (choice.myChoice === -1) {
        logAnomaly(lessonIdx,
          `Слово "${choice.wordText}" НЕ НАЙДЕНО среди [${choice.imageAlts.join(', ')}]`,
          screenshotPath);
        choice.myChoice = 0;
      }

      await choice.cards[choice.myChoice].click();
      await page.waitForTimeout(1500);

      // ШАГ 3: Читаю shuffle-лог из window
      const log = await getLastShuffleLog(page);

      if (log.correctIndex === undefined) {
        logAnomaly(lessonIdx, 'Нет данных в __lastCorrectIndex', screenshotPath);
        continue;
      }

      console.log(`  Shuffle: правильный индекс=${log.correctIndex} (${log.shuffledWords?.[log.correctIndex]})`);

      // ШАГ 4: Проверяю обратную связь
      const feedbackIcon = await (await page.$('#feedback-icon'))?.textContent() || '';

      if (choice.myChoice === log.correctIndex && feedbackIcon !== '🎉') {
        logAnomaly(lessonIdx,
          `Кликнул правильно (${choice.myChoice}), но получил "${feedbackIcon}" вместо 🎉`,
          screenshotPath);
      }

      if (choice.myChoice !== log.correctIndex && feedbackIcon !== '❌') {
        logAnomaly(lessonIdx,
          `Кликнул неправильно, но получил "${feedbackIcon}" вместо ❌`,
          screenshotPath);
      }

      // ШАГ 5: Проверяю подсветку
      const highlightedCorrect = await page.$$('.image-card.correct');
      if (highlightedCorrect.length !== 1) {
        logAnomaly(lessonIdx, `Подсвечено ${highlightedCorrect.length} карточек вместо 1`, screenshotPath);
      } else {
        const highlightedIdx = await highlightedCorrect[0].getAttribute('data-index');
        if (parseInt(highlightedIdx) !== log.correctIndex) {
          logAnomaly(lessonIdx,
            `Подсвечена карточка ${highlightedIdx}, а правильный=${log.correctIndex}`,
            screenshotPath);
        }
      }

      // ШАГ 6: Проверяю ловушки — все картинки из curriculum
      // Определяем глобальный индекс урока
      let globalLessonIdx = lessonIdx;
      let stageIdx = 0;
      let localLessonIdx = lessonIdx;
      for (const stage of curriculum.stages) {
        if (localLessonIdx < stage.lessons.length) break;
        localLessonIdx -= stage.lessons.length;
        stageIdx++;
      }

      if (stageIdx < curriculum.stages.length && localLessonIdx < curriculum.stages[stageIdx].lessons.length) {
        const expectedWords = new Set(
          curriculum.stages[stageIdx].lessons[localLessonIdx].runtime.image_words
        );
        for (const alt of choice.imageAlts) {
          if (!expectedWords.has(alt)) {
            logAnomaly(lessonIdx,
              `Картинка "${alt}" не в curriculum: ожидаемые [${[...expectedWords].join(', ')}]`,
              screenshotPath);
          }
        }
      }

      // Переходим дальше — ждём скрытия оверлея, потом «Дальше»
      await page.waitForSelector('#feedback-overlay.hidden', { timeout: 5000 }).catch(() => {});

      const nextBtn = await page.$('#next-btn');
      if (nextBtn && await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      } else {
        await page.waitForTimeout(2500);
      }

      // Game over?
      const endModal = await page.$('#end-modal:not(.hidden)');
      if (endModal) {
        console.log('  💔 Game Over — сброс');
        page.on('dialog', async dialog => await dialog.accept());
        await (await page.$('#reset-btn'))?.click();
        await page.waitForTimeout(2000);
        lessonCount = 0;
        lessonIdx = 0;
        continue;
      }

      lessonIdx++;
      lessonCount++;
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ ТЕСТ ЗАВЕРШЁН!');
    const anomalies = JSON.parse(fs.readFileSync(ANOMALIES_FILE, 'utf8'));
    console.log(`⚠️ Найдено аномалий: ${anomalies.length}`);
    anomalies.forEach((a, i) => {
      console.log(`  ${i + 1}. Урок ${a.lessonIdx + 1}: ${a.description}`);
    });
    console.log('='.repeat(60));

  } catch (err) {
    console.error('❌ Ошибка:', err);
  } finally {
    server.kill();
    await browser.close();
  }
}

run().catch(console.error);
