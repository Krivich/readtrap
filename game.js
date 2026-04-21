// ==========================================
// 🧩 PROVIDER SYSTEM
// ==========================================

// ==========================================
// 🗃️ MANIFEST RESOLVER (NEW FORMAT v2.0)
// ==========================================
let globalManifest = null;
let manifestLoadPromise = null;

async function loadGlobalManifest() {
    if (globalManifest) return globalManifest;
    if (manifestLoadPromise) return manifestLoadPromise;

    manifestLoadPromise = (async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch('https://krivich.github.io/open-word-images/manifest.json', { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);

            const raw = await res.json();

            // 🔑 Нормализация: убираем пробелы из ключей (демо-формат)
            const normalize = (obj) => {
                if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
                const result = {};
                for (const [k, v] of Object.entries(obj)) {
                    const key = k.trim();
                    result[key] = normalize(v);
                }
                return result;
            };

            globalManifest = {
                version: raw.version,
                words: normalize(raw.words || {}),
                concepts: normalize(raw.concepts || {})
            };

            console.log(`📚 Manifest loaded: ${Object.keys(globalManifest.words).length} words, ${Object.keys(globalManifest.concepts).length} concepts`);
            return globalManifest;
        } catch (e) {
            console.error('❌ Manifest load failed:', e.message);
            return null;
        }
    })();

    return manifestLoadPromise;
}

/**
 * 🔍 Преобразует слово → путь к превью 256px из манифеста
 * @returns {string|null} Путь вида "default/thumbs/256/бак_v1.png" или null
 */
function resolveWordToManifestPath(word, targetLang = 'rus') {
    if (!word || !globalManifest?.words || !globalManifest?.concepts) return null;

    const cleanWord = word.replace(/[·]/g, '').trim();
    const wordEntry = globalManifest.words[cleanWord];
    if (!wordEntry) return null;

    const conceptKey = wordEntry.concept || cleanWord;
    const concept = globalManifest.concepts[conceptKey];
    if (!concept) return null;

    if (concept.concept) {
        const linkedConcept = globalManifest.concepts[concept.concept];
        if (!linkedConcept) return null;
        return resolveConceptToPath(linkedConcept);
    }

    return resolveConceptToPath(concept);

    function resolveConceptToPath(c) {
        const styleName = (c.default_style || 'default').trim();
        const style = c.styles?.[styleName];
        if (!style) return null;

        const versionIndex = style.best ?? style.latest;
        if (versionIndex == null) return null;

        const version = style.versions?.find(v => v.n === versionIndex);
        return version?.previews?.['256']?.trim() || null;
    }

    const styleName = (concept.default_style || 'default').trim();
    const style = concept.styles?.[styleName];
    if (!style) return null;

    // best имеет приоритет над latest
    const versionIndex = style.best ?? style.latest;
    if (versionIndex == null) return null;

    const version = style.versions?.find(v => v.n === versionIndex);
    return version?.previews?.['256']?.trim() || null;
}

/**
 * 🌐 Преобразует слово → полный URL картинки
 * Приоритет: runtime.image_urls → manifest → assetMap → fallback
 */
function getImageUrlForWord(word, runtimeImageUrls = null, targetLang = 'rus') {
    if (!word) return SVG_FALLBACK;
    const cleanWord = word.replace(/[·]/g, '').trim();

    // 1. Pre-resolved URL из runtime (научный провайдер)
    if (runtimeImageUrls?.[cleanWord]) {
        return runtimeImageUrls[cleanWord];
    }

    // 2. Manifest-based resolution
    const manifestPath = resolveWordToManifestPath(cleanWord, targetLang);
    if (manifestPath) {
        return `https://krivich.github.io/open-word-images/styles/${manifestPath}`;
    }

    // 3. Asset map (legacy override)
    if (state.assetMap[cleanWord]) {
        const mapped = state.assetMap[cleanWord];
        return mapped.startsWith('http') ? mapped : SVG_FALLBACK;
    }

    // 4. Fallback
    return SVG_FALLBACK;
}

/**
 * 🔑 Legacy: возвращает очищенный ключ для assetMap lookup
 */
function resolveAssetKey(word) {
    return word ? word.replace(/[·]/g, '').trim().toLowerCase() : '';
}


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

