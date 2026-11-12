/**
 * Интерфейс MAV. Без фреймворков: DOM и fetch.
 *
 * Ключ API берётся из localStorage, если сервер его требует. Это осознанно
 * простой вариант: сервис рассчитан на localhost и одного пользователя.
 */

const $ = (selector) => document.querySelector(selector);

const state = {
  voices: [],
  sttModels: [],
  apiKey: localStorage.getItem('mav-api-key') || '',
};

/* ---------- сеть ---------- */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
  if (options.json) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
    delete options.json;
  }

  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get('content-type') || '';

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    if (type.includes('application/json')) {
      const body = await response.json().catch(() => ({}));
      message = body.error || message;
    }
    if (response.status === 401) {
      const key = prompt('Сервис требует ключ MAV_API_KEY:');
      if (key) {
        state.apiKey = key;
        localStorage.setItem('mav-api-key', key);
        return api(path, options);
      }
    }
    throw new Error(message);
  }

  return type.includes('application/json') ? response.json() : response;
}

/* ---------- вспомогательное ---------- */

function setHint(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `hint${kind ? ` ${kind}` : ''}`;
}

function busy(button, on, label) {
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.innerHTML = `<span class="spinner"></span>${label || 'Работаю…'}`;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function fmtDuration(seconds) {
  if (!seconds) return '—';
  const total = Math.round(seconds);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min ? `${min} мин ${sec} с` : `${sec} с`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function audioPlayer(url) {
  const audio = document.createElement('audio');
  audio.controls = true;
  // Тег <audio> не отправляет заголовок Authorization, поэтому ключ идёт в query.
  audio.src = state.apiKey ? `${url}?key=${encodeURIComponent(state.apiKey)}` : url;
  return audio;
}

function metaRow(pairs) {
  const box = document.createElement('div');
  box.className = 'meta';
  for (const [label, value] of pairs) {
    const item = document.createElement('span');
    item.innerHTML = `${label}: <b>${value}</b>`;
    box.append(item);
  }
  return box;
}

function fillVoices(select, voices) {
  select.replaceChildren();
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = `${voice.title} · ${voice.note}`;
    select.append(option);
  }
}

/* ---------- вкладки ---------- */

function initTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('active', panel.id === `panel-${tab.dataset.tab}`);
      }
      if (tab.dataset.tab === 'history') loadHistory();
    });
  }
}

/* ---------- статус ---------- */

async function loadStatus() {
  const dot = $('#status-dot');
  const text = $('#status-text');
  try {
    const health = await api('/api/health');
    const engines = Object.entries(health.engines || {})
      .map(([id, ok]) => `${id}: ${ok ? 'да' : 'нет'}`)
      .join(', ');
    dot.className = 'dot ok';
    text.textContent = `шлюз доступен · ${engines}`;
  } catch (err) {
    dot.className = 'dot err';
    text.textContent = err.message;
  }
}

async function loadVoices() {
  const data = await api('/api/voices');
  state.voices = data.voices;
  state.sttModels = data.sttModels || [];
  for (const id of ['#speech-voice', '#book-voice', '#dub-voice']) fillVoices($(id), data.voices);

  const stt = $('#dub-stt');
  stt.replaceChildren();
  for (const model of state.sttModels) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    stt.append(option);
  }
}

/* ---------- синтез ---------- */

function initSpeech() {
  const speed = $('#speech-speed');
  speed.addEventListener('input', () => ($('#speech-speed-out').textContent = Number(speed.value).toFixed(2)));

  $('#speech-go').addEventListener('click', async () => {
    const button = $('#speech-go');
    const text = $('#speech-text').value.trim();
    if (!text) {
      setHint('#speech-hint', 'Введите текст', 'err');
      return;
    }

    busy(button, true, 'Синтез…');
    setHint('#speech-hint', '');
    try {
      const result = await api('/api/synthesize', {
        method: 'POST',
        json: {
          text,
          voice: $('#speech-voice').value,
          speed: Number(speed.value),
          format: $('#speech-format').value,
          strip: $('#speech-strip').checked,
        },
      });

      const box = $('#speech-result');
      box.hidden = false;
      box.replaceChildren();
      box.append(audioPlayer(result.url));
      box.append(metaRow([
        ['Длительность', fmtDuration(result.duration)],
        ['Символов', result.characters],
        ['Кусков', result.chunks],
        ['Голос', result.voice],
        ['Формат', result.format.toUpperCase()],
      ]));

      const link = document.createElement('a');
      link.href = result.url;
      link.download = `mav-${result.id}.${result.format}`;
      link.className = 'btn';
      link.textContent = 'Скачать';
      link.style.display = 'inline-block';
      link.style.marginTop = '12px';
      box.append(link);

      setHint('#speech-hint', 'Готово', 'ok');
    } catch (err) {
      setHint('#speech-hint', err.message, 'err');
    } finally {
      busy(button, false);
    }
  });
}

