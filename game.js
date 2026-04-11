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
    let imageWords;
    if (c.image_words && c.image_words.length) {
      imageWords = [...c.image_words];
    } else if (c.distractors && c.distractors.length) {
      imageWords = [target.toLowerCase(), ...c.distractors];
    } else if (c.distractor_pool && c.distractor_pool.length) {
      // Fallback: берём случайные дистракторы из пула
      const pool = c.distractor_pool.filter(w => w.toLowerCase() !== target.toLowerCase());
      const count = c.distractor_count || 3;
      const shuffled = this._shuffle([...pool]);
      imageWords = [target.toLowerCase(), ...shuffled.slice(0, count)];
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

/**
 * 🔬 ScientificProvider — генерирует курс «с нуля» из манифеста open-word-images
 * Загружает manifest.json, фильтрует слова по языку (en/ru),
 * категоризирует по фонетической сложности, генерирует 40-50 уроков.
 */
class ScientificProvider extends BaseProvider {
  constructor() {
    super();
    this.wordPool = null;
    this.stageWords = { A1: [], A2: [], B1: [], B2: [] };
    this.usage = new Map();
    this.manifestUrl = 'https://krivich.github.io/open-word-images/manifest.json';
    this.targetLang = 'ru'; // 'ru' = с кириллицей (styles/new), 'en' = латиница (styles/eng)
  }

  async loadManifest() {
    if (this.wordPool) return this.wordPool;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(this.manifestUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
      const data = await res.json();

      const latestMap = {};
      const entries = Array.isArray(data) ? data : (data.words || data.entries || []);
      for (const entry of entries) {
        const word = entry.word || entry.key || '';
        const path = entry.path || '';
        if (typeof word !== 'string' || !path) continue;
        // Берём только latest или первую версию
        if (entry.version === 'latest' || !latestMap[word]) {
          latestMap[word] = path;
        }
      }

      // Определяем базовую папку из путей (берём домен из CONFIG и папку из манифеста)
      // Пример path: "styles/new/кот_latest.png" → folder: "styles/new/"
      const folderMap = {};
      for (const [word, path] of Object.entries(latestMap)) {
        const match = path.match(/^(styles\/[^\/]+)\//);
        const folder = match ? match[1] : 'styles/new';
        if (!folderMap[folder]) folderMap[folder] = [];
        folderMap[folder].push({ word: word.toLowerCase(), path, folder });
      }

      // Сохраняем группы слов по папкам
      this.wordGroups = folderMap;
      this.wordPool = Object.values(folderMap).flat();
      console.log(`📚 Manifest loaded: ${this.wordPool.length} words in ${Object.keys(folderMap).length} folders`);
    } catch (e) {
      console.error('❌ Manifest load failed:', e.name, e.message);
      this.wordPool = [];
      this.wordGroups = {};
    }
    return this.wordPool;
  }

  filterByLang(words, lang) {
    const hasCyrillic = w => /[а-яёА-ЯЁ]/.test(w);
    if (lang === 'en') return words.filter(e => !hasCyrillic(e.word));
    if (lang === 'ru') return words.filter(e => hasCyrillic(e.word));
    return words;
  }

  /**
   * Категоризация по фонетической сложности:
   * A1: ≤3 буквы, 0 кластеров согласных (3+ подряд)
   * A2: ≤5 букв, ≤1 кластер
   * B1: ≤8 букв, ≤2 кластера
   * B2: всё остальное
   */
  categorize(words) {
    const stages = { A1: [], A2: [], B1: [], B2: [] };
    for (const entry of words) {
      const w = entry.word;
      const len = w.length;
      const consonants = w.replace(/[аеёиоуыэюяaeiouАЕЁИОУЫЭЮЯ]/g, '');
      const clusters = (consonants.match(/.{3,}/g) || []).length;
      if (len <= 3 && clusters === 0) stages.A1.push(entry);
      else if (len <= 5 && clusters <= 1) stages.A2.push(entry);
      else if (len <= 8 && clusters <= 2) stages.B1.push(entry);
      else stages.B2.push(entry);
    }
    // Гарантируем минимум 5 слов в каждой стадии
    const all = [...stages.A1, ...stages.A2, ...stages.B1, ...stages.B2];
    for (const key of ['A1', 'A2', 'B1', 'B2']) {
      while (stages[key].length < 5) {
        const extra = all.find(w => !stages[key].includes(w));
        if (extra) stages[key].push(extra); else break;
      }
    }
    return stages;
  }

  async generateStages(lessonsPerStage = 10) {
    await this.loadManifest();
    if (!this.wordPool.length) {
      console.warn('⚠️ Manifest empty, using fallback Russian words');
      // Fallback: используем слова из старого curriculum если манифест недоступен
      this.wordPool = [
        { word: 'кот', folder: 'styles/new' }, { word: 'дом', folder: 'styles/new' },
        { word: 'мак', folder: 'styles/new' }, { word: 'сок', folder: 'styles/new' },
        { word: 'лес', folder: 'styles/new' }, { word: 'жук', folder: 'styles/new' },
        { word: 'рот', folder: 'styles/new' }, { word: 'мяч', folder: 'styles/new' },
        { word: 'гриб', folder: 'styles/new' }, { word: 'стул', folder: 'styles/new' },
        { word: 'кит', folder: 'styles/new' }, { word: 'рак', folder: 'styles/new' },
        { word: 'лак', folder: 'styles/new' }, { word: 'бак', folder: 'styles/new' },
        { word: 'суп', folder: 'styles/new' }, { word: 'сук', folder: 'styles/new' },
        { word: 'сыр', folder: 'styles/new' }, { word: 'лев', folder: 'styles/new' },
        { word: 'лис', folder: 'styles/new' }, { word: 'лук', folder: 'styles/new' }
      ];
      this.wordGroups = { 'styles/new': this.wordPool };
    }

    // Группируем по папкам, затем фильтруем по языку
    const langGroups = {};
    for (const [folder, words] of Object.entries(this.wordGroups)) {
      const filtered = this.filterByLang(words, this.targetLang);
      if (filtered.length >= 5) {
        langGroups[folder] = this.categorize(filtered);
      }
    }

    // Берём первую подходящую группу (по умолчанию папку с нужным языком)
    const firstFolder = Object.keys(langGroups)[0];
    if (!firstFolder) {
      console.warn('⚠️ No words found for language:', this.targetLang);
      return [];
    }

    this.stageWords = langGroups[firstFolder];
    const assetBaseUrl = `https://krivich.github.io/open-word-images/${firstFolder}/`;
    const stages = [];

    for (const [stageId, words] of Object.entries(this.stageWords)) {
      const lessons = [];
      for (let i = 0; i < lessonsPerStage; i++) {
        let target = words[i % words.length];
        let minUsage = Infinity;
        for (const w of words) {
          const u = this.usage.get(w.word) || 0;
          if (u < minUsage) { minUsage = u; target = w; }
        }
        this.usage.set(target.word, minUsage + 1);

        const distractors = this.selectDistractors(target, words, 3);

        lessons.push({
          id: `${stageId}-L${String(i + 1).padStart(2, '0')}`,
          config: {
            target_word: target.word.toUpperCase(),
            distractor_pool: distractors,
            distractor_count: 3,
            assetBaseUrl // ← Путь к папке с картинками
          },
          meta: {
            pedagogical_goal: `Чтение "${target.word}" (${stageId})`,
            difficulty: { A1: 1, A2: 3, B1: 5, B2: 7 }[stageId],
            theme: 'Scientific',
            trap_logic: `Замена: ${target.word[0]}→${distractors.map(w => w[0]).join(',')}`,
            parent_note: `«${target.word} — это ${this.getHint(target.word)}, а ${distractors[0]} — другое»`
          }
        });
      }

      stages.push({
        id: stageId,
        name: { A1: 'Первые звуки', A2: 'Простые слова', B1: 'Сложные слова', B2: 'Длинные слова' }[stageId],
        description: { A1: 'Короткие слова', A2: 'Слова до 5 букв', B1: 'Слова 5-8 букв', B2: 'Длинные слова' }[stageId],
        provider: 'scientific',
        word_pool: words.map(w => w.word),
        assetBaseUrl, // ← Базовый URL для стадии
        lessons
      });
    }
    return stages;
  }

  selectDistractors(target, pool, count) {
    const filtered = pool.filter(w => w.word !== target.word);
    if (filtered.length <= count) return filtered.map(w => w.word);
    const scored = filtered.map(w => {
      const lenDiff = Math.abs(w.word.length - target.word.length);
      const common = w.word.split('').filter(c => target.word.includes(c)).length;
      const firstDiff = w.word[0] !== target.word[0] ? 1 : 0;
      return { word: w.word, score: lenDiff * 2 - common - firstDiff + Math.random() * 0.5 };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, count).map(s => s.word);
  }

  generate(ctx) {
    const c = ctx.config;
    const target = c.target_word;
    const pool = c.distractor_pool || [];
    const count = c.distractor_count || 3;
    if (!target) return { target_word: 'LOADING', image_words: [], correct_image_index: 0 };
    const filtered = pool.filter(w => w.toLowerCase() !== target.toLowerCase());
    const distractors = this._shuffle(filtered).slice(0, count);
    return {
      target_word: target.toUpperCase(),
      image_words: [target.toLowerCase(), ...distractors],
      correct_image_index: 0
    };
  }

  getHint(word) {
    const hints = {
      cat: 'кот', dog: 'собака', house: 'дом', fish: 'рыба',
      apple: 'яблоко', book: 'книга', tree: 'дерево', sun: 'солнце',
      bird: 'птица', car: 'машина', cup: 'чашка', pen: 'ручка',
      ball: 'мяч', hat: 'шляпа', bed: 'кровать', key: 'ключ'
    };
    return hints[word.toLowerCase()] || 'известное слово';
  }
}

const PROVIDERS = {
  static: new StaticProvider(),
  pool: new PoolProvider(),
  combinatorial: new CombinatorialProvider(),
  scientific: new ScientificProvider()
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
  sounds.click = new Audio('sounds/click_004.ogg');
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

const startScreen = document.getElementById('start-screen');
const gameContainer = document.getElementById('game-container');
const btnEasy = document.getElementById('btn-easy');
const btnNormal = document.getElementById('btn-normal');
const btnScientific = document.getElementById('btn-scientific');

async function init() {
  initSounds();

  // Обработчики кнопок выбора уровня
  btnEasy.addEventListener('click', () => startGame('curriculum-simple.json'));
  btnNormal.addEventListener('click', () => startGame('curriculum.json'));
  btnScientific.addEventListener('click', () => startScientific());

  // Если конфиг указан в URL — сразу запускаем игру
  const params = new URLSearchParams(window.location.search);
  if (params.get('level') === 'scientific') {
    startScientific();
  } else if (params.get('curriculum')) {
    startGame(params.get('curriculum'));
  }
}

/**
 * 🔬 Запуск научного провайдера: загружает манифест → генерирует курс → игра
 */
async function startScientific() {
  startScreen.classList.add('hidden');
  gameContainer.classList.remove('hidden');
  document.getElementById('game-screen').classList.remove('hidden');

  loadProgress();

  try {
    console.log('🔬 Starting scientific provider...');
    const provider = PROVIDERS.scientific;
    const stages = await provider.generateStages(10);
    console.log(`🔬 Generated ${stages.length} stages`);
    if (!stages.length) throw new Error('Нет стадий');

    state.curriculum = {
      meta: { project: 'ninachit-scientific', version: '3.0.0' },
      default_provider: 'scientific',
      asset_map: {},
      stages
    };
    console.log(`🔬 Научный курс: ${stages.reduce((s, st) => s + st.lessons.length, 0)} уроков`);
    enterStage();
    startLesson(false);
  } catch (e) {
    console.error('❌ Scientific init error:', e.name, e.message, e.stack);
    els.targetWord.textContent = `❌ ${e.message}`;
    alert(`Научный уровень:\n${e.message}\n\nПроверьте консоль для деталей.`);
  }
}

async function startGame(configPath) {
  startScreen.classList.add('hidden');
  gameContainer.classList.remove('hidden');
  document.getElementById('game-screen').classList.remove('hidden');

  loadProgress();

  try {
    const res = await fetch(configPath);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${configPath}`);
    state.curriculum = await res.json();
    if (!state.curriculum.stages || !state.curriculum.stages.length) {
      throw new Error('Нет stages в ' + configPath);
    }
    console.log(`📚 Загружен конфиг: ${configPath} (${state.curriculum.stages.length} стадий)`);
    enterStage();
    startLesson(false);
  } catch (err) {
    els.targetWord.textContent = '❌ Ошибка загрузки';
    console.error('❌ Init error:', err);
    alert(`Не удалось загрузить ${customConfig}\nПроверьте что файл лежит рядом с index.html`);
  }

  els.nextBtn.addEventListener('click', () => {
    playSound('click');
    nextLesson();
  });
  els.resetBtn.addEventListener('click', () => {
    playSound('click');
    resetProgress();
  });
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
 * Выбор провайдера — всегда явный из урока или stage
 * Если урок имеет runtime.image_words → static (обратная совместимость)
 */
function selectProvider(stage, lessonConfig) {
  // Явный runtime = статический урок
  if (lessonConfig?.runtime?.image_words?.length) return PROVIDERS.static;
  const name = lessonConfig?.provider || stage?.provider || 'static';
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

  // Определяем урок: статический из списка или виртуальный для динамической стадии
  let lessonConfig;
  if (state.lessonIdx < lessons.length) {
    lessonConfig = lessons[state.lessonIdx];
  } else if (stage.provider && !lessons.length) {
    // Динамическая стадия без уроков — генерируем на лету
    lessonConfig = { provider: stage.provider, config: stage };
  } else {
    showEndScreen(true);
    return;
  }

  state.providerInstance = selectProvider(stage, lessonConfig);

  // Формируем config: мержим stage (word_pool, assetBaseUrl и т.д.) + overrides урока
  const mergedConfig = {
    ...stage,
    assetBaseUrl: lessonConfig.config?.assetBaseUrl || stage.assetBaseUrl, // ← Приоритет у урока
    ...(lessonConfig.config || lessonConfig.runtime || {})
  };

  const context = {
    config: mergedConfig,
    metrics: { ...state.metrics },
    isRetry,
    cachedRuntime: state.currentRuntime
  };

  const runtime = state.providerInstance.generate(context);
  if (!runtime) { showEndScreen(true); return; }

  // Передаём assetBaseUrl в runtime для renderLesson
  runtime.assetBaseUrl = mergedConfig.assetBaseUrl;

  state.currentRuntime = runtime; // 🔒 Сохраняем для retry
  state.metrics.startTime = Date.now();

  const meta = lessonConfig.meta || {};
  renderLesson(runtime, meta);
}

function renderLesson(runtime, meta) {
  els.targetWord.textContent = runtime.target_word;
  updateUI();

  // Приоритет: URL из урока → глобальный URL из конфига
  const baseUrl = runtime.assetBaseUrl || CONFIG.imageBaseUrl;

  const imageWords = [...runtime.image_words];
  const correctWord = imageWords[runtime.correct_image_index ?? 0];
  for (let i = imageWords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [imageWords[i], imageWords[j]] = [imageWords[j], imageWords[i]];
  }
  const newCorrectIndex = imageWords.indexOf(correctWord);

  window.__lastCorrectIndex = newCorrectIndex;
  window.__lastTargetWord = runtime.target_word;
  window.__lastShuffledWords = [...imageWords];

  imageWords.forEach((word, idx) => {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.index = idx;
    const img = document.createElement('img');
    const assetKey = resolveAssetKey(word);
    // Собираем URL: baseUrl + assetKey + суффикс
    img.src = `${baseUrl}${assetKey}${CONFIG.imageSuffix}`;
    img.alt = word;
    img.loading = 'lazy';
    img.onerror = () => { img.src = SVG_FALLBACK; };
    card.appendChild(img);
    card.addEventListener('click', () => handleAnswer(idx, newCorrectIndex, meta));
    els.grid.appendChild(card);
  });
}

// ==========================================
// 🎯 ANSWER HANDLING
// ==========================================
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
  console.log('👆 Next button clicked');
  try {
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
  } catch (e) {
    console.error('Next lesson error:', e);
  }
}

function showEndScreen(isWin) {
  els.endTitle.textContent = isWin ? '🏆 Курс пройден!' : '💔 Жизни закончились';
  playSound(isWin ? 'win' : 'lose');

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
      // 🔁 Откат до начала секции + восстановление жизней
      state.lessonIdx = 0;
      state.lives = 3;
      saveProgress();
      updateUI();
      els.endModal.classList.add('hidden');
      startLesson(false);
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
