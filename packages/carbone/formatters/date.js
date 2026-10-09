var dayjs = require('dayjs');

// Плагины dayjs нужны и при отдельной загрузке этого модуля (extend идемпотентен)
dayjs.extend(require('dayjs/plugin/advancedFormat'));
dayjs.extend(require('dayjs/plugin/localizedFormat'));
dayjs.extend(require('dayjs/plugin/customParseFormat'));
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/isoWeek'));
dayjs.extend(require('dayjs/plugin/timezone'));
// Carbone 5: formatI ('human', 'human+') и интервалы
dayjs.extend(require('dayjs/plugin/duration'));
dayjs.extend(require('dayjs/plugin/relativeTime'));


/**
 * Format dates. It takes an output date pattern as an argument. Date patterns are available on [this section](#date-formats).
 * It is possible to change the timezone through the option `options.timezone` and the lang through `options.lang`.
 * List of timezones: [https://en.wikipedia.org/wiki/List_of_tz_database_time_zones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
 *
 * @version 3.0.0 updated
 *
 * @exampleContext {"lang":"en", "timezone":"Europe/Paris"}
 * @example ["20160131", "L"]
 * @example ["20160131", "LL"]
 * @example ["20160131", "LLLL"]
 * @example ["20160131", "dddd"]
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["2017-05-10T15:57:23.769561+03:00", "LLLL"]
 * @example ["2017-05-10 15:57:23.769561+03:00", "LLLL"]
 * @example ["20160131", "LLLL"]
 * @example ["20160131", "dddd"]
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["20160131", "dddd", "YYYYMMDD"]
 * @example [1410715640, "LLLL", "X" ]
 *
 * @exampleContext {"lang":"fr", "timezone": "Asia/Singapore"}
 * @example ["20160131", "dddd", "YYYYMMDD"]
 * @example [1410715640, "LLLL", "X" ]
 *
 * @param  {String|Number} d   date to format
 * @param  {String} patternOut output format
 * @param  {String} patternIn  [optional] input format, "ISO 8601" by default
 * @return {String}            return formatted date
 */
function formatD (d, patternOut, patternIn) {
  if (d !== null && typeof d !== 'undefined') {
    return parse(d, patternIn).tz(this.timezone).locale(this.lang).format(patternOut);
  }
  return d;
}

/**
 *
 * Add a time to a date. Available units: day, week,	month, quarter, year, hour, minute, second and millisecond.
 * Units are case insensitive, and support plural and short forms.
 *
 * @version 3.0.0 new
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["2017-05-10T15:57:23.769561+03:00", "3", "day"]
 * @example ["2017-05-10 15:57:23.769561+03:00", "3", "month"]
 * @example ["20160131", "3", "day"]
 * @example ["20160131", "3", "month"]
 * @example ["31-2016-01", "3", "month", "DD-YYYY-MM"]
 *
 * @param      {String|Number}  d   input date
 * @param      {Number}  amount     The amount
 * @param      {String}  unit       The unit
 * @param      {String}  patternIn  [optional] input format, ISO8601 by default
 * @return     {Date}               return a date, which can be formatted with formatD, or manipulated with other formatters
 */
function addD (d, amount, unit, patternIn) {
  if (d !== null && typeof d !== 'undefined') {
    return parse(d, patternIn).add(parseInt(amount, 10), unit || 'day');
  }
  return d;
}

/**
 *
 * Subtract a time to a date. Available units: day, week,	month, quarter, year, hour, minute, second and millisecond.
 * Units are case insensitive, and support plural and short forms.
 *
 * @version 3.0.0 new
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["2017-05-10T15:57:23.769561+03:00", "3", "day"]
 * @example ["2017-05-10 15:57:23.769561+03:00", "3", "month"]
 * @example ["20160131", "3", "day"]
 * @example ["20160131", "3", "month"]
 * @example ["31-2016-01", "3", "month", "DD-YYYY-MM"]
 *
 * @param      {String|Number}  d   input date
 * @param      {Number}  amount     The amount
 * @param      {String}  unit       The unit
 * @param      {String}  patternIn  [optional] input format, ISO8601 by default
 * @return     {Date}               return a date, which can be formatted with formatD, or manipulated with other formatters
 */
function subD (d, amount, unit, patternIn) {
  if (d !== null && typeof d !== 'undefined') {
    return parse(d, patternIn).subtract(parseInt(amount, 10), unit || 'day');
  }
  return d;
}

/**
 *
 * Create a date and set it to the start of a unit of time.
 *
 * @version 3.0.0 new
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["2017-05-10T15:57:23.769561+03:00", "day"]
 * @example ["2017-05-10 15:57:23.769561+03:00", "month"]
 * @example ["20160131", "day"]
 * @example ["20160131", "month"]
 * @example ["31-2016-01", "month", "DD-YYYY-MM"]
 *
 * @param      {String|Number}  d   input date
 * @param      {String}  unit       The unit
 * @param      {String}  patternIn  [optional] input format, ISO8601 by default
 * @return     {Date}               return a date, which can be formatted with formatD, or manipulated with other formatters
 */
