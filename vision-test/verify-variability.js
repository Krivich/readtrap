/**
 * Проверка вариативности провайдеров
 * Запускает генерацию уроков 3 раза и сравнивает результаты
 */
const fs = require('fs');
const path = require('path');

// Копия логики провайдеров (упрощённая для Node)
class BaseProvider {
  generate(ctx) { throw new Error('Not implemented'); }
  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

class StaticProvider extends BaseProvider {
  generate(ctx) {
    const c = ctx.config;
    const target = c.target_word || '???';
    let imageWords;
    if (c.image_words?.length) imageWords = [...c.image_words];
    else if (c.distractors?.length) imageWords = [target.toLowerCase(), ...c.distractors];
    else if (c.distractor_pool?.length) {
      const pool = c.distractor_pool.filter(w => w.toLowerCase() !== target.toLowerCase());
      const count = c.distractor_count || 3;
      imageWords = [target.toLowerCase(), ...this._shuffle(pool).slice(0, count)];
    } else imageWords = [];
    return { target_word: target.toUpperCase(), image_words: imageWords, correct_image_index: 0 };
  }
}

class PoolProvider extends BaseProvider {
  generate(ctx) {
    const c = ctx.config;
    const target = c.target_word;
    const pool = c.distractor_pool || c.word_pool || [];
    const count = c.distractor_count || 3;
    const filtered = pool.filter(w => w.toLowerCase() !== target.toLowerCase());
    const distractors = this._shuffle([...filtered]).slice(0, count);
    return { target_word: target.toUpperCase(), image_words: [target.toLowerCase(), ...distractors], correct_image_index: 0 };
  }
}

class CombinatorialProvider extends BaseProvider {
  constructor() { super(); this.usage = new Map(); }
  generate(ctx) {
    const c = ctx.config;
    const pool = c.word_pool || [];
    if (!pool.length) return { target_word: 'НЕТ ДАННЫХ', image_words: ['кот','кит','рот','сом'], correct_image_index: 0 };
    let target = pool[0], minUsage = Infinity;
    for (const w of pool) {
      const u = this.usage.get(w) || 0;
      if (u < minUsage) { minUsage = u; target = w; }
    }
    const count = c.distractor_count || 3;
    const filtered = pool.filter(w => w.toLowerCase() !== target.toLowerCase());
    const distractors = this._shuffle([...filtered]).slice(0, count);
    this.usage.set(target, (this.usage.get(target) || 0) + 1);
    return { target_word: target.toUpperCase(), image_words: [target.toLowerCase(), ...distractors], correct_image_index: 0 };
  }
}

const PROVIDERS = {
  static: new StaticProvider(),
  pool: new PoolProvider(),
  combinatorial: new CombinatorialProvider()
};

function selectProvider(stage, lesson) {
  const name = lesson?.provider || stage?.provider || 'static';
  return PROVIDERS[name] || PROVIDERS.static;
}

function runSession(curriculum) {
  const results = [];
  let stageIdx = 0, lessonIdx = 0;

  while (stageIdx < curriculum.stages.length) {
    const stage = curriculum.stages[stageIdx];
    const lessons = stage.lessons || [];

    if (lessonIdx < lessons.length) {
      const lesson = lessons[lessonIdx];
      const provider = selectProvider(stage, lesson);
      // Сброс usage для честного сравнения между запусками
      if (provider instanceof CombinatorialProvider) provider.usage = new Map();

      const mergedConfig = { ...stage, ...(lesson.config || lesson.runtime || {}) };
      const runtime = provider.generate({ config: mergedConfig });
      results.push({ stage: stage.id, lesson: lesson.id, word: runtime.target_word, images: runtime.image_words });
      lessonIdx++;
    } else if (stage.provider && !lessons.length) {
      const provider = selectProvider(stage, { provider: stage.provider, config: stage });
      if (provider instanceof CombinatorialProvider) provider.usage = new Map();
      const mergedConfig = { ...stage };
      const runtime = provider.generate({ config: mergedConfig });
      results.push({ stage: stage.id, lesson: `DYN-${lessonIdx}`, word: runtime.target_word, images: runtime.image_words });
      lessonIdx++;
    } else {
      stageIdx++; lessonIdx = 0; continue;
    }
  }
  return results;
}

// Запуск
const curriculum = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'curriculum.v2.json'), 'utf8'));
const sessions = [];
const numSessions = 3;

for (let i = 0; i < numSessions; i++) sessions.push(runSession(curriculum));

console.log(`📊 Проверка вариативности (${numSessions} независимых запусков)\n`);

let allIdentical = true;
const first = sessions[0];

for (let i = 1; i < sessions.length; i++) {
  const session = sessions[i];
  let diffCount = 0;
  for (let j = 0; j < first.length; j++) {
    const a = first[j], b = session[j];
    if (a.word !== b.word || JSON.stringify(a.images) !== JSON.stringify(b.images)) diffCount++;
  }
  if (diffCount === 0) {
    console.log(`Запуск ${i + 1}: ИДЕНТИЧЕН запуску 1 ❌`);
  } else {
    console.log(`Запуск ${i + 1}: Отличается в ${diffCount} из ${first.length} уроках ✅`);
    allIdentical = false;
  }
}

console.log(allIdentical ? '\n⚠️ ВНИМАНИЕ: Все запуски идентичны!' : '\n✅ ОТЛИЧНО: Запуски различаются. Вариативность работает!');

// Детализация по типам провайдеров
console.log('\n📈 Различия по типам провайдеров:');
const byType = { static: 0, pool: 0, combinatorial: 0 };
first.forEach((f, idx) => {
  let changed = false;
  for (let s = 1; s < sessions.length; s++) {
    if (JSON.stringify(f) !== JSON.stringify(sessions[s][idx])) { changed = true; break; }
  }
  if (changed) {
    // Определяем тип провайдера урока
    const stage = curriculum.stages.find(st => st.id === f.stage);
    const lesson = stage?.lessons?.find(l => l.id === f.lesson);
    const type = lesson?.provider || stage?.provider || 'static';
    byType[type] = (byType[type] || 0) + 1;
  }
});
Object.entries(byType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count} уроков меняются между запусками`);
});

console.log('\n📝 Примеры (первые 5 уроков):');
for (let j = 0; j < 5; j++) {
  console.log(`\nУрок ${j + 1} (${first[j].stage} ${first[j].lesson}):`);
  sessions.forEach((s, idx) => {
    console.log(`  Запуск ${idx + 1}: "${s[j].word}" → [${s[j].images.join(', ')}]`);
  });
}
