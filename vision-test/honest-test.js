/**
 * Vision-тест v2 — честная проверка
 * 
 * Не сверяемся с curriculum.json для оценки правильности.
 * Вместо этого: если кликнул на картинку с alt == слово → должен быть 🎉
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

// Очищаем старые аномалии
fs.writeFileSync(ANOMALIES_FILE, '[]');

function logAnomaly(lessonIdx, description, screenshotPath) {
  const anomalies = JSON.parse(fs.readFileSync(ANOMALIES_FILE, 'utf8'));
  anomalies.push({
    lessonIdx,
    timestamp: new Date().toISOString(),
    description,
    screenshot: screenshotPath
  });
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
 * Честный анализ: вижу слово и картинки, выбираю правильную
 */
async function honestAnalysis(page) {
  const wordText = await (await page.$('#target-word'))?.textContent() || '???';
  
  const cards = await page.$$('.image-card');
  const imageAlts = [];
  for (let i = 0; i < cards.length; i++) {
    const img = await cards[i].$('img');
    imageAlts.push(await img?.getAttribute('alt') || '?');
  }

  // Ищем картинку, alt которой совпадает со словом
  let myChoice = -1;
  for (let i = 0; i < imageAlts.length; i++) {
    if (imageAlts[i].toUpperCase() === wordText.toUpperCase()) {
      myChoice = i;
      break;
    }
  }

  return { wordText, imageAlts, myChoice, cards };
}

async function run(maxLessons = 20) {
  console.log('🚀 Запускаю сервер...');
  
  const server = spawn('npx', ['serve', '-p', '3459'], { 
    cwd: path.join(__dirname, '..'),
    shell: true 
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  const browser = await chromium.launch({ 
    headless: true,
    slowMo: 100 
  });
  
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });
  
  const page = await context.newPage();
  await page.goto('http://localhost:3459');
  await page.waitForTimeout(2000);

  console.log('🎮 Честное тестирование...\n');

  let lessonCount = 0;
  let lessonIdx = 0;

  try {
    while (lessonCount < maxLessons) {
      console.log(`\n--- Урок ${lessonIdx + 1} ---`);

      const screenshotPath = await takeScreenshot(page, `lesson_${lessonIdx}`);
      const analysis = await honestAnalysis(page);

      // Проверяем: есть ли правильная картинка среди вариантов
      if (analysis.myChoice === -1) {
        logAnomaly(lessonIdx, 
          `Слово "${analysis.wordText}" НЕ НАЙДЕНО среди картинок [${analysis.imageAlts.join(', ')}]`,
          screenshotPath);
        // Берём первую как fallback
        analysis.myChoice = 0;
      }

      // Кликаю на свой выбор
      console.log(`  Слово: "${analysis.wordText}" → выбираю карточку ${analysis.myChoice} (${analysis.imageAlts[analysis.myChoice]})`);
      await analysis.cards[analysis.myChoice].click();
      await page.waitForTimeout(1500);

      // Проверяю обратную связь
      const feedbackIcon = await (await page.$('#feedback-icon'))?.textContent() || '';
      
      if (feedbackIcon !== '🎉') {
        logAnomaly(lessonIdx, 
          `Кликнул на "${analysis.imageAlts[analysis.myChoice]}" (совпадает со словом "${analysis.wordText}"), но получил "${feedbackIcon}" вместо 🎉`,
          screenshotPath);
      }

      // Проверяю что правильная карточка подсвечена
      const highlightedCorrect = await page.$('.image-card.correct');
      if (highlightedCorrect) {
        const highlightedIdx = await highlightedCorrect.getAttribute('data-index');
        if (parseInt(highlightedIdx) !== analysis.myChoice) {
          logAnomaly(lessonIdx,
            `Подсвечена карточка ${highlightedIdx}, а я кликнул на ${analysis.myChoice} (правильную)`,
            screenshotPath);
        }
      }

      // Проверяю что НЕправильные НЕ подсвечены зелёным
      const allCorrect = await page.$$('.image-card.correct');
      if (allCorrect.length > 1) {
        logAnomaly(lessonIdx, `Подсвечено ${allCorrect.length} карточек вместо 1`, screenshotPath);
      }

      // Переходим дальше
      const nextBtn = await page.$('#next-btn');
      if (nextBtn && await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      } else {
        // Автопереход при ошибке
        await page.waitForTimeout(2500);
      }

      // Проверяем не game over ли
      const endModal = await page.$('#end-modal:not(.hidden)');
      if (endModal) {
        console.log('  💔 Game Over — сбрасываю и начинаю заново');
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
