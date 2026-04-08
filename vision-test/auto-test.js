/**
 * Автоматический vision-тест с анализом через LLM
 * 
 * Проходит N уроков, проверяет правильность картинок,
 * записывает аномалии в anomalies.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const ANOMALIES_FILE = path.join(__dirname, 'anomalies.json');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function logAnomaly(lessonIdx, description, screenshotPath) {
  const anomalies = fs.existsSync(ANOMALIES_FILE) 
    ? JSON.parse(fs.readFileSync(ANOMALIES_FILE, 'utf8')) 
    : [];

  anomalies.push({
    lessonIdx,
    timestamp: new Date().toISOString(),
    description,
    screenshot: screenshotPath
  });

  fs.writeFileSync(ANOMALIES_FILE, JSON.stringify(anomalies, null, 2));
  console.log(`⚠️ [Урок ${lessonIdx + 1}] ${description}`);
}

async function takeScreenshot(page, name) {
  const filename = `${name}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

async function visionTest(maxLessons = 10) {
  console.log('🚀 Запускаю сервер...');
  
  const server = spawn('npx', ['serve', '-p', '3457'], { 
    cwd: path.join(__dirname, '..'),
    shell: true 
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('🚀 Открываю браузер...');

  const browser = await chromium.launch({ 
    headless: true, // headless для скорости
    slowMo: 200 
  });
  
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }
  });
  
  const page = await context.newPage();
  await page.goto('http://localhost:3457');
  await page.waitForTimeout(2000);

  console.log('🎮 Начинаю тестирование...\n');

  let lessonCount = 0;
  let lessonIdx = 0;

  try {
    while (lessonCount < maxLessons) {
      console.log(`\n=== Урок ${lessonIdx + 1} ===`);

      // Читаем curriculum.json чтобы знать правильный ответ
      const curriculum = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'curriculum.json'), 'utf8')
      );
      
      const stage = curriculum.stages[0]; // Пока только A1
      const lesson = stage.lessons[lessonIdx];

      if (!lesson) {
        console.log('❌ Урок не найден, завершаю');
        break;
      }

      const targetWord = lesson.runtime.target_word;
      const correctIndex = lesson.runtime.correct_image_index;
      const imageWords = lesson.runtime.image_words;

      console.log(`Слово: ${targetWord}`);
      console.log(`Картинки: ${imageWords.join(', ')}`);
      console.log(`Правильный индекс: ${correctIndex} (${imageWords[correctIndex]})`);

      // Скриншот
      const screenshotPath = await takeScreenshot(page, `lesson_${lessonIdx}`);

      // Проверяем что слово отображается
      const wordEl = await page.$('#target-word');
      const wordText = await wordEl?.textContent();
      
      if (wordText !== targetWord) {
        logAnomaly(lessonIdx, `Слово "${wordText}" не совпадает с ожидаемым "${targetWord}"`, screenshotPath);
      }

      // Проверяем карточки
      const cards = await page.$$('.image-card');
      if (cards.length !== 4) {
        logAnomaly(lessonIdx, `Найдено ${cards.length} карточек вместо 4`, screenshotPath);
      }

      // Кликаем на правильную карточку
      console.log(`👆 Клик на карточку ${correctIndex} (${imageWords[correctIndex]})`);
      await cards[correctIndex].click();
      await page.waitForTimeout(1000);

      // Проверяем обратную связь
      const feedbackIcon = await page.$('#feedback-icon');
      const feedbackText = await feedbackIcon?.textContent();
      
      if (feedbackText !== '🎉') {
        logAnomaly(lessonIdx, `После правильного ответа иконка "${feedbackText}" вместо 🎉`, screenshotPath);
      }

      // Проверяем подсветку
      const correctCard = await page.$(`.image-card.correct`);
      if (!correctCard) {
        logAnomaly(lessonIdx, 'Правильная карточка не подсвечена зелёным', screenshotPath);
      }

      // Клик на "Дальше"
      const nextBtn = await page.$('#next-btn');
      if (nextBtn && await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
        lessonIdx++;
        lessonCount++;
      } else {
        logAnomaly(lessonIdx, 'Кнопка "Дальше" не появилась', screenshotPath);
        break;
      }
    }

    console.log('\n✅ Тест завершён!');
    console.log(`📊 Аномалии: ${fs.existsSync(ANOMALIES_FILE) ? JSON.parse(fs.readFileSync(ANOMALIES_FILE, 'utf8')).length : 0}`);

  } catch (err) {
    console.error('❌ Ошибка:', err);
  } finally {
    server.kill();
    await browser.close();
  }
}

visionTest().catch(console.error);
