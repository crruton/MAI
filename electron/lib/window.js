/**
 * Параметры окна, общие для главного окна и окон досок.
 *
 * Полоса заголовка скрыта, кнопки окна рисует система поверх страницы в
 * цветах палитры. Перетаскивание обеспечивают drag-регионы в CSS. См. ADR 0022.
 */

const TITLEBAR_COLOR = '#0f1117';
const TITLEBAR_SYMBOL = '#e8eaf2';
const TITLEBAR_HEIGHT = 36;

/**
 * @param {string} platform значение `process.platform`
 * @returns {object} поля для `new BrowserWindow({...})`
 */
export function titleBarOptions(platform = process.platform) {
  // На macOS кнопки окна слева, а titleBarOverlay не поддержан.
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      symbolColor: TITLEBAR_SYMBOL,
      height: TITLEBAR_HEIGHT,
    },
  };
}

export const titleBarMetrics = {
  color: TITLEBAR_COLOR,
  symbolColor: TITLEBAR_SYMBOL,
  height: TITLEBAR_HEIGHT,
};