function startOfD (d, unit, patternIn) {
  if (d !== null && typeof d !== 'undefined') {
    return parse(d, patternIn).startOf( unit || 'year');
  }
  return d;
}

/**
 *
 * Create a date and set it to the end of a unit of time.
 *
 * @version 3.0.0 new
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["2017-05-10T15:57:23.769561+03:00", "day"]
 * @example ["2017-05-10 15:57:23.769561+03:00", "month"]
 * @example ["20160131", "day"]
 * @example ["20160131", "month"]
 * @example ["31-2016-01", "month", "DD-YYYY-MM"]
 *
 * @param      {String|Number}  d   input date
 * @param      {String}  unit       The unit
 * @param      {String}  patternIn  [optional] input format, ISO8601 by default
 * @return     {Date}               return a date, which can be formatted with formatD, or manipulated with other formatters
 */
function endOfD (d, unit, patternIn) {
  if (d !== null && typeof d !== 'undefined') {
    return parse(d, patternIn).endOf(unit || 'year');
  }
  return d;
}


/**
 * Format dates
 *
 * @deprecated
 * @version 1.0.0 deprecated
 *
 * @exampleContext {"lang":"en", "timezone":"Europe/Paris"}
 * @example ["20160131", "YYYYMMDD", "L"]
 * @example ["20160131", "YYYYMMDD", "LL"]
 * @example ["20160131", "YYYYMMDD", "LLLL"]
 * @example ["20160131", "YYYYMMDD", "dddd"]
 * @example [1410715640, "X", "LLLL"]
 *
 * @exampleContext {"lang":"fr", "timezone":"Europe/Paris"}
 * @example ["20160131", "YYYYMMDD", "LLLL"]
 * @example ["20160131", "YYYYMMDD", "dddd"]
 *
 * @param  {String|Number} d   date to format
 * @param  {String} patternIn  input format
 * @param  {String} patternOut output format
 * @return {String}            return formatted date
 */
function convDate (d, patternIn, patternOut) {
  return formatD.call(this, d, patternOut, patternIn);
}


/**
 * Строка без смещения разбирается как UTC (как в Carbone EE): результат не зависит от часового пояса процесса.
 * Смещение или Z в строке, метки X/x остаются абсолютными. Вывод — в this.timezone (formatD).
 *
 * @private
 * @param      {string}  d          not undefined/null date
 * @param      {string}  patternIn  The pattern
 * @return     {Object}             dayjs
 */
function parse (d, patternIn) {
  // if the date is already parsed
  if (typeof(d) === 'object' && d !== null && d.isValid) {
    return d;
  }
  return patternIn ? dayjs.utc(d, patternIn) : dayjs.utc(d + '');
}


/**
 * Carbone 5: разница между датами (toDate − d) в единицах unit (по умолчанию миллисекунды), с отбрасыванием дробной части.
 * Единицы: day(s), week(s), month(s), quarter(s), year(s), hour(s), minute(s), second(s), millisecond(s),
 * короткие d, w, Q, M, y, h, m, s, ms. Даты без смещения читаются как UTC (как parse).
 *
 * @example ["20101001", "20101201"        ]
 * @example ["20101001", "20101201", "days"]
 *
 * @param  {String|Number} d               дата «от»
 * @param  {String|Number} toDate          дата «до»
 * @param  {String}        unit            [optional] единица результата
 * @param  {String}        patternFromDate [optional] формат d, по умолчанию ISO 8601
 * @param  {String}        patternToDate   [optional] формат toDate, по умолчанию ISO 8601
 * @return {Number}
 */
function diffD (d, toDate, unit, patternFromDate, patternToDate) {
  if (d === null || typeof d === 'undefined') {
    return d;
  }
  return parse(toDate, patternToDate).diff(parse(d, patternFromDate), unit || 'millisecond');
}

/**
 * Carbone 5: форматирование интервала. patternOut — единица результата или 'human' / 'human+' (текст на языке options.lang);
 * patternIn — единица входного числа (по умолчанию миллисекунды); строка ISO 8601 вида 'P1Y2M' тоже понимается.
 *
 * @exampleContext {"lang":"en"}
 * @example [2000   , "second"         ]
 * @example [2000   , "human+"         ]
 * @example [60     , "ms"   , "minute"]
 * @example ["P1M"  , "ms"             ]
 *
 * @param  {Number|String} d
 * @param  {String}        patternOut
 * @param  {String}        patternIn   [optional]
 * @return {Number|String}
 */
function formatI (d, patternOut, patternIn) {
  if (d === null || typeof d === 'undefined' || d === '') {
    return d;
  }
  var _duration = (typeof d === 'string' && /^[-+]?P/i.test(d) === true)
    ? dayjs.duration(d)
    : dayjs.duration(parseFloat(d), patternIn || 'millisecond');
  if (patternOut === 'human' || patternOut === 'human+') {
    return _duration.locale(this.lang).humanize(patternOut === 'human+');
  }
  return _duration.as(patternOut || 'millisecond');
}

module.exports = {
  formatD,
  formatI,
  diffD,
  convDate,
  addD,
  subD,
  startOfD,
  endOfD
};