/* ---------- книга ---------- */

function initBook() {
  const speed = $('#book-speed');
  speed.addEventListener('input', () => ($('#book-speed-out').textContent = Number(speed.value).toFixed(2)));

  $('#book-preview').addEventListener('click', async () => {
    const text = $('#book-text').value.trim();
    if (!text) {
      setHint('#book-hint', 'Введите текст', 'err');
      return;
    }
    try {
      const data = await api('/api/chapters', { method: 'POST', json: { text } });
      const box = $('#book-result');
      box.hidden = false;
      box.replaceChildren();
      const title = document.createElement('h3');
      title.textContent = `Главы: ${data.chapters.length}`;
      box.append(title);
      const table = document.createElement('table');
      table.innerHTML = '<tr><th>Глава</th><th>Символов</th></tr>';
      for (const chapter of data.chapters) {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${chapter.title}</td><td>${chapter.characters}</td>`;
        table.append(row);
      }
      box.append(table);
      setHint('#book-hint', '');
    } catch (err) {
      setHint('#book-hint', err.message, 'err');
    }
  });

  $('#book-go').addEventListener('click', async () => {
    const button = $('#book-go');
    const text = $('#book-text').value.trim();
    if (!text) {
      setHint('#book-hint', 'Введите текст', 'err');
      return;
    }

    busy(button, true, 'Озвучка…');
    setHint('#book-hint', 'Длинный текст озвучивается последовательно, это может занять время');
    try {
      const result = await api('/api/narrate', {
        method: 'POST',
        json: { text, voice: $('#book-voice').value, speed: Number(speed.value) },
      });

      const box = $('#book-result');
      box.hidden = false;
      box.replaceChildren();
      const title = document.createElement('h3');
      title.textContent = `Готово: ${result.chapters.length} глав, ${fmtDuration(result.totalDuration)}`;
      box.append(title);

      for (const chapter of result.chapters) {
        const row = document.createElement('div');
        row.className = 'chapter';
        const name = document.createElement('div');
        name.className = 'chapter-title';
        name.textContent = `${chapter.title} · ${fmtDuration(chapter.duration)}`;
        row.append(name, audioPlayer(chapter.url));
        box.append(row);
      }
      setHint('#book-hint', 'Готово', 'ok');
    } catch (err) {
      setHint('#book-hint', err.message, 'err');
    } finally {
      busy(button, false);
    }
  });
}

/* ---------- дубляж ---------- */

function initDub() {
  $('#dub-go').addEventListener('click', async () => {
    const button = $('#dub-go');
    const file = $('#dub-file').files[0];
    if (!file) {
      setHint('#dub-hint', 'Выберите аудиофайл', 'err');
      return;
    }

    busy(button, true, 'Дубляж…');
    setHint('#dub-hint', 'Распознавание и синтез…');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sttModel', $('#dub-stt').value);
      form.append('voice', $('#dub-voice').value);

      const result = await api('/api/dub', { method: 'POST', body: form });
      const box = $('#dub-result');
      box.hidden = false;
      box.replaceChildren();

      const title = document.createElement('h3');
      title.textContent = 'Результат дубляжа';
      box.append(title, audioPlayer(result.url));

      const source = document.createElement('p');
      source.innerHTML = `<b>Распознано:</b> ${result.sourceText}`;
      const translated = document.createElement('p');
      translated.innerHTML = `<b>Озвучено:</b> ${result.translatedText}`;
      box.append(source, translated);
      box.append(metaRow([['Длительность', fmtDuration(result.duration)], ['Сегментов', result.segments.length]]));

      setHint('#dub-hint', 'Готово', 'ok');
    } catch (err) {
      setHint('#dub-hint', err.message, 'err');
    } finally {
      busy(button, false);
    }
  });
}

/* ---------- подбор голоса ---------- */

function initVoice() {
  $('#voice-go').addEventListener('click', async () => {
    const button = $('#voice-go');
    const file = $('#voice-file').files[0];
    if (!file) {
      setHint('#voice-hint', 'Выберите файл', 'err');
      return;
    }

    busy(button, true, 'Анализ…');
    setHint('#voice-hint', '');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('gender', $('#voice-gender').value);

      const result = await api('/api/voice-match', { method: 'POST', body: form });
      const box = $('#voice-result');
      box.hidden = false;
      box.replaceChildren();

      const title = document.createElement('h3');
      title.textContent = `Ближайший голос: ${result.candidates[0].title}`;
      box.append(title);

      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = result.note;
      box.append(note);

      box.append(metaRow([
        ['F0 референса', `${result.measured.f0Median} Гц`],
        ['Диапазон', `${result.measured.f0Low}–${result.measured.f0High} Гц`],
        ['Темп', `${result.measured.syllablesPerSecond} слог/с`],
        ['Уверенность', `${Math.round(result.confidence * 100)}%`],
        ['Скорость', result.suggestedSpeed],
      ]));

      const table = document.createElement('table');
      table.innerHTML = '<tr><th>Голос</th><th>Тип</th><th>F0</th><th>Близость</th></tr>';
      result.candidates.forEach((candidate, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${candidate.title} ${index === 0 ? '<span class="badge best">лучший</span>' : ''}</td>
          <td>${candidate.gender === 'male' ? 'мужской' : 'женский'}</td>
          <td>${candidate.referenceF0} Гц</td>
          <td>${Math.round(Math.max(0, 1 - candidate.distance) * 100)}%</td>`;
        table.append(row);
      });
      box.append(table);

      const use = document.createElement('button');
      use.className = 'btn primary';
      use.textContent = `Озвучить голосом «${result.candidates[0].title}»`;
      use.style.marginTop = '14px';
      use.addEventListener('click', () => {
        $('#speech-voice').value = result.voice;
        $('#speech-speed').value = result.suggestedSpeed;
        $('#speech-speed-out').textContent = Number(result.suggestedSpeed).toFixed(2);
        document.querySelector('.tab[data-tab="speech"]').click();
      });
      box.append(use);

      setHint('#voice-hint', 'Готово', 'ok');
    } catch (err) {
      setHint('#voice-hint', err.message, 'err');
    } finally {
      busy(button, false);
    }
  });
}