class CombinatorialProvider extends BaseProvider {
    constructor() { super(); this.usage = new Map(); }
    generate(ctx) {
        if (ctx.isRetry && ctx.cachedRuntime) return ctx.cachedRuntime;
        const c = ctx.config;
        const pool = c.word_pool || [];
        if (!pool.length) return { target_word: 'НЕТ ДАННЫХ', image_words: ['кот','кит','рот','сом'], correct_image_index: 0 };
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
 🔬 ScientificProvider — генерирует курс из манифеста open-word-images (NEW FORMAT v2.0)
 */
class ScientificProvider extends BaseProvider {
    constructor() {
        super();
        this.wordPool = null;
        this.stageWords = { A1: [], A2: [], B1: [], B2: [] };
        this.usage = new Map();
        this.manifestUrl = 'https://krivich.github.io/open-word-images/manifest.json';
        this.targetLang = 'rus';
    }

    async loadManifest() {
        if (this.wordPool) return this.wordPool;

        await loadGlobalManifest();
        if (!globalManifest) return this.wordPool = [];

        const validWords = [];

        if (!globalManifest.words) {
            this.wordPool = validWords;
            return validWords;
        }

        const RUSSIAN_CHARS = /^[а-яёА-ЯЁ\-]+$/;

        for (const [word, wordEntry] of Object.entries(globalManifest.words)) {
            const lang = wordEntry?.language;
            if (lang === 'rus') {
                // ОК - явно русское
            } else if (!lang || lang === '' || lang === 'default') {
                // Нет language или default - проверяем буквы
                if (!RUSSIAN_CHARS.test(word)) continue;
            } else {
                // eng или другой - пропускаем
                continue;
            }

            const conceptKey = wordEntry.concept || word;
            const concept = globalManifest.concepts[conceptKey];
            if (!concept || concept.concept) continue;

            const styleName = (concept.default_style || 'default').trim();
            const style = concept.styles?.[styleName];
            if (!style) continue;

            const versionIndex = style.best;
            if (!versionIndex) continue;

            const version = style.versions?.find(v => v.n === versionIndex);
            const previewPath = version?.previews?.['256']?.trim();
            if (!previewPath) continue;

            validWords.push({
                word,
                imageUrl: `https://krivich.github.io/open-word-images/styles/${previewPath}`,
                concept: word,
                style: styleName
            });
        }

        this.wordPool = validWords;
        console.log(`📚 Scientific: ${validWords.length} valid words`);
        return validWords;
    }

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
        if (!this.wordPool.length) return [];

        this.stageWords = this.categorize(this.wordPool);

        for (const stageKey of Object.keys(this.stageWords)) {
            this.stageWords[stageKey] = this._shuffle(this.stageWords[stageKey]);
        }

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
                        distractor_pool: distractors.map(w => w.word),
                        distractor_count: 3,
                        image_urls: {
                            [target.word]: target.imageUrl,
                            ...Object.fromEntries(distractors.map(w => [w.word, w.imageUrl]))
                        }
                    },
                    meta: {
                        pedagogical_goal: `Чтение "${target.word}" (${stageId})`,
                        difficulty: { A1: 1, A2: 3, B1: 5, B2: 7 }[stageId],
                        theme: 'Scientific',
                        trap_logic: `Замена: ${target.word[0]}→${distractors.map(w => w.word[0]).join(',')}`,
                        parent_note: `«${target.word} — это ${this.getHint(target.word)}, а ${distractors[0].word} — другое»`
                    }
                });
            }
            stages.push({
                id: stageId,
                name: { A1: 'Первые звуки', A2: 'Простые слова', B1: 'Сложные слова', B2: 'Длинные слова' }[stageId],
                description: { A1: 'Короткие слова', A2: 'Слова до 5 букв', B1: 'Слова 5-8 букв', B2: 'Длинные слова' }[stageId],
                provider: 'scientific',
                word_pool: words.map(w => w.word),
                lessons
            });
        }
        return stages;
    }

    selectDistractors(target, pool, count) {
        const filtered = pool.filter(w => w.word !== target.word);
        if (filtered.length <= count) return filtered;

        const scored = filtered.map(w => {
            const lenDiff = Math.abs(w.word.length - target.word.length);
            const common = w.word.split('').filter(c => target.word.includes(c)).length;
            const firstDiff = w.word[0] !== target.word[0] ? 1 : 0;
            return { word: w.word, score: lenDiff * 2 - common - firstDiff + Math.random() * 0.5 };
        });
        scored.sort((a, b) => a.score - b.score);
        return scored.slice(0, count);
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
            correct_image_index: 0,
            image_urls: c.image_urls || null
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

class StageIterator {
    constructor(stageConfig) {
        this.stageConfig = stageConfig;
        this.log = [];
        this.providerName = stageConfig.provider || 'static';
        this.provider = PROVIDERS[this.providerName] || PROVIDERS.static;
        this.metrics = {};
    }

    getLesson(index, isRetry = false) {
        if (index < this.log.length) {
            return this.log[index];
        }

        if (this.stageConfig.lessons && index < this.stageConfig.lessons.length) {
            const lesson = this.stageConfig.lessons[index];
            this.log.push(lesson);
            return lesson;
        }

        if (this.provider && typeof this.provider.generate === 'function') {
            const ctx = {
                config: {
                    ...this.stageConfig,
                    history: this.log,
                    lessonIndex: index
                },
                metrics: this.metrics,
                isRetry,
                cachedRuntime: null
            };

            let lessonData = this.provider.generate(ctx);
            if (!lessonData) return null;

            if (!lessonData.meta) lessonData.meta = { theme: this.stageConfig.name || 'Dynamic' };
            if (!lessonData.id) lessonData.id = `${this.stageConfig.id}-L${String(index + 1).padStart(2, '0')}`;

            this.log.push(lessonData);
            return lessonData;
        }

        return null;
    }

    reset() {
        this.log = [];
    }
}

const SVG_FALLBACK = 'data:image/svg+xml,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect fill="#f8f9fa" width="256" height="256"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="64" fill="#6c757d">⏳</text></svg>');

