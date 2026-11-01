# Модели MAI (api-ai.mai.ru)

Снимок каталога на **2026-10-31**. Источник: `GET https://api-ai.mai.ru/v1/models` (OpenAI-совместимый шлюз LiteLLM).
Всего моделей: **16**.

## Чат-модели

| ID (для API) | Контекст, токенов | Вывод, токенов | Комментарий |
|---|---:|---:|---|
| `deepseek-v4.1-flash` | 1 048 576 | 1 048 576 | используется в CNC-стеке (agent, PDF-карточки) |
| `DeepSeek-V4-Flash` | 1 048 576 | 1 048 576 | контекст 1M, самое дешёвое для больших файлов |
| `Qwen3.5-122B-A10B` | 262 144 | 262 144 | MoE 122B, сильная в рассуждениях |
| `qwen3.8-27b` | 262 144 | 262 144 | универсальная средняя |
| `qwen3.6-35b-a3b` | 204 800 | 204 800 | MoE 35B, быстрая |
| `qwen3.8-flash-next` | 204 800 | 204 800 | быстрая, 200K контекст |

## Остальные модели

| ID | Назначение (mode) | Контекст |
|---|---|---:|
| `silero-tts-accented` | audio_speech | — |
| `stt-diarize-whisper` | audio_transcription | — |
| `stt-diarize-gigaam` | audio_transcription | — |
| `silero-tts` | audio_speech | — |
| `gigaam-ru` | audio_transcription | — |
| `qwen3-tts` | audio_speech | — |
| `whisper-large-v3` | audio_transcription | — |
| `bge-m3` | embedding | 8 192 |
| `bge-reranker-v2-m3` | rerank | 8 192 |
| `hunyuan-ocr` | — | 32 768 |

## Как пользоваться

```bash
# список моделей
curl -s -H "Authorization: Bearer $MAI_API_KEY" https://api-ai.mai.ru/v1/models

# чат (OpenAI-совместимый запрос)
curl -s https://api-ai.mai.ru/v1/chat/completions \
  -H "Authorization: Bearer $MAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Привет"}]}'
```

## Заметки

- Идентификаторы **чувствительны к регистру**: `deepseek-v4.1-flash` (нижний) и `DeepSeek-V4-Flash` — разные модели.
- В `.env` модель была записана по-человечески («deepseek V4.1 flash»); для API нужен точный ID из таблицы.
- `mode` приходит не у всех моделей: у `deepseek-v4.1-flash` и `hunyuan-ocr` поле пустое, но обе работают через `/chat/completions`.
- Эмбеддинги: `bge-m3` (`/embeddings`), реранкер: `bge-reranker-v2-m3` (`/rerank`).
- Аудио: TTS — `silero-tts`, `silero-tts-accented`, `qwen3-tts`; STT — `whisper-large-v3`, `gigaam-ru`, `stt-diarize-*`.
- OCR: `hunyuan-ocr`.