/* ---------- история ---------- */

async function loadHistory() {
  const box = $('#history-result');
  try {
    const data = await api('/api/history?limit=50');
    box.replaceChildren();
    if (!data.items.length) {
      box.textContent = 'Пока пусто.';
      return;
    }

    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Дата</th><th>Тип</th><th>Название</th><th>Длительность</th><th>Размер</th><th></th></tr>';
    for (const item of data.items) {
      const row = document.createElement('tr');
      const date = new Date(item.createdAt).toLocaleString('ru-RU');
      row.innerHTML = `
        <td class="mono">${date}</td>
        <td>${item.kind || '—'}</td>
        <td>${(item.title || '').slice(0, 60)}</td>
        <td>${fmtDuration(item.duration)}</td>
        <td>${fmtBytes(item.bytes)}</td>
        <td></td>`;
      const cell = row.lastElementChild;
      const play = document.createElement('button');
      play.className = 'btn';
      play.textContent = '▶';
      play.addEventListener('click', () => {
        const player = audioPlayer(`/api/audio/${item.id}`);
        player.play();
      });
      cell.append(play);
      table.append(row);
    }
    box.append(table);
  } catch (err) {
    box.textContent = err.message;
  }
}

/* ---------- запуск ---------- */

async function init() {
  initTabs();
  initSpeech();
  initBook();
  initDub();
  initVoice();
  $('#history-refresh').addEventListener('click', loadHistory);

  await loadStatus();
  try {
    await loadVoices();
  } catch (err) {
    setHint('#speech-hint', `Не удалось загрузить голоса: ${err.message}`, 'err');
  }
}

init();
