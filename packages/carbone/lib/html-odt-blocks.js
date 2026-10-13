// :html (2.5.0, спецификация §34.4): списки и таблицы модели HTML (lib/html-model.js) в OpenDocument Text для
// lib/html-odt.js. Своя реализация (чистая комната) по открытой документации carbone.io и ODF 1.2.
//
// Список — text:list с автоматическим стилем CRhl<n> (маркеры •◦▪ или номера 1./a./i. по уровням, 1.27cm на уровень от
// отступа цитаты списка; у каждого text:list свой счёт), вложенный список — text:list внутри text:list-item; пункт
// с флажком — text:list-header (без маркера), флажок и пробел — в начале первого абзаца; первый блок пункта не абзац —
// перед ним пустой абзац пункта (номер). Заголовок в пункте — абзац пункта с жирным текстом и кеглем заголовка.
//
// Таблица — table:table (имя CRhTable<n>, уникальное в части) со стилями CRht (ширина — ширина текста или своей
// ячейки за вычетом отступа контейнера и цитаты), CRhtc (равные столбцы), CRhtd (рамка ячеек); сетка — общая с DOCX
// (html-docx-table.layout, 63 столбца): colspan — table:number-columns-spanned и table:covered-table-cell, rowspan —
// table:number-rows-spanned и table:covered-table-cell в следующих строках. Подпись — абзацем перед таблицей. Разрывы
// страницы у таблицы — в её стиле. Ячейка — свой контейнер (отступ 0, списки с уровня 0, заголовок — text:h), в ней
// всегда есть text:p. Таблица внутри пункта списка (в text:list-item таблиц не бывает): открытые списки закрываются,
// после таблицы открываются заново — text:continue-list на xml:id своего списка (CRhList<n>, уникален в части; только
// у списков, которые продолжаются), пункт продолжается text:list-header без маркера.

var layout = require('./html-docx-table').layout;
var common = require('./html-xml');
var odfStyles = require('./html-odt-styles');

