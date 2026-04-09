// ==========================================
// 🧩 PROVIDER SYSTEM
// ==========================================

class BaseProvider {
  generate(ctx) { throw new Error('generate() not implemented'); }
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/**
 * Статический провайдер — 1:1 совместимость со старым curriculum.json
 * Читает lesson.config.image_words и config.correct_image_index
 */
class StaticProvider extends BaseProvider {
  generate(ctx) {
    const c = ctx.config;
    return {
      target_word: c.target_word || '???',
      image_words: [...(c.image_words || [])],
      correct_image_index: c.correct_image_index ?? 0
    };
  }
}

/**
 * Pool-провайдер — берёт target_word, дистракторы из пула
 * Каждый раз новые дистракторы — ребёнок не запоминает набор
 */
class PoolProvider extends BaseProvider {
  generate(ctx) {
    if (ctx.isRetry && ctx.cachedRuntime) return ctx.cachedRuntime;
    const c = ctx.config;
    const target = c.target_word;
    const pool = c.distractor_pool || c.word_pool || [];
    const count = c.distractor_count || 3;
    const filtered = pool.filter(w => w.toLowerCase() !== target.toLowerCase());
    const distractors = this._shuffle([...filtered]).slice(0, count);
    return {
      target_word: target.toUpperCase(),
      image_words: [target.toLowerCase(), ...distractors],
      correct_image_index: 0
    };
  }
}

/**
 * Комбинаторный провайдер — максимальный КПД ассетов
 * Отслеживает usage слов, выбирает наименее использованное
 */
class CombinatorialProvider extends BaseProvider {
  constructor() { super(); this.usage = new Map(); }

  generate(ctx) {
    if (ctx.isRetry && ctx.cachedRuntime) return ctx.cachedRuntime;
    const c = ctx.config;
    const pool = c.word_pool || [];
    if (!pool.length) return { target_word: 'НЕТ ДАННЫХ', image_words: ['кот','кит','рот','сом'], correct_image_index: 0 };

    // Выбираем слово с наименьшим usage
    let target = pool[0];
    let minUsage = Infinity;
    for (const word of pool) {
      const u = this.usage.get(word) || 0;
      if (u < minUsage) {
        minUsage = u;
        target = word;
      }
    }

    const count = c.distractor_count || 3;
    const filtered = pool.filter(w => w.toLowerCase() !== target.toLowerCase());
    const distractors = this._shuffle([...filtered]).slice(0, count);

    this.usage.set(target, (this.usage.get(target) || 0) + 1);
    return {
      target_word: target.toUpperCase(),
      image_words: [target.toLowerCase(), ...distractors],
      correct_image_index: 0
    };
  }
}

const PROVIDERS = {
  static: new StaticProvider(),
  pool: new PoolProvider(),
  combinatorial: new CombinatorialProvider()
};

const SVG_FALLBACK = 'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<rect width="100" height="100" fill="#eee"/>' +
    '<text x="50" y="50" text-anchor="middle" dy=".3em" font-size="14" fill="#999">⏳</text>' +
  '</svg>');

// ==========================================
// ⚙️ CONFIG & STATE
// ==========================================
const CONFIG = {
  curriculumPath: 'curriculum.json',
  imageBaseUrl: 'https://krivich.github.io/open-word-images/styles/new/',
  imageSuffix: '_latest_256.png',
  storageKey: 'reading_game_progress_v2' // v2 — изменилась структура с metrics
};

let state = {
  curriculum: null,
  stageIdx: 0,
  lessonIdx: 0,
  lives: 3,
  isAnswered: false,
  currentRuntime: null,      // 🔒 Кэш для детерминированного retry
  assetMap: {},              // 🖼️ Иерархический маппинг display → asset_key
  providerInstance: null,    // 🏗️ Активный провайдер
  metrics: {                 // 📊 Метрики геймплея
    streak: 0,
    errors: 0,
    totalAnswers: 0,
    avgReaction: 0,
    startTime: Date.now()
  }
};

const els = {
  level: document.getElementById('level-display'),
  lives: document.getElementById('lives-display'),
  targetWord: document.getElementById('target-word'),
  grid: document.getElementById('images-grid'),
  feedbackOverlay: document.getElementById('feedback-overlay'),
  feedbackIcon: document.getElementById('feedback-icon'),
  feedbackText: document.getElementById('feedback-text'),
  nextBtn: document.getElementById('next-btn'),
  parentZone: document.getElementById('parent-zone'),
  parentHint: document.getElementById('parent-hint'),
  endModal: document.getElementById('end-modal'),
  endTitle: document.getElementById('end-title'),
  endMessage: document.getElementById('end-message'),
  restartBtn: document.getElementById('restart-btn'),
  resetBtn: document.getElementById('reset-btn')
};

// ==========================================
// 🛠️ UTILS
// ==========================================
function resolveAssetKey(displayText) {
  if (!displayText) return '';
  return state.assetMap[displayText] || displayText.toLowerCase();
}

