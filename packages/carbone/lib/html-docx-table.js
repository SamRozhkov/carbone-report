// :html (2.5.0, спецификация §34.4): таблица модели HTML (lib/html-model.js) в WordprocessingML — w:tbl. Своя
// реализация (чистая комната) по открытой документации carbone.io и ECMA-376.
//
// Стиль — tabletheme (создаётся простым при отсутствии), иначе стиль таблиц по умолчанию документа (w:default,
// кроме «Normal Table»), иначе TableGrid (создаётся при отсутствии: сплошные границы). Ширина — 100 % (w:tblW pct
// 5000), сетка — равные столбцы по ширине текста раздела (вложенная таблица — по ширине своей ячейки). colspan →
// w:gridSpan, rowspan →
// w:vMerge restart и w:vMerge в следующих строках (пустой w:p). Подпись — абзацем перед таблицей. Отступ таблицы —
// отступ контейнера (пункт списка) и цитаты (600 twips на уровень).
//
// Сетка: строки бывают неровными — недостающие столбцы строки закрываются одной пустой ячейкой (w:gridSpan); rowspan
// обрезается по последней строке таблицы; ячейка, которая наехала бы на объединённую по вертикали ячейку сверху,
// сужается до неё. Word допускает не больше 63 столбцов: colspan обрезается по 63-му столбцу, а ячейки, которые
// начинаются за ним, не создаются — их содержимое дописывается в последнюю ячейку строки, начатую в этой строке
// (если в строке такой нет — отбрасывается).
//
// Ячейка — свой контейнер: отступ контейнера 0, уровень списков с 0 (список в ячейке начинается с ilvl 0), заголовок
// в ячейке — настоящий заголовок, пустых абзацев между блоками нет, ячейка всегда заканчивается w:p.

var MAX_COLUMNS = 63;
// отступ уровня blockquote (40px), twips — как у абзацев
var QUOTE_INDENT = 600;
var TBL_LOOK = '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';

/**
 * Разметка сетки: по строкам — ячейки с первым столбцом и числом столбцов
 * @param  {Array} rows  строки модели [{ cells : [{ colspan, rowspan, blocks, … }] }]
 * @return {Object}      { columns, rows : [[{ col, span, cell, merge : null|'restart'|'cont', rowspan, more : [ячейки] }]] }
 *                        rowspan — число строк объединения (обрезано по последней строке; у 'cont' — 1)
 */
function layout (rows) {
  // carry[c] — объединённая по вертикали ячейка, начатая в столбце c выше: { left : ещё строк, span }
  var _carry = new Array(MAX_COLUMNS).fill(null);
  var _columns = 1;
  var _out = rows.map(function (row, r) {
    var _entries = [];
    var _c = 0;
    var _lastOwn = null;
    // продолжения ячеек сверху в столбце _c (подряд)
    var _flush = function () {
      while (_c < MAX_COLUMNS && _carry[_c] !== null) {
        var _carried = _carry[_c];
        _entries.push({ col : _c, span : _carried.span, cell : null, merge : 'cont', rowspan : 1, more : null });
        if (--_carried.left === 0) {
          _carry[_c] = null;
        }
        _c += _carried.span;
      }
    };
    row.cells.forEach(function (cell) {
      _flush();
      if (_c >= MAX_COLUMNS) {
        if (_lastOwn !== null) {
          _lastOwn.more.push(cell);
        }
        return;
      }
      var _span = Math.min(cell.colspan, MAX_COLUMNS - _c);
      // не наезжать на объединённую ячейку сверху
      for (var k = 1; k < _span; k++) {
        if (_carry[_c + k] !== null) {
          _span = k;
          break;
        }
      }
      var _rowspan = Math.min(cell.rowspan, rows.length - r);
      _lastOwn = { col : _c, span : _span, cell : cell, merge : _rowspan > 1 ? 'restart' : null, rowspan : _rowspan, more : [] };
      _entries.push(_lastOwn);
      if (_rowspan > 1) {
        _carry[_c] = { left : _rowspan - 1, span : _span };
      }
      _c += _span;
    });
    // продолжения правее последней ячейки строки (между ними — пустые ячейки при записи)
    for (; _c < MAX_COLUMNS; _c++) {
      _flush();
    }
    if (_entries.length > 0) {
      var _last = _entries[_entries.length - 1];
      _columns = Math.max(_columns, _last.col + _last.span);
    }
    return _entries;
  });
  return { columns : _columns, rows : _out };
}