// ==========================================
// 🔊 ЗВУКИ
// ==========================================
const sounds = {
    click: null,
    success: null,
    wrong: null,
    win: null,
    lose: null
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
    storageKey: 'reading_game_progress_v2'
};

let state = {
    curriculum: null,
    stageIdx: 0,
    lessonIdx: 0,
    lives: 3,
    isAnswered: false,
    currentRuntime: null,
    assetMap: {},
    providerInstance: null,
    currentIterator: null,
    pendingLessonsLog: null,
    showSyllables: true,
    targetLang: 'rus',
    metrics: {
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
const VOWELS = new Set('аеёиоуыэюяАЕЁИОУЫЭЮЯ');
const SONORANTS = new Set('йлрмнЙЛРМН');
const HARD_SIGNS = new Set('ъьЪЬ');

function syllabify(word) {
    if (!word || word.length < 2) return word;
    const chars = [...word];
    const vowelIndices = [];
    for (let i = 0; i < chars.length; i++) {
        if (VOWELS.has(chars[i])) vowelIndices.push(i);
    }
    if (vowelIndices.length <= 1) return word;

    const breaks = [];
    for (let v = 0; v < vowelIndices.length - 1; v++) {
        const currV = vowelIndices[v];
        const nextV = vowelIndices[v + 1];
        const between = chars.slice(currV + 1, nextV);

        if (between.length === 0) {
            breaks.push(currV + 1);
        } else if (between.length === 1) {
            breaks.push(currV + 1);
        } else {
            let splitPos = currV + 1;
            let lastSpecial = -1;
            for (let i = 0; i < between.length; i++) {
                if (HARD_SIGNS.has(between[i]) || between[i] === 'й' || between[i] === 'Й') {
                    lastSpecial = i;
                }
            }

            if (lastSpecial >= 0) {
                splitPos = currV + 1 + lastSpecial + 1;
            } else {
                const voiced = new Set('бвгджз');
                const voiceless = new Set('пфктшсчщхц');
                let foundVoicingBoundary = false;

                for (let i = 0; i < between.length - 1; i++) {
                    const curr = between[i].toLowerCase();
                    const next = between[i + 1].toLowerCase();

                    const isVoicedCurr = voiced.has(curr) || SONORANTS.has(between[i]);
                    const isVoicelessNext = voiceless.has(next);
                    const isVoicelessCurr = voiceless.has(curr);
                    const isVoicedNext = voiced.has(next) || SONORANTS.has(between[i + 1]);

                    if (isVoicelessCurr && isVoicedNext) {
                        splitPos = currV + 1 + i + 1;
                        foundVoicingBoundary = true;
                        break;
                    }

                    if (isVoicedCurr && !SONORANTS.has(between[i]) && isVoicelessNext) {
                        splitPos = currV + 1 + i + 1;
                        foundVoicingBoundary = true;
                        break;
                    }
                }

                if (!foundVoicingBoundary) {
                    const mid = Math.ceil(between.length / 2);
                    splitPos = currV + 1 + mid;
                }
            }
            breaks.push(splitPos);
        }
    }

    let result = '';
    let breakIdx = 0;
    for (let i = 0; i < chars.length; i++) {
        result += chars[i];
        if (breakIdx < breaks.length && i === breaks[breakIdx] - 1) {
            result += '·';
            breakIdx++;
        }
    }
    return result;
}

function calculateAvgReaction(reactionTime) {
    const m = state.metrics;
    if (m.totalAnswers === 1) return reactionTime;
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

    // Загружаем манифест фоном
    loadGlobalManifest();

    document.addEventListener('click', (e) => {
        if (e.target.closest('#next-btn')) {
            playSound('click');
            nextLesson();
        }
        if (e.target.closest('#reset-btn')) {
            playSound('click');
            resetProgress();
        }
        if (e.target.closest('#restart-btn')) {
            const btn = e.target.closest('#restart-btn');
            if (btn.onclick) btn.onclick();
        }
    });

    btnEasy.addEventListener('click', () => startGame('curriculum-simple.json'));
    btnNormal.addEventListener('click', () => startGame('curriculum.json'));
    btnScientific.addEventListener('click', () => startScientific());

    const params = new URLSearchParams(window.location.search);
    if (params.get('level') === 'scientific') {
        startScientific();
    } else if (params.get('curriculum')) {
        startGame(params.get('curriculum'));
    }
}

async function startScientific() {
    startScreen.classList.add('hidden');
    gameContainer.classList.remove('hidden');
    document.getElementById('game-screen').classList.remove('hidden');
    loadProgress();

    try {
        const provider = PROVIDERS.scientific;
        const stages = await provider.generateStages(10);
        if (!stages.length) throw new Error('Нет стадий');

        state.curriculum = {
            meta: { project: 'ninachit-scientific', version: '3.0.0' },
            default_provider: 'scientific',
            asset_map: {},
            stages
        };
        enterStage();
        startLesson(false);
    } catch (e) {
        console.error('❌ Scientific init error:', e);
        els.targetWord.textContent = `❌ ${e.message}`;
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
        enterStage();
        startLesson(false);
    } catch (err) {
        els.targetWord.textContent = '❌ Ошибка загрузки';
        console.error('❌ Init error:', err);
    }
}

function enterStage() {
    const stage = state.curriculum.stages[state.stageIdx];
    if (!stage) { showEndScreen(true); return; }

    state.currentIterator = new StageIterator(stage);

    if (state.pendingLessonsLog && state.pendingLessonsLog.length > 0) {
        state.currentIterator.log = state.pendingLessonsLog;
        state.pendingLessonsLog = null;
    }

    state.assetMap = {
        ...(state.curriculum.asset_map || {}),
        ...(state.curriculum.stages[state.stageIdx]?.asset_map || {})
    };

    if (state.lessonIdx === 0 || state.lessonIdx >= (state.curriculum.stages[state.stageIdx]?.lessons?.length || 0)) {
        state.lessonIdx = 0;
    }
}

function loadProgress() {
    const saved = localStorage.getItem(CONFIG.storageKey);
    if (saved) {
        try {
            const p = JSON.parse(saved);
            state.stageIdx = p.stageIdx ?? 0;
            state.lessonIdx = p.lessonIdx ?? 0;
            state.lives = p.lives ?? 3;
            if (p.metrics) state.metrics = { ...state.metrics, ...p.metrics };

            if (p.lessonsLog && Array.isArray(p.lessonsLog)) {
                state.pendingLessonsLog = p.lessonsLog;
            }
        } catch (e) { console.warn('⚠️ Progress parse error:', e); }
    }
    updateUI();
}

function saveProgress() {
    const data = {
        stageIdx: state.stageIdx,
        lessonIdx: state.lessonIdx,
        lives: state.lives,
        metrics: { ...state.metrics, avgReaction: state.metrics.avgReaction },
        lastActive: new Date().toISOString()
    };

    if (state.currentIterator) {
        data.lessonsLog = state.currentIterator.log;
    }
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
}

function updateUI() {
    els.lives.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(Math.max(0, 3 - state.lives));
    els.level.textContent = state.stageIdx * 10 + state.lessonIdx + 1;
}

function startLesson(isRetry = false) {
    state.isAnswered = false;
    els.feedbackOverlay.classList.add('hidden');
    els.parentZone.classList.add('hidden');
    els.nextBtn.style.display = 'none';
    els.grid.innerHTML = '';

    if (!state.currentIterator) { showEndScreen(true); return; }
    const lessonConfig = state.currentIterator.getLesson(state.lessonIdx, isRetry);
    if (!lessonConfig) { showEndScreen(true); return; }

    state.providerInstance = state.currentIterator.provider;
    const stage = state.curriculum.stages[state.stageIdx];
    const mergedConfig = {
        ...stage,
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

    state.currentRuntime = runtime;
    state.metrics.startTime = Date.now();

    const meta = lessonConfig.meta || {};
    renderLesson(runtime, meta);
}

function renderLesson(runtime, meta) {
    const displayWord = state.showSyllables
        ? syllabify(runtime.target_word)
        : runtime.target_word;
    els.targetWord.textContent = displayWord;
    updateUI();

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

    // 🖼️ Рендер карточек — getImageUrlForWord возвращает ПОЛНЫЙ URL
    imageWords.forEach((word, idx) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        card.dataset.index = idx;

        const img = document.createElement('img');

        // 🎯 Единая точка получения URL — чисто и понятно
        img.src = getImageUrlForWord(word, runtime.image_urls, state.targetLang);
        img.alt = word;
        img.loading = 'lazy';
        img.onerror = () => { img.src = SVG_FALLBACK; };

        card.appendChild(img);
        card.addEventListener('click', () => handleAnswer(idx, newCorrectIndex, meta));
        els.grid.appendChild(card);
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

    if (isCorrect) playSound('success');
    else playSound('wrong');

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
    prefetchNextLesson();
}

function prefetchNextLesson() {
    if (!state.currentIterator) return;
    const nextIdx = state.lessonIdx + 1;
    const nextLesson = state.currentIterator.getLesson(nextIdx);

    if (nextLesson) {
        const wordsToLoad = nextLesson.config?.distractor_pool
            ? [nextLesson.config.target_word, ...nextLesson.config.distractor_pool]
            : nextLesson.runtime?.image_words || [];

        if (wordsToLoad.length) {
            // 🔄 Предзагрузка: getImageUrlForWord возвращает полный URL
            wordsToLoad.forEach(word => {
                if (!word) return;
                const imgUrl = getImageUrlForWord(word, nextLesson.config?.image_urls, state.targetLang);
                if (imgUrl && imgUrl !== SVG_FALLBACK) {
                    const img = new Image();
                    img.src = imgUrl;
                }
            });
        }
    }
}

function nextLesson() {
    const wordEl = document.getElementById('target-word');
    if (wordEl) wordEl.textContent = 'Loading...';

    try {
        state.currentRuntime = null;
        state.lessonIdx++;

        const stage = state.curriculum.stages[state.stageIdx];
        const lessons = stage?.lessons || [];
        const isDynamicStage = stage?.provider && !stage?.lessons?.length;

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
        console.error('❌ [nextLesson] Ошибка:', e);
        if (wordEl) wordEl.textContent = `Error: ${e.message}`;
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

// Экспорт для тестирования
window.state = state;
window.__getIteratorLogLength = () => state.currentIterator ? state.currentIterator.log.length : 0;

// Старт
init();