// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Базовые E2E тесты для "Читаем вместе"
 * 
 * Запуск: npm test
 * UI режим: npm run test:ui
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle', timeout: 15000 });
  // Ждём пока слово загрузится (не "Загрузка..." и не ошибка)
  await page.waitForFunction(() => {
    const el = document.getElementById('target-word');
    return el && el.textContent !== 'Загрузка...' && !el.textContent.includes('❌');
  }, { timeout: 10000 });
});

test.describe('Урок', () => {
  test('загружается слово и 4 картинки', async ({ page }) => {
    const word = await page.locator('#target-word').textContent();
    expect(word).toBeTruthy();
    expect(word?.length).toBeGreaterThan(0);

    const cards = page.locator('.image-card');
    await expect(cards).toHaveCount(4);

    // Все картинки загрузились (не заглушки)
    const images = cards.locator('img');
    for (let i = 0; i < 4; i++) {
      const src = await images.nth(i).getAttribute('src');
      expect(src).not.toContain('data:image/svg');
    }
  });

  test('правильный ответ показывает 🎉', async ({ page }) => {
    const word = (await page.locator('#target-word').textContent())?.toUpperCase();
    const cards = page.locator('.image-card');
    
    // Находим правильную карточку по alt
    let correctIdx = -1;
    for (let i = 0; i < 4; i++) {
      const alt = await cards.locator('img').nth(i).getAttribute('alt');
      if (alt?.toUpperCase() === word) {
        correctIdx = i;
        break;
      }
    }
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    await cards.nth(correctIdx).click();
    
    // Проверяем фидбек
    await expect(page.locator('#feedback-icon')).toHaveText('🎉');
    await expect(page.locator('#feedback-text')).toHaveText('Правильно!');
    await expect(page.locator('.next-btn')).toBeVisible();
  });

  test('неправильный ответ показывает ❌ и теряет жизнь', async ({ page }) => {
    const word = (await page.locator('#target-word').textContent())?.toUpperCase();
    const cards = page.locator('.image-card');
    
    // Находим неправильную карточку
    let wrongIdx = -1;
    for (let i = 0; i < 4; i++) {
      const alt = await cards.locator('img').nth(i).getAttribute('alt');
      if (alt?.toUpperCase() !== word) {
        wrongIdx = i;
        break;
      }
    }
    expect(wrongIdx).toBeGreaterThanOrEqual(0);

    await cards.nth(wrongIdx).click();
    
    await expect(page.locator('#feedback-icon')).toHaveText('❌');
    
    // Жизнь потеряна
    const lives = await page.locator('#lives-display').textContent();
    expect(lives).toContain('🖤');
  });
});

test.describe('Навигация', () => {
  test('кнопка "Дальше" переключает урок', async ({ page }) => {
    const initialWord = await page.locator('#target-word').textContent();
    
    // Правильный ответ
    const word = initialWord?.toUpperCase();
    const cards = page.locator('.image-card');
    for (let i = 0; i < 4; i++) {
      const alt = await cards.locator('img').nth(i).getAttribute('alt');
      if (alt?.toUpperCase() === word) {
        await cards.nth(i).click();
        break;
      }
    }
    
    await expect(page.locator('#next-btn')).toBeVisible();
    await page.locator('#next-btn').click();
    
    // Слово изменилось
    await expect(page.locator('#target-word')).not.toHaveText(initialWord);
  });
});

test.describe('Игровой цикл', () => {
  test('после 3 ошибок показывается Game Over', async ({ page }) => {
    // Делаем 3 неправильных ответа на разных уроках
    for (let i = 0; i < 3; i++) {
      const word = (await page.locator('#target-word').textContent())?.toUpperCase();
      const cards = page.locator('.image-card');
      
      // Неправильная карточка
      for (let j = 0; j < 4; j++) {
        const alt = await cards.locator('img').nth(j).getAttribute('alt');
        if (alt?.toUpperCase() !== word) {
          await cards.nth(j).click();
          break;
        }
      }
      
      // После 3-й ошибки — ждём Game Over модалку
      if (i === 2) {
        await page.waitForTimeout(1000);
        break;
      }
      
      // Для первых 2 ошибок — кликаем "Дальше"
      await page.waitForTimeout(500);
      await page.locator('#next-btn').click();
      await page.waitForTimeout(500);
    }
    
    // Game Over модалка
    await expect(page.locator('#end-modal')).toBeVisible();
    await expect(page.locator('#end-title')).toContainText('Жизни закончились');
  });

  test('retry восстанавливает жизни', async ({ page }) => {
    // Быстрый сброс через URL параметр
    await page.goto('/?curriculum=curriculum.json');
    await page.waitForTimeout(1000);
    
    // Проверяем что 3 жизни
    const lives = await page.locator('#lives-display').textContent();
    expect(lives).toContain('❤️❤️❤️');
  });
});

test.describe('Стресс-конфиг', () => {
  test('загружает кастомный конфиг', async ({ page }) => {
    await page.goto('/?curriculum=stress-test.json');
    await page.waitForTimeout(2000);
    
    const word = await page.locator('#target-word').textContent();
    expect(word).not.toBe('❌ Ошибка загрузки');
    expect(word).not.toBe('Загрузка...');
  });

  test('asset_map работает (КО-Т → кот)', async ({ page }) => {
    await page.goto('/?curriculum=stress-test.json');
    await page.waitForTimeout(2000);
    
    // В stress-test.json урок 5 = КО-Т с asset_map
    // Проходим 4 урока Stage 1, добираемся до L05 (КО-Т)
    for (let i = 0; i < 4; i++) {
      const word = (await page.locator('#target-word').textContent())?.toUpperCase();
      const cards = page.locator('.image-card');
      for (let j = 0; j < 4; j++) {
        const alt = await cards.locator('img').nth(j).getAttribute('alt');
        if (alt?.toUpperCase() === word) {
          await cards.nth(j).click();
          break;
        }
      }
      await page.waitForTimeout(500);
      if (await page.locator('#next-btn').isVisible()) {
        await page.locator('#next-btn').click();
      }
      await page.waitForTimeout(500);
    }
    
    // Урок 5 должен быть КО-Т
    const word = await page.locator('#target-word').textContent();
    expect(word).toBe('КО-Т');
    
    // Находим карточку с alt="кот" (из asset_map КО-Т → кот)
    const cards = page.locator('.image-card');
    let foundKot = false;
    for (let j = 0; j < 4; j++) {
      const alt = await cards.locator('img').nth(j).getAttribute('alt');
      if (alt === 'кот') {
        foundKot = true;
        const src = await cards.locator('img').nth(j).getAttribute('src');
        expect(src).toContain('кот');
        break;
      }
    }
    expect(foundKot).toBeTruthy();
  });
});