function calculateAvgReaction(reactionTime) {
  const m = state.metrics;
  if (m.totalAnswers === 1) return reactionTime;
  // EMA: 0.8 * новое + 0.2 * старое (быстрее реагирует на изменения)
  return Math.round(0.8 * reactionTime + 0.2 * m.avgReaction);
}

// ==========================================
// 🎮 CORE LOGIC
// ==========================================
async function init() {
  loadProgress();
  try {
    const res = await fetch(CONFIG.curriculumPath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.curriculum = await res.json();
    if (!state.curriculum.stages || !state.curriculum.stages.length) {
      throw new Error('Нет stages в curriculum.json');
    }
    enterStage();
    startLesson(false);
  } catch (err) {
    els.targetWord.textContent = '❌ Ошибка загрузки';
    console.error('❌ Init error:', err);
    alert('Положите curriculum.json рядом с index.html и запустите через локальный сервер (Live Server, npx serve и т.д.)');
  }

  els.nextBtn.addEventListener('click', nextLesson);
  els.resetBtn.addEventListener('click', resetProgress);
}

/**
 * Вход в стадию: собираем иерархический asset_map, сбрасываем курсор
 */
function enterStage() {
  state.assetMap = {
    ...(state.curriculum.asset_map || {}),
    ...(state.curriculum.stages[state.stageIdx]?.asset_map || {})
  };
  // При входе в новую стадию начинаем с первого урока
  if (state.lessonIdx === 0 || state.lessonIdx >= (state.curriculum.stages[state.stageIdx]?.lessons?.length || 0)) {
    state.lessonIdx = 0;
  }
}

/**
 * Выбор провайдера по приоритету: lesson → stage → curriculum → static
 */
function selectProvider(stage, lessonConfig) {
  const name = lessonConfig?.provider || stage?.provider || state.curriculum?.default_provider || 'static';
  return PROVIDERS[name] || PROVIDERS.static;
}

function loadProgress() {
  const saved = localStorage.getItem(CONFIG.storageKey);
  if (saved) {
    try {
      const p = JSON.parse(saved);
      state.stageIdx = p.stageIdx ?? 0;
      state.lessonIdx = p.lessonIdx ?? 0;
      state.lives = p.lives ?? 3;
      // Восстанавливаем метрики если есть
      if (p.metrics) {
        state.metrics = { ...state.metrics, ...p.metrics };
      }
    } catch (e) {
      console.warn('⚠️ Не удалось распарсить сохранённый прогресс:', e);
    }
  }
  updateUI();
}

function saveProgress() {
  localStorage.setItem(CONFIG.storageKey, JSON.stringify({
    stageIdx: state.stageIdx,
    lessonIdx: state.lessonIdx,
    lives: state.lives,
    metrics: { ...state.metrics, avgReaction: state.metrics.avgReaction },
    lastActive: new Date().toISOString()
  }));
}

function updateUI() {
  els.lives.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(Math.max(0, 3 - state.lives));
  els.level.textContent = state.stageIdx * 10 + state.lessonIdx + 1;
}

function startLesson(isRetry = false) {
  state.isAnswered = false;
  els.feedbackOverlay.classList.add('hidden');
  els.parentZone.classList.add('hidden');
  els.grid.innerHTML = '';

  const stage = state.curriculum.stages[state.stageIdx];
  if (!stage) { showEndScreen(true); return; }

  const lessons = stage.lessons || [];

  // Определяем конфиг урока: статический из JSON или виртуальный для динамических
  let lessonConfig;
  let isDynamic = false;

  if (state.lessonIdx < lessons.length) {
    lessonConfig = lessons[state.lessonIdx];
    // Если у урока нет provider — это статический урок
    isDynamic = !!lessonConfig.provider;
  } else {
    // Виртуальный урок для динамических провайдеров
    lessonConfig = { provider: stage.provider || 'combinatorial', config: stage };
    isDynamic = true;
  }

  state.providerInstance = selectProvider(stage, lessonConfig);

  const context = {
    config: lessonConfig.config || lessonConfig.runtime || {},
    metrics: { ...state.metrics },
    isRetry,
    cachedRuntime: state.currentRuntime
  };

  const runtime = state.providerInstance.generate(context);
  if (!runtime) { showEndScreen(true); return; }

  state.currentRuntime = runtime; // 🔒 Сохраняем для retry
  state.metrics.startTime = Date.now();

  const meta = lessonConfig.meta || {};
  renderLesson(runtime, meta);
  if (!isDynamic) prefetchNextLesson();
}

function renderLesson(runtime, meta) {
  els.targetWord.textContent = runtime.target_word;
  updateUI();

  // Fisher-Yates shuffle
  const imageWords = [...runtime.image_words];
  const correctWord = imageWords[runtime.correct_image_index ?? 0];
  for (let i = imageWords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [imageWords[i], imageWords[j]] = [imageWords[j], imageWords[i]];
  }
  const newCorrectIndex = imageWords.indexOf(correctWord);

  // Лог для тестов
  window.__lastCorrectIndex = newCorrectIndex;
  window.__lastTargetWord = runtime.target_word;
  window.__lastShuffledWords = [...imageWords];

  imageWords.forEach((word, idx) => {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.index = idx;

    const img = document.createElement('img');
    const assetKey = resolveAssetKey(word);
    img.src = `${CONFIG.imageBaseUrl}${assetKey}${CONFIG.imageSuffix}`;
    img.alt = word;
    img.loading = 'lazy';
    img.onerror = () => { img.src = SVG_FALLBACK; };

    card.appendChild(img);
    card.addEventListener('click', () => handleAnswer(idx, newCorrectIndex, meta));
    els.grid.appendChild(card);
  });
}

function prefetchNextLesson() {
  const stage = state.curriculum.stages[state.stageIdx];
  if (!stage?.lessons) return;

  let nextStageIdx = state.stageIdx;
  let nextLessonIdx = state.lessonIdx + 1;

  if (nextLessonIdx >= stage.lessons.length) {
    nextLessonIdx = 0;
    nextStageIdx = state.stageIdx + 1;
  }
  if (nextStageIdx >= state.curriculum.stages.length) return;

  const nextStage = state.curriculum.stages[nextStageIdx];
  const nextLesson = nextStage.lessons?.[nextLessonIdx];
  if (!nextLesson?.runtime?.image_words) return;

  // Предзагружаем картинки следующего урока
  const assetMap = { ...state.assetMap, ...(nextStage.asset_map || {}) };
  nextLesson.runtime.image_words.forEach(word => {
    const key = assetMap[word] || word.toLowerCase();
    const img = new Image();
    img.src = `${CONFIG.imageBaseUrl}${key}${CONFIG.imageSuffix}`;
  });
}

function handleAnswer(selectedIdx, correctIndex, meta) {
  if (state.isAnswered) return;
  state.isAnswered = true;

  const reactionTime = Date.now() - state.metrics.startTime;
  state.metrics.avgReaction = calculateAvgReaction(reactionTime);
  state.metrics.totalAnswers++;

  const isCorrect = selectedIdx === correctIndex;
  const cards = document.querySelectorAll('.image-card');

  cards.forEach(c => c.classList.add('disabled'));
  cards[selectedIdx].classList.add(isCorrect ? 'correct' : 'wrong');
  if (!isCorrect) cards[correctIndex].classList.add('correct');

  els.feedbackIcon.textContent = isCorrect ? '🎉' : '❌';
  els.feedbackText.textContent = isCorrect ? 'Правильно!' : 'Не совсем, смотри:';
  els.feedbackOverlay.classList.remove('hidden');

  if (meta?.parent_note) {
    els.parentHint.textContent = meta.parent_note;
    els.parentZone.classList.remove('hidden');
  } else {
    els.parentZone.classList.add('hidden');
  }

  if (!isCorrect) {
    state.lives--;
    state.metrics.errors++;
    state.metrics.streak = 0;
    updateUI();
    saveProgress();
    if (state.lives <= 0) {
      showEndScreen(false);
      return;
    }
  } else {
    state.metrics.streak++;
  }

  els.nextBtn.style.display = '';
}

function nextLesson() {
  state.currentRuntime = null; // 🔓 Очищаем кэш
  state.lessonIdx++;

  const stage = state.curriculum.stages[state.stageIdx];
  const lessons = stage?.lessons || [];

  // Проверяем: статический ли это урок или динамический
  const currentLesson = lessons[state.lessonIdx - 1]; // предыдущий (который только что прошёл)
  const isDynamic = currentLesson?.provider ? true : false;

  // Переход к следующей стадии (только для статических уроков)
  if (!isDynamic && state.lessonIdx >= lessons.length) {
    state.lessonIdx = 0;
    state.stageIdx++;
    if (state.stageIdx >= state.curriculum.stages.length) {
      showEndScreen(true);
      return;
    }
    enterStage();
  }

  saveProgress();
  els.feedbackOverlay.classList.add('hidden');
  startLesson(false);
}

function showEndScreen(isWin) {
  els.endTitle.textContent = isWin ? '🏆 Курс пройден!' : '💔 Жизни закончились';

  const stageName = state.curriculum.stages[state.stageIdx]?.name || '';

  if (isWin) {
    els.endMessage.textContent = 'Ты отлично читаешь! Продолжай в том же духе.';
    els.restartBtn.textContent = 'Начать заново';
    els.restartBtn.onclick = () => {
      localStorage.removeItem(CONFIG.storageKey);
      location.reload();
    };
  } else {
    els.endMessage.textContent = `Не расстраивайся! Начнём секцию «${stageName}» заново с полными жизнями.`;
    els.restartBtn.textContent = 'Попробовать ещё раз';
    els.restartBtn.onclick = () => {
      // 🔁 Детерминированный retry: тот же урок, 3 жизни
      state.lives = 3;
      saveProgress();
      updateUI();
      els.endModal.classList.add('hidden');
      startLesson(true); // ← isRetry = true
    };
  }

  els.endModal.classList.remove('hidden');
}

function resetProgress() {
  if (confirm('Сбросить весь прогресс и начать сначала?')) {
    localStorage.removeItem(CONFIG.storageKey);
    location.reload();
  }
}

// Старт
init();
