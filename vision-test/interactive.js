/**
 * Vision-тест для игры "Читаем вместе"
 * 
 * Логика:
 * 1. Открывает игру в Chromium
 * 2. Делает скриншот
 * 3. Ждёт команду (клик по координатам или индекс)
 * 4. Повторяет цикл: скриншот → анализ → действие
 * 5. Записывает аномалии в файл
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const ANOMALIES_FILE = path.join(__dirname, 'anomalies.json');

// Создаём папку для скриншотов
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Сохраняет аномалию в файл
 */
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
  console.log(`⚠️ Аномалия: ${description}`);
}

/**
 * Делает скриншот и возвращает путь
 */
async function takeScreenshot(page, stepName) {
  const filename = `step_${stepName}_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`📸 Скриншот сохранён: ${filepath}`);
  return filepath;
}

/**
 * Определяет координаты карточек на экране
 */
async function getCardPositions(page) {
  const cards = await page.$$('.image-card');
  const positions = [];

  for (let i = 0; i < cards.length; i++) {
    const box = await cards[i].boundingBox();
    if (box) {
      positions.push({
        index: i,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2
      });
    }
  }

  return positions;
}

/**
 * Кликает на карточку по индексу
 */
async function clickCard(page, index) {
  const cards = await page.$$('.image-card');
  if (cards[index]) {
    await cards[index].click();
    console.log(`👆 Клик на карточку ${index}`);
  } else {
    console.log(`❌ Карточка ${index} не найдена`);
  }
}

/**
 * Кликает на кнопку "Дальше"
 */
async function clickNext(page) {
  const btn = await page.$('#next-btn');
  if (btn && await btn.isVisible()) {
    await btn.click();
    console.log('👆 Клик на "Дальше"');
    return true;
  }
  console.log('❌ Кнопка "Дальше" не найдена');
  return false;
}

/**
 * Ждёт команду от LLM (через консоль или файл)
 * В текущей реализации — просто ждёт ввода в консоли
 */
async function waitForCommand() {
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => {
      resolve(data.toString().trim());
    });
    console.log('\n⏳ Жду команду (например: "click 2", "next", "anomaly: текст", "quit"):');
  });
}

/**
 * Главная функция vision-теста
 */
async function visionTest(maxLessons = 5) {
  console.log('🚀 Запуск vision-теста...');

  const browser = await chromium.launch({ 
    headless: false, // false чтобы видеть что происходит
    slowMo: 500 
  });
  
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 } // Размер iPhone
  });
  
  const page = await context.newPage();

  // Открываем игру
  const gamePath = path.join(__dirname, '..', 'index.html');
  await page.goto(`file:///${gamePath.replace(/\\/g, '/')}`);
  await page.waitForTimeout(2000); // Ждём загрузку

  console.log('🎮 Игра открыта');

  let lessonCount = 0;
  let lessonIdx = 0;

  try {
    while (lessonCount < maxLessons) {
      console.log(`\n=== Урок ${lessonIdx + 1} (${lessonCount + 1}/${maxLessons}) ===`);

      // Скриншот урока
      const screenshotPath = await takeScreenshot(page, `lesson_${lessonIdx}`);

      // Ждём команду
      while (true) {
        const command = await waitForCommand();
        console.log(`> ${command}`);

        if (command === 'quit') {
          console.log('🛑 Завершение теста');
          return;
        }

        if (command.startsWith('click ')) {
          const idx = parseInt(command.split(' ')[1]);
          if (!isNaN(idx)) {
            await clickCard(page, idx);
            await page.waitForTimeout(1000);
            await takeScreenshot(page, `after_click_${idx}`);
          }
        }

        if (command === 'next' || command === 'auto') {
          // Проверяем, есть ли кнопка "Дальше"
          const clicked = await clickNext(page);
          if (clicked) {
            await page.waitForTimeout(1000);
            lessonIdx++;
            lessonCount++;
            break; // Переходим к следующему уроку
          }
          // Если кнопки "Дальше" нет — возможно это ловушка с автопереходом
          await page.waitForTimeout(3000);
          await takeScreenshot(page, `wait_next`);
        }

        if (command.startsWith('anomaly:')) {
          const text = command.replace('anomaly:', '').trim();
          logAnomaly(lessonIdx, text, screenshotPath);
        }

        if (command === 'screenshot') {
          await takeScreenshot(page, `manual_${lessonIdx}`);
        }
      }
    }

    console.log('\n✅ Тест завершён!');
    console.log(`📊 Аномалии сохранены в: ${ANOMALIES_FILE}`);

  } catch (err) {
    console.error('❌ Ошибка:', err);
  } finally {
    await browser.close();
  }
}

// Запуск
visionTest().catch(console.error);
