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
    const target = c.target_word || '???';
    // Поддержка: runtime.image_words (старый формат) или config.distractors (новый)
    let imageWords;
    if (c.image_words && c.image_words.length) {
      imageWords = [...c.image_words];
    } else if (c.distractors && c.distractors.length) {
      imageWords = [target.toLowerCase(), ...c.distractors];
    } else {
      imageWords = [];
    }
    return {
      target_word: target.toUpperCase(),
      image_words: imageWords,
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
    // word_pool: локальный (урок) → stage → fallback
    const pool = c.word_pool || [];
    if (!pool.length) return { target_word: 'НЕТ ДАННЫХ', image_words: ['кот','кит','рот','сом'], correct_image_index: 0 };

    // Выбираем слово с наименьшим usage
    let target = pool[0];
    let minUsage = Infinity;
    for (const word of pool) {
      const u = this.usage.get(word) || 0;
      if (u < minUsage) { minUsage = u; target = word; }
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
// 🔊 ЗВУКИ
// ==========================================
const sounds = {
  click: null,    // клик по кнопке "Дальше" / "Попробовать ещё раз"
  success: null,  // правильный ответ
  wrong: null,    // неправильный ответ
  win: null,      // финальная победа
  lose: null      // Game Over
};

function initSounds() {
  sounds.click = new Audio('sounds/click_001.ogg');
  sounds.success = new Audio('sounds/pluck_002.ogg');
  sounds.wrong = new Audio('sounds/scratch_005.ogg');
  sounds.win = new Audio('sounds/maximize_005.ogg');
  sounds.lose = new Audio('sounds/minimize_005.ogg');
  Object.values(sounds).forEach(s => { if (s) s.load(); });
}

function playSound(name) {
  const s = sounds[name];
  if (s) {
    s.currentTime = 0;
    s.play().catch(() => {});
  }
}

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
  initSounds();
  loadProgress();

  // Поддержка кастомного конфига через URL: ?curriculum=stress-test.json
  const params = new URLSearchParams(window.location.search);
  const customConfig = params.get('curriculum') || CONFIG.curriculumPath;

  try {
    const res = await fetch(customConfig);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${customConfig}`);
    state.curriculum = await res.json();
    if (!state.curriculum.stages || !state.curriculum.stages.length) {
      throw new Error('Нет stages в ' + customConfig);
    }
    console.log(`📚 Загружен конфиг: ${customConfig} (${state.curriculum.stages.length} стадий)`);
    enterStage();
    startLesson(false);
  } catch (err) {
    els.targetWord.textContent = '❌ Ошибка загрузки';
    console.error('❌ Init error:', err);
    alert(`Не удалось загрузить ${customConfig}\nПроверьте что файл лежит рядом с index.html`);
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
 * Выбор провайдера по приоритету:
 * - Если есть runtime → static (обратная совместимость)
 * - Иначе: lesson.provider → stage.provider → curriculum.default_provider → static
 */
function selectProvider(stage, lessonConfig) {
  // Runtime = статический урок, игнорируем провайдер стадии
  if (lessonConfig?.runtime) return PROVIDERS.static;
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

  // Формируем config: для динамических провайдеров мержим stage (word_pool и т.д.) + lesson overrides
  const isDynamicLesson = lessonConfig?.provider;
  let mergedConfig;
  if (isDynamicLesson) {
    mergedConfig = { ...stage, ...(lessonConfig.config || lessonConfig.runtime || {}) };
  } else if (state.lessonIdx >= lessons.length && stage.provider) {
    // Виртуальный урок для динамической стадии
    mergedConfig = { ...stage };
  } else {
    mergedConfig = lessonConfig.config || lessonConfig.runtime || {};
  }

  const context = {
    config: mergedConfig,
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

  // Звуки
  if (isCorrect) playSound('success');
  else playSound('wrong');

  // При последней жизни — сразу Game Over, без feedback overlay
  if (!isCorrect && state.lives <= 1) {
    state.lives = 0;
    state.metrics.errors++;
    state.metrics.streak = 0;
    updateUI();
    saveProgress();
    playSound('lose');
    setTimeout(() => showEndScreen(false), 800);
    return;
  }

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
  } else {
    state.metrics.streak++;
  }

  els.nextBtn.style.display = '';
}

function nextLesson() {
  playSound('click');
  state.currentRuntime = null;
  state.lessonIdx++;

  const stage = state.curriculum.stages[state.stageIdx];
  const lessons = stage?.lessons || [];
  const isDynamicStage = stage?.provider && !stage?.lessons?.length; // Динамическая = провайдер есть + уроков нет

  // Переход к следующей стадии: только для статических, где уроки закончились
  if (!isDynamicStage && state.lessonIdx >= lessons.length) {
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
  playSound(isWin ? 'win' : 'lose');

  const stageName = state.curriculum.stages[state.stageIdx]?.name || '';

  if (isWin) {
    els.endMessage.textContent = 'Ты отлично читаешь! Продолжай в том же духе.';
    els.restartBtn.textContent = 'Начать заново';
    els.restartBtn.onclick = () => {
      playSound('click');
      localStorage.removeItem(CONFIG.storageKey);
      location.reload();
    };
  } else {
    els.endMessage.textContent = `Не расстраивайся! Начнём секцию «${stageName}» заново с полными жизнями.`;
    els.restartBtn.textContent = 'Попробовать ещё раз';
    els.restartBtn.onclick = () => {
      playSound('click');
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
