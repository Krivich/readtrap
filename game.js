// Конфигурация
const CONFIG = {
  curriculumPath: 'curriculum.json',
  imageBaseUrl: 'http://127.0.0.1:8080/styles/flat/',
  imageSuffix: '_latest.png',
  storageKey: 'reading_game_progress'
};

// Состояние игры
let state = {
  curriculum: null,
  stageIdx: 0,
  lessonIdx: 0,
  lives: 3,
  isAnswered: false
};

// DOM элементы
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

// Инициализация
async function init() {
  loadProgress();

  try {
    const res = await fetch(CONFIG.curriculumPath);
    if (!res.ok) throw new Error('Не удалось загрузить curriculum.json');
    state.curriculum = await res.json();
    startLesson();
  } catch (err) {
    els.targetWord.textContent = '❌ Ошибка загрузки';
    console.error(err);
    alert('Положите curriculum.json в одну папку с игрой и запустите через локальный сервер (например, Live Server в VSCode)');
  }

  els.nextBtn.addEventListener('click', nextLesson);
  els.resetBtn.addEventListener('click', resetProgress);
  els.restartBtn.addEventListener('click', () => {
    localStorage.removeItem(CONFIG.storageKey);
    location.reload();
  });
}

// Загрузка прогресса
function loadProgress() {
  const saved = localStorage.getItem(CONFIG.storageKey);
  if (saved) {
    const parsed = JSON.parse(saved);
    state.stageIdx = parsed.stageIdx ?? 0;
    state.lessonIdx = parsed.lessonIdx ?? 0;
    state.lives = parsed.lives ?? 3;
  }
  updateUI();
}

// Сохранение прогресса
function saveProgress() {
  localStorage.setItem(CONFIG.storageKey, JSON.stringify({
    stageIdx: state.stageIdx,
    lessonIdx: state.lessonIdx,
    lives: state.lives,
    lastActive: new Date().toISOString()
  }));
}

// Обновление UI
function updateUI() {
  els.lives.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(Math.max(0, 3 - state.lives));
  els.level.textContent = state.stageIdx * 10 + state.lessonIdx + 1;
}

// Запуск урока
function startLesson() {
  state.isAnswered = false;
  els.feedbackOverlay.classList.add('hidden');
  els.parentZone.classList.add('hidden');
  els.grid.innerHTML = '';

  const stage = state.curriculum.stages[state.stageIdx];
  const lesson = stage.lessons[state.lessonIdx];

  if (!lesson) {
    showEndScreen(true);
    return;
  }

  els.targetWord.textContent = lesson.runtime.target_word;
  updateUI();

  // Генерация карточек
  lesson.runtime.image_words.forEach((word, idx) => {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.index = idx;

    const img = document.createElement('img');
    img.src = `${CONFIG.imageBaseUrl}${word}_latest.png`;
    img.alt = word;
    img.loading = 'lazy';
    img.onerror = () => {
      img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23eee"/><text x="50" y="50" text-anchor="middle" dy=".3em" font-size="14" fill="%23999">⏳</text></svg>';
    };

    card.appendChild(img);
    card.addEventListener('click', () => handleAnswer(idx, lesson));
    els.grid.appendChild(card);
  });
}

// Обработка ответа
function handleAnswer(selectedIdx, lesson) {
  if (state.isAnswered) return;
  state.isAnswered = true;

  const isCorrect = selectedIdx === lesson.runtime.correct_image_index;
  const cards = document.querySelectorAll('.image-card');

  cards.forEach(c => c.classList.add('disabled'));
  cards[selectedIdx].classList.add(isCorrect ? 'correct' : 'wrong');
  if (!isCorrect) {
    cards[lesson.runtime.correct_image_index].classList.add('correct');
  }

  // Обратная связь
  els.feedbackIcon.textContent = isCorrect ? '🎉' : '❌';
  els.feedbackText.textContent = isCorrect ? 'Правильно!' : 'Не совсем, смотри:';
  els.feedbackOverlay.classList.remove('hidden');

  // Подсказка для родителей
  if (lesson.meta?.parent_note) {
    els.parentHint.textContent = lesson.meta.parent_note;
    els.parentZone.classList.remove('hidden');
  } else {
    els.parentZone.classList.add('hidden');
  }

  // Логика жизней и перехода
  if (isCorrect) {
    els.nextBtn.style.display = '';
  } else {
    els.nextBtn.style.display = 'none';
    state.lives--;
    updateUI();
    saveProgress();

    if (state.lives <= 0) {
      setTimeout(() => showEndScreen(false), 1500);
    } else {
      setTimeout(() => nextLesson(), 2000);
    }
  }
}

// Следующий урок
function nextLesson() {
  state.lessonIdx++;

  const stage = state.curriculum.stages[state.stageIdx];
  if (state.lessonIdx >= stage.lessons.length) {
    state.lessonIdx = 0;
    state.stageIdx++;
    if (state.stageIdx >= state.curriculum.stages.length) {
      showEndScreen(true);
      return;
    }
  }

  saveProgress();
  els.feedbackOverlay.classList.add('hidden');
  startLesson();
}

// Экран завершения
function showEndScreen(isWin) {
  els.endTitle.textContent = isWin ? '🏆 Курс пройден!' : '💔 Жизни закончились';
  els.endMessage.textContent = isWin
    ? 'Ты отлично читаешь! Продолжай в том же духе.'
    : 'Не расстраивайся! Попробуй ещё раз.';
  els.endModal.classList.remove('hidden');
}

// Сброс прогресса
function resetProgress() {
  if (confirm('Сбросить весь прогресс и начать сначала?')) {
    localStorage.removeItem(CONFIG.storageKey);
    location.reload();
  }
}

// Старт
init();
