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

/**
 * :cellDate (carbone-reports §54): разбор значения для даты в ячейке XLSX/ODS — как у formatD (parse, patternIn,
 * часовой пояс отчёта). Дата без времени не сдвигается часовым поясом (это календарная дата, а не момент), дата
 * со временем переводится в this.timezone.
 *
 * @private
 * @param  {String|Number|Object} d          значение
 * @param  {String}               patternIn  [optional] входной формат, по умолчанию ISO 8601
 * @return {Object|null}  { y, M (1–12), D, h, m, s, ms, hasTime } или null — пустое или нераспознаваемое значение
 */
function cellDateParts (d, patternIn) {
  if (d === null || d === undefined || d === '' || (typeof d === 'number' && isFinite(d) === false)) {
    return null;
  }
  var _isDayjs = typeof d === 'object' && d.isValid instanceof Function;
  // с входным форматом — строгий разбор: «31.02.2026» по 'DD.MM.YYYY' не переносится на март, а не распознаётся
  // (formatD разбирает нестрого и не меняется)
  var _parsed = (patternIn && _isDayjs === false) ? dayjs.utc(d, patternIn, true) : parse(d, patternIn);
  if (_parsed.isValid() !== true) {
    return null;
  }
  var _str = _isDayjs === true ? '' : String(d).trim();
  if (_isDayjs === false && !patternIn) {
    // dayjs переносит лишние месяцы и дни («2026-02-30» → 2 марта): такие даты считаются нераспознанными
    var _ymd = /^[+-]?(\d{4})-?(\d{2})-?(\d{2})/.exec(_str);
    if (_ymd !== null) {
      var _month = parseInt(_ymd[2], 10);
      var _day = parseInt(_ymd[3], 10);
      if (_month < 1 || _month > 12 || _day < 1 || _day > new Date(Date.UTC(parseInt(_ymd[1], 10), _month, 0)).getUTCDate()) {
        return null;
      }
    }
  }
  var _hasTime;
  if (_isDayjs === true) {
    var _u = _parsed.utc();
    _hasTime = _u.hour() !== 0 || _u.minute() !== 0 || _u.second() !== 0 || _u.millisecond() !== 0;
  }
  else if (patternIn) {
    // токены времени во входном формате (текст в [скобках] — литерал)
    _hasTime = /[HhkmsSAaXxZ]/.test(String(patternIn).replace(/\[[^\]]*\]/g, ''));
  }
  else {
    // только дата: YYYY, YYYY-MM, YYYY-MM-DD, YYYYMMDD (разделители «-» и «/», как у разбора dayjs)
    _hasTime = /^\d{4}(?:[-/]?\d{1,2}(?:[-/]?\d{1,2})?)?$/.test(_str) === false;
  }
  var _local = _hasTime === true ? _parsed.tz(this.timezone) : _parsed.utc();
  if (_local.isValid() !== true) {
    return null;
  }
  return {
    y       : _local.year(),
    M       : _local.month() + 1,
    D       : _local.date(),
    h       : _local.hour(),
    m       : _local.minute(),
    s       : _local.second(),
    ms      : _local.millisecond(),
    hasTime : _hasTime
  };
}

function pad (n, len) {
  var _s = String(Math.abs(n));
  while (_s.length < len) {
    _s = '0' + _s;
  }
  return (n < 0 ? '-' : '') + _s;
}

/** YYYY-MM-DD из cellDateParts */
function cellDateISODate (p) {
  return pad(p.y, 4) + '-' + pad(p.M, 2) + '-' + pad(p.D, 2);
}

/**
 * Дата в ячейке XLSX/ODS (своё расширение carbone-reports, §54). Метка `{d.x:cellDate}` — одна в ячейке листа,
 * `cellDate` — последний форматтер: ячейка становится настоящей датой (XLSX — серийный номер Excel, вид задаёт
 * числовой формат ячейки шаблона; ODS — `office:date-value`). В остальных местах (в том числе в ячейке с текстом или
 * несколькими метками, в DOCX, ODT, PPTX) печатает дату строкой ISO `YYYY-MM-DD`. Значение разбирается как в
 * formatD; пустое или нераспознаваемое — пустая строка.
 *
 * @exampleContext {"lang":"ru", "timezone":"Europe/Moscow"}
 * @example ["2026-03-08"]
 * @example ["2026-03-08T22:00:00Z"]
 * @example ["08.03.2026", "DD.MM.YYYY"]
 *
 * @param  {String|Number} d          дата
 * @param  {String}        patternIn  [optional] входной формат, по умолчанию ISO 8601
 * @return {String}                   YYYY-MM-DD или ''
 */
function cellDate (d, patternIn) {
  var _parts = cellDateParts.call(this, d, patternIn);
  return _parts === null ? '' : cellDateISODate(_parts);
}

module.exports = {
  formatD,
  cellDate,
  formatI,
  diffD,
  convDate,
  addD,
  subD,
  startOfD,
  endOfD
};

// служебное для lib/celldate.js: неперечисляемые, чтобы addFormatters не сделал их форматтерами
Object.defineProperty(module.exports, 'cellDateParts', { enumerable : false, value : cellDateParts });
Object.defineProperty(module.exports, 'cellDateISODate', { enumerable : false, value : cellDateISODate });
