/**
 * Функции, отключённые в бесплатном режиме Carbone EE 5.15.3 (эталоны test/golden).
 * Их нет в реестре форматтеров, чтобы подсказка «Do you mean» не предлагала их.
 * Агрегаторы (aggSum … cumCountD, count()) реализованы в 2.2.0 — lib/aggregate.js, drop/keep — lib/drop.js.
 */
const DISABLED = new Set([
  'html', 'color', 'barcode', 'chart', 'formatR', 'defaultURL', 'autoOrient'
]);

/** EE сообщает count() под именем cumCount (парсер переписывает count() в cumCount). */
const ALIAS = { count : 'cumCount' };

/** Имя для сообщения об ошибке или null, если функция не отключена. */
function disabledName (name) {
  const _name = Object.prototype.hasOwnProperty.call(ALIAS, name) ? ALIAS[name] : name;
  return DISABLED.has(_name) ? _name : null;
}

/** Ошибка с текстом EE; имя функции сохраняется, чтобы buildXML дописал суффикс Source с меткой. */
function disabledError (name) {
  const _err = new Error('Formatter "' + name + '" is disabled in the Community Edition.');
  _err.disabledFormatter = name;
  return _err;
}

module.exports = { disabledName, disabledError };
