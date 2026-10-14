/**
 * Функции, отключённые в бесплатном режиме Carbone EE 5.15.3 (эталоны test/golden).
 * Их нет в реестре форматтеров, чтобы подсказка «Do you mean» не предлагала их.
 * Агрегаторы (aggSum … cumCountD, count()) реализованы в 2.2.0 — lib/aggregate.js, drop/keep — lib/drop.js;
 * штрихкоды (barcode) — в 2.4.0, lib/media.js; цвета (color) — в 2.4.0, lib/color.js; defaultURL — в 2.4.0, lib/links.js;
 * html — в 2.5.0, lib/html.js; графики ECharts (chart) — в 2.6.0, lib/media.js и lib/echarts-render.js.
 */
const DISABLED = new Set([
  'formatR', 'autoOrient'
]);

/** Имя для сообщения об ошибке или null, если функция не отключена. */
function disabledName (name) {
  return DISABLED.has(name) ? name : null;
}

/** Ошибка с текстом EE; имя функции сохраняется, чтобы buildXML дописал суффикс Source с меткой. */
function disabledError (name) {
  const _err = new Error('Formatter "' + name + '" is disabled in the Community Edition.');
  _err.disabledFormatter = name;
  return _err;
}

module.exports = { disabledName, disabledError };
