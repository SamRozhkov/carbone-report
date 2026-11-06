// :cellDate — настоящие даты в ячейках XLSX и ODS (спецификация carbone-reports §54). Своё расширение, не функция
// Carbone EE; устроено как `:formatN` апстрима (preprocessor.convertToInlineString, convertNumberMarkersIntoNumericFormat).
//
//   1. Препроцессор (до сборки): ячейка листа, весь текст которой — одна метка с последним форматтером `:cellDate`,
//      становится ячейкой-датой, а `:cellDate` в метке — служебным форматтером:
//        XLSX: t="s" → t="n", <v>{…:__cellDateSerial(…)}</v> — серийный номер Excel (дни от 1899-12-30, время — дробью);
//        ODS:  office:value-type="date" office:date-value="{…:__cellDateIso(…)}" calcext:value-type="date",
//              текст абзаца — та же метка с `:cellDate` (строка YYYY-MM-DD).
//   2. Пустое или нераспознаваемое значение: служебный форматтер печатает жетон EMPTY, а apply после сборки файла
//      (builder.buildXML) убирает значение целиком: в XLSX — элемент <v> (пустой <v> в числовой ячейке — не число),
//      в ODS — атрибуты типа и значения даты (ячейка без значения, как пустая ячейка LibreOffice).
//   Во всех прочих местах `cellDate` (formatters/date.js) печатает дату строкой ISO YYYY-MM-DD.

var crypto = require('crypto');
var date = require('../formatters/date');

// ключ процесса: жетон не может прийти из данных отчёта
var EMPTY = '' + crypto.randomBytes(6).toString('hex') + '';
var EMPTY_V = new RegExp('<v>' + EMPTY + '</v>', 'g');
var EMPTY_ODS_CELL = new RegExp('<table:table-cell\\b[^>]*' + EMPTY + '[^>]*>', 'g');
var ODS_EMPTY_ATTRS = new RegExp('\\s(?:office:value-type="date"|calcext:value-type="date"|office:date-value="' + EMPTY + '")', 'g');

// весь текст ячейки — одна метка, `cellDate` — последний форматтер: «{d.x:cellDate}», «{d.x:formatD(…):cellDate('…')}»
var CELL_MARKER = /^\{\s*([dc][^{}]*?)\s*:\s*cellDate\s*(\([^(){}]*\))?\s*\}$/;

/**
 * Метка ячейки, которая станет датой, со служебным форматтером вместо `cellDate`, или null
 * @param  {String} text     текст ячейки без разметки
 * @param  {String} internal имя служебного форматтера
 * @return {String|null}
 */
function rewrite (text, internal) {
  var _m = CELL_MARKER.exec(text.trim());
  if (_m === null) {
    return null;
  }
  return '{' + _m[1] + ':' + internal + (_m[2] || '') + '}';
}

/**
 * [XLSX] Ячейка с общей строкой (t="s") → ячейка-дата, или null, если текст ячейки — не одна метка `:cellDate`
 * @param  {String} openTag      открывающий тег <c …>
 * @param  {String} sharedString содержимое <si> (с разметкой <t>, <r>)
 * @return {String|null}         открывающий тег и <v> без закрывающего </c>
 */
function xlsxCell (openTag, sharedString) {
  if (typeof sharedString !== 'string' || sharedString.indexOf('cellDate') === -1) {
    return null;
  }
  // фонетические подсказки <rPh> — не текст ячейки
  var _text = sharedString.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<[^>]*>/g, '');
  var _marker = rewrite(_text, '__cellDateSerial');
  if (_marker === null) {
    return null;
  }
  return openTag.replace('t="s"', 't="n"') + '<v>' + _marker + '</v>';
}

/**
 * [ODS] Текстовые ячейки content.xml, весь текст которых — одна метка `:cellDate`, становятся ячейками-датами
 * @param  {String} xml content.xml
 * @return {String}
 */
function odsContent (xml) {
  if (typeof xml !== 'string' || xml.indexOf('cellDate') === -1) {
    return xml;
  }
  // calcext:value-type — только если префикс объявлен в документе или уже был у ячейки (как у formatN):
  // ODS из Excel и Google Sheets пространство calcext не объявляют, лишний атрибут сделал бы XML неверным
  var _calcNs = /\sxmlns:calcext\s*=/.test(xml);
  return xml.replace(/(<table:table-cell\b[^<>]*?)>(\s*<text:p>([^<]*)<\/text:p>\s*<\/table:table-cell>)/g, function (cell, openTag, rest, text) {
    var _marker = rewrite(text, '__cellDateIso');
    if (_marker === null) {
      return cell;
    }
    var _tag = openTag
      .replace(/\soffice:(?:value-type|value|date-value|time-value|boolean-value|string-value|currency)="[^"]*"/g, '')
      .replace(/\scalcext:value-type="[^"]*"/g, '');
    var _calc = _calcNs === true || /\scalcext:value-type=/.test(openTag) ? ' calcext:value-type="date"' : '';
    return _tag + ' office:value-type="date" office:date-value="' + _marker + '"' + _calc + '>' + rest;
  });
}

/** Метки файла содержат служебный форматтер даты (нужен apply после сборки) */
function hasMarkers (markers) {
  for (var i = 0; i < markers.length; i++) {
    if (typeof markers[i].name === 'string' && markers[i].name.indexOf(':__cellDate') !== -1) {
      return true;
    }
  }
  return false;
}

/** После сборки файла: убрать значение у ячеек с пустой или нераспознанной датой */
function apply (xml) {
  if (typeof xml !== 'string' || xml.indexOf(EMPTY) === -1) {
    return xml;
  }
  return xml.replace(EMPTY_V, '').replace(EMPTY_ODS_CELL, function (tag) {
    return tag.replace(ODS_EMPTY_ATTRS, '');
  }).split(EMPTY).join('');
}

/** Серийный номер Excel (система дат 1900): дни от 1899-12-30, время суток — дробная часть */
function serial (p) {
  var _ms = Date.UTC(p.y, p.M - 1, p.D, p.h, p.m, p.s, p.ms) - Date.UTC(1899, 11, 30);
  return String(_ms / 86400000);
}

var formatters = {
  /** [XLSX] значение <v> ячейки-даты */
  __cellDateSerial : function (d, patternIn) {
    var _parts = date.cellDateParts.call(this, d, patternIn);
    if (_parts === null) {
      return EMPTY;
    }
    if (_parts.hasTime === false) {
      _parts.h = _parts.m = _parts.s = _parts.ms = 0;
    }
    return serial(_parts);
  },
  /** [ODS] office:date-value ячейки-даты: YYYY-MM-DD или YYYY-MM-DDTHH:mm:ss */
  __cellDateIso : function (d, patternIn) {
    var _parts = date.cellDateParts.call(this, d, patternIn);
    if (_parts === null) {
      return EMPTY;
    }
    var _iso = date.cellDateISODate(_parts);
    if (_parts.hasTime === true) {
      var _two = function (n) {
        return (n < 10 ? '0' : '') + n;
      };
      _iso += 'T' + _two(_parts.h) + ':' + _two(_parts.m) + ':' + _two(_parts.s);
    }
    return _iso;
  }
};

module.exports = { xlsxCell, odsContent, hasMarkers, apply, formatters, EMPTY };
