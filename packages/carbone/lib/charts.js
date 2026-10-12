// Диаграммы DOCX/XLSX (2.5.0, спецификация §34.2): чистые функции — разбор ссылок `c:f`, числа, кэш точек.
// Файлы архива здесь не трогаются.
const preprocessor = require('./preprocessor');

// Лист: в кавычках (кавычка внутри удваивается) или без; адрес: [$]СТОЛБЕЦ[$]СТРОКА
const CELL = '(\\$?)([A-Za-z]{1,3})(\\$?)([1-9]\\d*)';
const REF_RE = new RegExp('^(?:\'((?:[^\']|\'\')+)\'|([^\'!:,()\\[\\]\\s]+))!' + CELL + '(?::' + CELL + ')?$');
const NUMBER_RE = /^-?\d+([.,]\d+)?([eE][-+]?\d+)?$/;

const charts = {
  /**
   * Разобрать ссылку `c:f` на диапазон; всё прочее (объединения, целые столбцы/строки, внешние книги, имена) — null
   * @param  {String} f
   * @return {Object|null}
   */
  parseRef : function (f) {
    if (typeof f !== 'string') {
      return null;
    }
    const m = REF_RE.exec(f);
    if (m === null) {
      return null;
    }
    const quoted = m[1] !== undefined;
    const single = m[8] === undefined;
    return {
      sheet  : quoted ? m[1].replace(/''/g, '\'') : m[2],
      quoted : quoted,
      c1     : m[4],
      r1     : parseInt(m[6], 10),
      c2     : single ? m[4] : m[8],
      r2     : parseInt(single ? m[6] : m[10], 10),
      abs    : {
        c1 : m[3] === '$',
        r1 : m[5] === '$',
        c2 : single ? m[3] === '$' : m[7] === '$',
        r2 : single ? m[5] === '$' : m[9] === '$'
      }
    };
  },

  /**
   * Собрать ссылку обратно; одна ячейка — без `:`
   * @param  {Object} ref  результат parseRef
   * @return {String}
   */
  formatRef : function (ref) {
    const sheet = ref.quoted ? '\'' + ref.sheet.replace(/'/g, '\'\'') + '\'' : ref.sheet;
    const a = ref.abs;
    let out = sheet + '!' + (a.c1 ? '$' : '') + ref.c1 + (a.r1 ? '$' : '') + ref.r1;
    if (ref.c2 !== ref.c1 || ref.r2 !== ref.r1 || a.c2 !== a.c1 || a.r2 !== a.r1) {
      out += ':' + (a.c2 ? '$' : '') + ref.c2 + (a.r2 ? '$' : '') + ref.r2;
    }
    return out;
  },

  /**
   * Правило R2: пересчитать строки диапазона шаблона в строки результата
   * @param  {Map<Number, {first: Number, last: Number}>} rowMap  строка шаблона -> первая и последняя строки результата
   * @param  {Number} r1  первая строка диапазона шаблона
   * @param  {Number} r2  последняя строка диапазона шаблона
   * @return {{r1: Number, r2: Number, empty: Boolean}}
   */
  remapRows : function (rowMap, r1, r2) {
    let start = null;
    let end = null;
    let startKey = Infinity;
    let endKey = -Infinity;
    let maxLast = 0;
    rowMap.forEach(function (v, key) {
      if (v.last > maxLast) {
        maxLast = v.last;
      }
      // начало: сама строка либо ближайшая большая
      if (key >= r1 && key < startKey) {
        startKey = key;
        start = v.first;
      }
      // конец: сама строка либо ближайшая меньшая
      if (key <= r2 && key > endKey) {
        endKey = key;
        end = v.last;
      }
    });
    if (start === null && end === null) {
      return { r1 : r1, r2 : r2, empty : true };
    }
    if (end === null) {
      end = 0;
    }
    if (start === null) {
      start = maxLast + 1;
    }
    if (start > end) {
      return { r1 : end + 1, r2 : end + 1, empty : true };
    }
    return { r1 : start, r2 : end, empty : false };
  },

  /**
   * Текст ячейки -> число для числового ряда (пробелы и U+00A0 убираются, запятая — десятичный разделитель)
   * @param  {String} text
   * @return {Number|null}
   */
  toNumber : function (text) {
    if (typeof text !== 'string') {
      return null;
    }
    const s = text.replace(/[\s ]/g, '');
    if (!NUMBER_RE.test(s)) {
      return null;
    }
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  },

  /**
   * Содержимое `c:strCache`; прежние `c:ptCount`/`c:pt` из innerXml отбрасываются, прочее (extLst) остаётся после точек
   * @param  {Array<String|null>} values  уже экранированные для XML значения
   * @param  {String} innerXml  прежнее содержимое кэша
   * @return {String}
   */
  buildStrCache : function (values, innerXml) {
    let out = '<c:ptCount val="' + values.length + '"/>';
    values.forEach(function (v, i) {
      if (v !== null && v !== undefined && v !== '') {
        out += '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>';
      }
    });
    const rest = (innerXml || '')
      .replace(/<c:ptCount\b[^>]*\/>/g, '')
      .replace(/<c:pt\b[^>]*>[\s\S]*?<\/c:pt>/g, '');
    return out + rest;
  },

  /**
   * Содержимое `c:numCache`; `formatCode` (уже в виде XML-текста) — первым, если был
   * @param  {Array<Number|null>} values
   * @param  {String|null} formatCode
   * @return {String}
   */
  buildNumCache : function (values, formatCode) {
    let out = formatCode !== null && formatCode !== undefined ? '<c:formatCode>' + formatCode + '</c:formatCode>' : '';
    out += '<c:ptCount val="' + values.length + '"/>';
    values.forEach(function (v, i) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out += '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>';
      }
    });
    return out;
  },

  /** Буквы столбца -> номер (A=1) */
  columnIndex : function (letters) {
    let n = 0;
    String(letters).toUpperCase().split('').forEach(function (ch) {
      n = n * 26 + ch.charCodeAt(0) - 64;
    });
    return n;
  },

  /** Номер столбца -> буквы */
  columnName : preprocessor.columnName
};

module.exports = charts;