function tcXml (width, span, merge, content) {
  return '<w:tc><w:tcPr><w:tcW w:w="' + (width * span) + '" w:type="dxa"/>' + (span > 1 ? '<w:gridSpan w:val="' + span + '"/>' : '')
    + (merge === 'restart' ? '<w:vMerge w:val="restart"/>' : (merge === 'cont' ? '<w:vMerge/>' : '')) + '</w:tcPr>' + content + '</w:tc>';
}

/**
 * Содержимое ячейки: блоки ячейки (и ячеек за 63-м столбцом) в своём контейнере; заканчивается w:p
 * @param  {Array}  cells  ячейки модели
 * @param  {Number} width  ширина ячейки (twips) — для вложенных таблиц
 */
function cellContent (cells, width, ctx, api) {
  var _saved = { indent : ctx.indent, depth : ctx.depth, level : ctx.level, lead : ctx.lead, quoteStyle : ctx.quoteStyle, width : ctx.width };
  ctx.indent = 0;
  ctx.depth = _saved.depth + 1;
  ctx.level = 0;
  ctx.lead = null;
  ctx.quoteStyle = null;
  ctx.width = width;
  var _xml = '';
  cells.forEach(function (cell) {
    _xml += api.blocksXml(cell.blocks, ctx);
  });
  ctx.indent = _saved.indent;
  ctx.depth = _saved.depth;
  ctx.level = _saved.level;
  ctx.lead = _saved.lead;
  ctx.quoteStyle = _saved.quoteStyle;
  ctx.width = _saved.width;
  return _xml === '' || _xml.slice(-8) === '</w:tbl>' ? _xml + '<w:p/>' : _xml;
}

/**
 * Таблица модели → подпись (абзац) и w:tbl
 * @param  {Object} block  блок table модели { rows, caption, quote }
 * @param  {Object} ctx    контекст абзаца (html-docx.js)
 * @param  {Object} api    { blocksXml, writePara, inlinesXml, spacerXml } из html-docx.js
 * @return {String}
 */
function tableXml (block, ctx, api) {
  var _out = '';
  if (block.caption !== null) {
    _out += api.writePara(block, api.inlinesXml(block.caption, ctx.rPr, ctx), ctx, null);
  }
  else if (ctx.pageBreak === true || ctx.lead !== null) {
    // разрыв страницы до таблицы (и номер пункта списка) — отдельным абзацем перед ней, не в первой ячейке
    _out += api.writePara({ quote : 0 }, '', ctx, null);
  }
  var _grid = layout(block.rows);
  var _total = ctx.width !== null ? ctx.width : ctx.job.parts.textWidth();
  var _width = Math.max(1, Math.floor(_total / _grid.columns));
  var _style = ctx.options.tabletheme !== null ? ctx.styles.ensure(ctx.options.tabletheme, 'table') : ctx.styles.defaultTable();
  if (_style === null) {
    _style = ctx.styles.ensure('TableGrid', 'table');
  }
  var _indent = ctx.indent + QUOTE_INDENT * (block.quote > 0 ? block.quote : 0);
  var _xml = '<w:tbl><w:tblPr><w:tblStyle w:val="' + escapeAttr(_style) + '"/><w:tblW w:w="5000" w:type="pct"/>'
    + (_indent !== 0 ? '<w:tblInd w:w="' + _indent + '" w:type="dxa"/>' : '') + TBL_LOOK + '</w:tblPr>'
    + '<w:tblGrid>' + ('<w:gridCol w:w="' + _width + '"/>').repeat(_grid.columns) + '</w:tblGrid>';
  _grid.rows.forEach(function (entries) {
    _xml += '<w:tr>';
    var _c = 0;
    entries.forEach(function (entry) {
      if (entry.col > _c) {
        _xml += tcXml(_width, entry.col - _c, null, '<w:p/>');
      }
      var _content = entry.cell === null ? '<w:p/>' : cellContent([entry.cell].concat(entry.more), _width * entry.span, ctx, api);
      _xml += tcXml(_width, entry.span, entry.merge, _content);
      _c = entry.col + entry.span;
    });
    if (_c < _grid.columns) {
      _xml += tcXml(_width, _grid.columns - _c, null, '<w:p/>');
    }
    _xml += '</w:tr>';
  });
  return _out + _xml + '</w:tbl>';
}

function escapeAttr (value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

module.exports = {
  tableXml,
  layout,
  MAX_COLUMNS
};