var QUOTE_INDENT = odfStyles.QUOTE_INDENT;
// блоки, которые сами пишут первый абзац пункта (с номером или флажком); перед прочими — пустой абзац пункта
var LEAD_BLOCKS = { para : true, heading : true, pre : true };
var COVERED = '<table:covered-table-cell/>';
// продолжения списков после таблицы, оставшиеся пустыми; xml:id списков (продолжение которых могло уйти с ними)
var EMPTY_REOPEN = /<text:list-header><\/text:list-header>|<text:list text:style-name="[^"]*" text:continue-list="[^"]*"><\/text:list>/g;
var LIST_ID = / xml:id="(CRhList\d+)"/g;
var CONTINUE = /text:continue-list="(CRhList\d+)"/g;

// ---------------------------------------------------------------------------------------------------------------
// Списки

/** Пункт списка: флажок (ctx.lead) — в первый абзац; первый блок не абзац — пустой абзац пункта перед ним */
function itemXml (item, ctx, api) {
  ctx.lead = item.checkbox !== null ? common.checkboxSymbol(item.checkbox) + ' ' : '';
  var _out = '';
  if (item.blocks.length === 0 || LEAD_BLOCKS[item.blocks[0].type] !== true) {
    _out += api.writePara({ quote : 0 }, '', ctx);
  }
  _out += api.blocksXml(item.blocks, ctx);
  ctx.lead = null;
  return _out;
}

/**
 * Список: text:list со стилем по виду и отступу (цитата списка — к отступу списка контейнера); пункты — text:list-item
 * (с флажком — text:list-header). Разрыв после списка не берёт абзац пункта — остаётся ожидающим (blocksXml)
 * @param  {Object} block  блок list модели { ordered, items, quote }
 * @param  {Object} ctx    контекст абзаца (html-odt.js)
 * @param  {Object} api    { blocksXml, writePara, … } из html-odt.js
 * @return {String}
 */
function listXml (block, ctx, api) {
  var _saved = { indent : ctx.indent, depth : ctx.depth, level : ctx.level, quoteStyle : ctx.quoteStyle, listOffset : ctx.listOffset };
  var _after = ctx.breakAfter;
  ctx.breakAfter = false;
  var _themed = block.quote > 0 && ctx.quoteTheme !== null;
  var _offset = _saved.listOffset + (_themed === true ? 0 : QUOTE_INDENT * block.quote);
  // открытый список: стиль, текущий пункт (после таблицы — text:list-header), xml:id (появляется, если список
  // продолжается после таблицы — открывающий тег пишется в конце)
  var _frame = { style : ctx.odfStyles.list(block.ordered === true, _offset), item : null, id : null };
  ctx.lists.push(_frame);
  var _out = '';
  block.items.forEach(function (item) {
    _frame.item = item.checkbox === null ? 'text:list-item' : 'text:list-header';
    _out += '<' + _frame.item + '>';
    ctx.indent = _offset + odfStyles.LEVEL_INDENT * (_saved.level + 1);
    ctx.listOffset = _offset;
    ctx.depth = _saved.depth + 1;
    ctx.level = _saved.level + 1;
    ctx.quoteStyle = _themed === true ? ctx.quoteTheme : null;
    _out += itemXml(item, ctx, api);
    _out += '</' + _frame.item + '>';
  });
  Object.assign(ctx, _saved);
  ctx.lists.pop();
  ctx.breakAfter = _after;
  _out = '<text:list text:style-name="' + _frame.style + '"' + (_frame.id !== null ? ' xml:id="' + _frame.id + '"' : '') + '>' + _out + '</text:list>';
  if (ctx.lists.length === 0 && ctx.reopened === true) {
    ctx.reopened = false;
    _out = dropEmptyReopen(_out);
  }
  return _out;
}

/** Пустые продолжения списков убираются (вложенные — проходами), затем xml:id списков, которые не продолжаются */
function dropEmptyReopen (xml) {
  var _out = xml;
  var _prev;
  do {
    _prev = _out;
    _out = _out.replace(EMPTY_REOPEN, '');
  } while (_out !== _prev);
  var _used = new Set();
  _out.replace(CONTINUE, function (all, id) {
    _used.add(id);
    return all;
  });
  return _out.replace(LIST_ID, function (all, id) {
    return _used.has(id) === true ? all : '';
  });
}

/** Таблица внутри пункта: открытые списки закрываются до неё и открываются после (продолжение — без маркера) */
function outsideLists (xml, ctx, api) {
  if (ctx.lists.length === 0) {
    return xml;
  }
  var _close = '';
  var _open = '';
  for (var i = ctx.lists.length - 1; i >= 0; i--) {
    _close += '</' + ctx.lists[i].item + '></text:list>';
  }
  ctx.lists.forEach(function (frame) {
    if (frame.id === null) {
      frame.id = api.uniqueName(ctx.job, 'CRhList');
    }
    _open += '<text:list text:style-name="' + frame.style + '" text:continue-list="' + frame.id + '"><text:list-header>';
    frame.item = 'text:list-header';
  });
  ctx.reopened = true;
  return _close + xml + _open;
}

// ---------------------------------------------------------------------------------------------------------------
// Таблицы

/**
 * Содержимое ячейки: блоки ячейки (и ячеек за 63-м столбцом) в своём контейнере; без text:p в конце (пустая или
 * таблица последней) — пустой абзац
 * @param  {Array}  cells  ячейки модели
 * @param  {Number} width  ширина ячейки (см) — для вложенных таблиц
 */
function cellContent (cells, width, ctx, api) {
  var _saved = { indent : ctx.indent, depth : ctx.depth, level : ctx.level, lead : ctx.lead, quoteStyle : ctx.quoteStyle, width : ctx.width,
    lists : ctx.lists, listOffset : ctx.listOffset, inCell : ctx.inCell, reopened : ctx.reopened };
  ctx.indent = 0;
  ctx.depth = _saved.depth + 1;
  ctx.level = 0;
  ctx.lead = null;
  ctx.quoteStyle = null;
  ctx.width = width;
  ctx.lists = [];
  ctx.listOffset = 0;
  ctx.inCell = true;
  ctx.reopened = false;
  var _xml = '';
  cells.forEach(function (cell) {
    _xml += api.blocksXml(cell.blocks, ctx);
  });
  if (_xml === '' || _xml.slice(-14) === '</table:table>') {
    _xml += api.spacerXml(ctx, []);
  }
  Object.assign(ctx, _saved);
  return _xml;
}

/**
 * Таблица модели → подпись (абзац) и table:table
 * @param  {Object} block  блок table модели { rows, caption, quote }
 * @param  {Object} ctx    контекст абзаца (html-odt.js)
 * @param  {Object} api    { blocksXml, writePara, lineXml, spacerXml, tableStyleAttr, uniqueName } из html-odt.js
 * @return {String}
 */
function tableXml (block, ctx, api) {
  var _out = '';
  if (block.caption !== null) {
    _out += api.writePara(block, api.lineXml(block.caption, ctx), ctx);
  }
  var _grid = layout(block.rows);
  var _total = ctx.width !== null ? ctx.width : ctx.parts.textWidth();
  var _indent = ctx.indent + QUOTE_INDENT * (block.quote > 0 ? block.quote : 0);
  var _width = _total - _indent > 0 ? _total - _indent : _total;
  var _props = [['style:width', odfStyles.formatCm(_width)]].concat(_indent > 0
    ? [['fo:margin-left', odfStyles.formatCm(_indent)], ['table:align', 'left']] : [['table:align', 'margins']]);
  if (ctx.pageBreak === true) {
    _props.push(['fo:break-before', 'page']);
    ctx.pageBreak = false;
  }
  if (ctx.breakAfter === true) {
    _props.push(['fo:break-after', 'page']);
    ctx.breakAfter = false;
  }
  ctx.job.ns.table = true;
  var _xml = '<table:table table:name="' + api.uniqueName(ctx.job, 'CRhTable') + '"' + api.tableStyleAttr(ctx, _props) + '>';
  var _column = _width / _grid.columns;
  _xml += ('<table:table-column table:style-name="' + ctx.odfStyles.column(_column) + '"/>').repeat(_grid.columns);
  var _cellStyle = ctx.odfStyles.cell();
  var _cell = function (cells, span, rows) {
    return '<table:table-cell table:style-name="' + _cellStyle + '"' + (span > 1 ? ' table:number-columns-spanned="' + span + '"' : '')
      + (rows > 1 ? ' table:number-rows-spanned="' + rows + '"' : '') + '>' + cellContent(cells, _column * span, ctx, api)
      + '</table:table-cell>' + COVERED.repeat(span - 1);
  };
  _grid.rows.forEach(function (entries) {
    _xml += '<table:table-row>';
    var _c = 0;
    entries.forEach(function (entry) {
      if (entry.col > _c) {
        _xml += _cell([], entry.col - _c, 1);
      }
      _xml += entry.merge === 'cont' ? COVERED.repeat(entry.span) : _cell([entry.cell].concat(entry.more), entry.span, entry.rowspan);
      _c = entry.col + entry.span;
    });
    if (_c < _grid.columns) {
      _xml += _cell([], _grid.columns - _c, 1);
    }
    _xml += '</table:table-row>';
  });
  return _out + outsideLists(_xml + '</table:table>', ctx, api);
}

module.exports = {
  listXml,
  tableXml
};
