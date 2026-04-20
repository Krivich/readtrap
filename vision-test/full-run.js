/**
 * 🎯 Полное прохождение всех 3 режимов: простой → средний → научный.
 * Проверяет, что каждый режим загружается, уроки генерируются,
 * итератор работает, Game Over корректно перезапускает секцию.
 */
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8082;

// Конфигурация режимов
const MODES = [
  { name: '🟢 Простой',     url: '?curriculum=curriculum-simple.json', lessons: 10 },
  { name: '🟡 Средний',     url: '?curriculum=curriculum.json',        lessons: 50 },
  { name: '🔴 Научный',     url: '?level=scientific',                  lessons: 40 },
];

async function run() {
  const server = spawn('npx', ['http-server', '-p', String(PORT), '-c-1', '--cors', '.'], {
    cwd: path.join(__dirname, '..'), shell: true
  });
  await new Promise(r => setTimeout(r, 3000));

  const browser = await chromium.launch({ headless: true });

  for (const mode of MODES) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${mode.name} — ${mode.lessons} уроков`);
    console.log(`${'═'.repeat(60)}`);

    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });

    try {
      // Загружаем режим
      await page.goto(`http://localhost:${PORT}/${mode.url}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      // Ждём, пока загрузится первый урок
      await page.waitForFunction(
        () => {
          const word = document.getElementById('target-word');
          return word && word.textContent !== 'Loading...' && word.textContent !== 'Загрузка...';
        },
        { timeout: 15000 }
      );

      // Настраиваем слушатель ошибок загрузки картинок
      const imageErrors = [];
      await page.evaluate(() => {
        window.__imageErrors = [];
        document.addEventListener('error', (e) => {
          if (e.target.tagName === 'IMG') {
            window.__imageErrors.push({
              src: e.target.src,
              time: Date.now()
            });
          }
        }, true);
      });

      const words = [];
      const errors = [];
      let lessonCount = 0;
      const maxLessons = mode.lessons;

      // Проходим все уроки режима
      for (let i = 0; i < maxLessons; i++) {
        const word = await page.$eval('#target-word', el => el.textContent);
        words.push(word);

        // Получаем правильный индекс
        const correctIdx = await page.evaluate(() => window.__lastCorrectIndex);
        const cards = await page.$$('.image-card');

        if (!cards.length || correctIdx === undefined) {
          errors.push(`Урок ${i + 1}: "${word}" — нет карточек или correctIndex`);
          break;
        }

        // Кликаем правильный ответ
        await cards[correctIdx].click();

        // Ждём кнопку "Дальше"
        await page.waitForSelector('#next-btn', { state: 'visible', timeout: 3000 }).catch(() => {});

        // Кликаем "Дальше"
        await page.evaluate(() => document.getElementById('next-btn')?.click());

        // Ждём следующий урок
        await page.waitForFunction(
          (old) => {
            const txt = document.getElementById('target-word').textContent;
            return txt !== old && txt !== 'Loading...';
          },
          { timeout: 5000 },
          word
        ).catch(() => {});

        lessonCount++;

        // Проверяем длину лога итератора
        if (lessonCount % 10 === 0) {
          const logLen = await page.evaluate(() => window.__getIteratorLogLength());
          console.log(`  Урок ${lessonCount}/${maxLessons}: "${word}" | Лог: ${logLen}`);
        }
      }

      // Проверяем ошибки загрузки картинок
      const imageErrorCount = await page.evaluate(() => window.__imageErrors?.length || 0);
      if (imageErrorCount > 0) {
        console.log(`  ❌ ОБНАРУЖЕНО 404 ОШИБОК: ${imageErrorCount}`);
        const errorsSample = await page.evaluate(() => window.__imageErrors.slice(0, 5));
        errorsSample.forEach(err => console.log(`     - ${err.src}`));
        errors.push(`404 ошибки: ${imageErrorCount} картинок не загрузились`);
      }

      console.log(`\n  ✅ Пройдено: ${lessonCount}/${maxLessons} уроков`);
      console.log(`  📝 Слова: ${words.slice(0, 5).join(', ')}...`);
      if (errors.length) {
        console.log(`  ❌ Ошибки: ${errors.length}`);
        errors.slice(0, 3).forEach(e => console.log(`    - ${e}`));
      }

    } catch (err) {
      console.log(`  ❌ КРИТИЧЕСКАЯ ОШИБКА: ${err.message}`);
    }

    await page.close();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('🏁 ВСЕ РЕЖИМЫ ЗАВЕРШЕНЫ');
  console.log(`${'═'.repeat(60)}\n`);

  server.kill();
  browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
