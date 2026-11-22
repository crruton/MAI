/**
 * Параметры окна, общие для главного окна и окон досок.
 *
 * Полоса заголовка скрыта, кнопки окна рисует система поверх страницы в
 * цветах палитры. Перетаскивание обеспечивают drag-регионы в CSS. См. ADR 0022.
 */

const TITLEBAR_COLOR = '#0f1117';
const TITLEBAR_SYMBOL = '#e8eaf2';
const TITLEBAR_HEIGHT = 36;
// Светлая тема (CC7.16, ADR 0074): те же значения, что --bg и --text в CSS.
const LIGHT = { color: '#f6f7fb', symbolColor: '#1b1f2c' };

/** Тема из настроек: dark | light | system. */
export function normalizeTheme(value) {
  return ['dark', 'light', 'system'].includes(value) ? value : 'dark';
}

/** Цвета окна для темы: фон и полоса заголовка. */
export function windowColors(dark = true) {
  return dark ? { background: TITLEBAR_COLOR, color: TITLEBAR_COLOR, symbolColor: TITLEBAR_SYMBOL } : { background: LIGHT.color, ...LIGHT };
}

/**
 * @param {string} platform значение `process.platform`
 * @returns {object} поля для `new BrowserWindow({...})`
 */
export function titleBarOptions(platform = process.platform, { dark = true } = {}) {
  // На macOS кнопки окна слева, а titleBarOverlay не поддержан.
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  const colors = windowColors(dark);
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: TITLEBAR_HEIGHT,
    },
  };
}

export const titleBarMetrics = {
  color: TITLEBAR_COLOR,
  symbolColor: TITLEBAR_SYMBOL,
  height: TITLEBAR_HEIGHT,
};
