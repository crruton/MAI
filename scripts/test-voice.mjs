/**
 * Голосовой ввод (F18, ADR 0092): выбор движка, проверка провайдера, распознавание.
 */
import { voiceConfig, providerVoiceStatus, providerTranscribe } from '../electron/lib/voice.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}

const providers = { openai: { name: 'OpenAI', baseURL: 'https://api.example/v1', apiKey: 'k' }, nokey: { name: 'Без ключа', baseURL: 'https://x/v1', apiKey: '' } };
const resolve = (key) => {
  const [id, model] = key.split('/');
  if (!providers[id]) throw new Error(`Провайдер «${id}» не найден`);
  return { providerId: id, modelId: model, provider: providers[id] };
};

console.log('[1] настройки');
check('по умолчанию — MAS, ru', JSON.stringify(voiceConfig({})) === JSON.stringify({ engine: 'mas', model: '', language: 'ru' }));
check('неизвестный движок → MAS', voiceConfig({ voice: { engine: 'cloud' } }).engine === 'mas');
check('провайдер с моделью', voiceConfig({ voice: { engine: 'provider', model: ' openai/whisper-1 ', language: 'en' } }).model === 'openai/whisper-1');

console.log('[2] готовность провайдера');
check('нет модели — подсказка', /Не задана модель/.test(providerVoiceStatus(voiceConfig({ voice: { engine: 'provider' } }), resolve).error));
check('нет провайдера', /не найден/.test(providerVoiceStatus({ engine: 'provider', model: 'nope/x' }, resolve).error));
check('нет ключа', /API-ключ провайдера «Без ключа»/.test(providerVoiceStatus({ engine: 'provider', model: 'nokey/w' }, resolve).error));
const ok = providerVoiceStatus({ engine: 'provider', model: 'openai/whisper-1' }, resolve);
check('готов: имя провайдера и модель', ok.ok && ok.provider === 'OpenAI' && ok.model === 'openai/whisper-1');

console.log('[3] распознавание');
const calls = [];
const fake = (opts) => ({
  audio: {
    transcriptions: {
      create: async (req) => {
        calls.push({ opts, req, name: req.file.name, type: req.file.type, size: (await req.file.arrayBuffer()).byteLength });
        return { text: '  привет мир  ' };
      },
    },
  },
});
const wav = new Uint8Array(1000);
const res = await providerTranscribe({ wav, config: { engine: 'provider', model: 'openai/whisper-1', language: 'ru' }, resolve, clientFactory: fake });
check('текст обрезан, движок provider', res.text === 'привет мир' && res.engine === 'provider' && res.model === 'openai/whisper-1');
check('запрос: модель без префикса, язык, voice.wav audio/wav', calls[0].req.model === 'whisper-1' && calls[0].req.language === 'ru' && calls[0].name === 'voice.wav' && calls[0].type === 'audio/wav' && calls[0].size === 1000, JSON.stringify(calls[0].req.model));
check('клиент с ключом и адресом провайдера', calls[0].opts.apiKey === 'k' && calls[0].opts.baseURL === 'https://api.example/v1');
let err = '';
await providerTranscribe({ wav, config: { engine: 'provider', model: '' }, resolve, clientFactory: fake }).catch((e) => (err = e.message));
check('без модели — ошибка до запроса', /Не задана модель/.test(err) && calls.length === 1, err);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
