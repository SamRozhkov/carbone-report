// drop / keep Carbone EE — своя реализация (чистая комната) по открытой документации
// (docs/superpowers/notes/2026-10-10-ee-aggregators-drop-sort.md §2, спецификация §31.2).
//
// Метка «{d.x:ifEM:drop(p, 3)}» ничего не печатает, а удаляет элемент документа вокруг себя. Порядок:
//   1. prepare — до сборки: проверка аргументов и сочетания элемента с форматом; drop(p, 3) переписывается во
//      «drop(k<ключ>i<номер>)», номер ведёт к записи { kind, el, n, source } этой сборки, ключ — случайный на сборку
//      (жетон из данных отчёта не совпадёт с ним и ничего не удалит);
//   2. форматтер drop/keep печатает жетон «k<ключ>i<номер><1|0>» (1 — условие истинно) из области частного
//      использования;
//   3. apply — после сборки XML файла: по жетонам ищется ближайший охватывающий элемент нужного типа и удаляется
//      (keep — при ложном условии); сами жетоны вырезаются. Шаблон без drop/keep не затрагивается.

var crypto = require('crypto');
var splitChain = require('./set').splitChain;

// жетон: символы частного использования, отличные от жетонов агрегаторов (lib/aggregate.js: U+E000/U+E001)
var OPEN = '\uE010';
var CLOSE = '\uE011';
var TOKEN_REGEX = /\uE010k([0-9a-f]{12})i(\d+)([01])\uE011/g;

var NAMES = ['drop', 'keep'];

// форматтеры, которые могут остановить цепочку до drop/keep — тогда жетон не печатается и drop молча не работает
var STOPPING = ['show', 'elseShow', 'showBegin', 'showEnd', 'hideBegin', 'hideEnd', 'ifEqual', 'ifContain'];

// элементы по форматам (справочник §2, спецификация §31.2)
var SUPPORTED = {
  docx : ['p', 'row', 'table', 'img', 'shape', 'chart', 'col'],
  odt  : ['p', 'row', 'table', 'img', 'shape', 'chart', 'col', 'item', 'h'],
  pptx : ['p', 'row', 'table', 'img', 'shape', 'chart', 'col'],
  odp  : ['p', 'row', 'table', 'img', 'shape', 'chart', 'col', 'slide', 'item'],
  xlsx : ['row', 'col'],
  ods  : ['row', 'col', 'img', 'sheet']
};

var ALL = ['p', 'row', 'table', 'img', 'shape', 'chart', 'col', 'slide', 'item', 'h', 'sheet'];

// где должна стоять метка (для ошибки «элемент не найден»)
var WHERE = {
  p     : 'внутри абзаца',
  row   : 'внутри строки таблицы',
  table : 'внутри таблицы',
  img   : 'в замещающем тексте (названии или описании) изображения',
  shape : 'в замещающем тексте (названии или описании) фигуры',
  chart : 'в замещающем тексте (названии или описании) диаграммы',
  col   : 'в ячейке таблицы',
  slide : 'на слайде',
  item  : 'внутри элемента списка',
  h     : 'внутри заголовка',
  sheet : 'в ячейке листа'
};

var ODF_SHAPES = ['draw:custom-shape', 'draw:rect', 'draw:ellipse', 'draw:circle', 'draw:line', 'draw:polyline',
  'draw:polygon', 'draw:regular-polygon', 'draw:path', 'draw:connector', 'draw:measure', 'draw:caption', 'draw:g', 'draw:frame'];

function templateError (message, source) {
  return new Error(message + ' Source: "' + source + '"');
}

function formatName (extension) {
  return typeof extension === 'string' && extension !== '' ? extension.toUpperCase() : 'этом формате';
}

function unquote (arg) {
  var _match = /^'([\s\S]*)'$/.exec(arg);
  return _match !== null ? _match[1] : arg;
}

/**
 * Аргументы форматтера через запятую вне кавычек: «p, 3» → ['p', '3']
 */
function splitArgs (str) {
  var _args = [];
  var _current = '';
  var _quote = false;
  for (var i = 0; i < str.length; i++) {
    var _char = str[i];
    if (_char === '\'') {
      _quote = !_quote;
    }
    if (_char === ',' && _quote === false) {
      _args.push(_current.trim());
      _current = '';
      continue;
    }
    _current += _char;
  }
  _args.push(_current.trim());
  return _args;
}

/**
 * Проверить и переписать метки с drop/keep. Вызывается в buildXML перед сборкой.
 * @param  {Array}  markers    метки сборки (name меняется, исходное имя сохраняется в source)
 * @param  {String} extension  формат шаблона (options.extension)
 * @return {Array|null}        записи { kind, el, n, source } по номерам или null — в метках нет drop/keep
 */
function prepare (markers, extension) {
  var _registry = null;
  var _ext = typeof extension === 'string' ? extension.toLowerCase() : '';
  for (var i = 0; i < markers.length; i++) {
    var _marker = markers[i];
    if (/:\s*(?:drop|keep)\b/.test(_marker.name) === false) {
      continue;
    }
    var _chain = splitChain(_marker.name);
    var _changed = false;
    for (var j = 1; j < _chain.length; j++) {
      var _str = _chain[j].trim();
      var _open = _str.indexOf('(');
      var _name = (_open === -1 ? _str : _str.slice(0, _open)).trim();
      if (NAMES.indexOf(_name) === -1) {
        continue;
      }
      var _source = '{' + (_marker.source || _marker.name).replace(/^_root\./, '') + '}';
      if (j !== _chain.length - 1) {
        throw templateError(_name + ' должен быть последним форматтером метки: он ничего не печатает, а удаляет элемент документа.', _source);
      }
      for (var k = 1; k < j; k++) {
        var _prev = _chain[k].trim().split('(')[0].trim();
        if (STOPPING.indexOf(_prev) !== -1) {
          throw templateError(_prev + ' перед ' + _name + ' не сочетается с ним: условие задаётся ifEQ, ifNE, ifGT, ifEM и т. п., например {d.x:ifEQ(1):' + _name + '(p)}.', _source);
        }
      }
      var _inside = _open === -1 ? '' : _str.slice(_open + 1, _str.lastIndexOf(')'));
      var _args = _inside.trim() === '' ? [] : splitArgs(_inside).map(unquote);
      if (_args.length === 0 || _args[0] === '') {
        throw templateError('Укажите, что удалять: например ' + _name + '(p) — абзац или ' + _name + '(row) — строку таблицы.', _source);
      }
      var _el = _args[0];
      var _supported = SUPPORTED[_ext];
      if (ALL.indexOf(_el) === -1 || _supported === undefined || _supported.indexOf(_el) === -1) {
        throw templateError(_name + '(' + _el + ') не поддерживается в ' + formatName(extension) + '.'
          + (_supported !== undefined ? ' Доступно: ' + _supported.join(', ') + '.' : ''), _source);
      }
      var _n = 1;
      if (_args.length > 2) {
        throw templateError('У ' + _name + ' не больше двух аргументов: элемент и количество, например ' + _name + '(p, 3).', _source);
      }
      if (_args.length === 2) {
        if (_el !== 'p' && _el !== 'row') {
          throw templateError('Количество во втором аргументе ' + _name + ' задаётся только для p и row.', _source);
        }
        if (/^[1-9]\d{0,5}$/.test(_args[1]) === false) {
          throw templateError('Второй аргумент ' + _name + ' — целое число от 1: сколько элементов удалить, считая текущий.', _source);
        }
        _n = parseInt(_args[1], 10);
      }
      if (_registry === null) {
        _registry = [];
        _registry.nonce = crypto.randomBytes(6).toString('hex');
      }
      _chain[j] = _name + '(k' + _registry.nonce + 'i' + _registry.length + ')';
      _registry.push({ kind : _name, el : _el, n : _n, source : _source });
      _changed = true;
    }
    if (_changed === true) {
      if (_marker.source === undefined) {
        _marker.source = _marker.name;
      }
      _marker.name = _chain.join(':');
    }
  }
  return _registry;
}

/**
 * Условие для drop/keep: результат ifXX, иначе само значение — булево как есть, прочее — «не пусто» по правилам ifNEM
 */
function isTrue (context, d) {
  if (context.isConditionTrue === true || context.isConditionTrue === false) {
    return context.isConditionTrue;
  }
  if (d === true || d === false) {
    return d;
  }
  return !(d === null
    || d === undefined
    || d === ''
    || d instanceof Array && d.length === 0
    || d instanceof Object && d.constructor === Object && Object.keys(d).length === 0
    || Number.isNaN(d) === true);
}

function tokenFormatter (d, id) {
  // без номера (метка не прошла prepare) жетон не печатается
  if (/^k[0-9a-f]{12}i\d+$/.test(String(id)) === false) {
    return '';
  }
  return OPEN + id + (isTrue(this, d) === true ? '1' : '0') + CLOSE;
}

/**
 * Удаляет элемент документа вокруг метки, если условие истинно (`ifXX` слева или булево/непустое значение).
 * Элементы: p, row, table, img, shape, chart, col, slide, item, h, sheet (по формату). Только платная сборка 2.2.0.
 *
 * @version 2.2.0
 * @param {Mixed} d
 * @param {String} id  внутренний номер метки (переписывается из «drop(p, 3)» до сборки)
 */
function drop (d, id) {
  return tokenFormatter.call(this, d, id);
}

/**
 * Оставляет элемент документа вокруг метки, только если условие истинно; иначе удаляет (обратное drop).
 *
 * @version 2.2.0
 * @param {Mixed} d
 * @param {String} id  внутренний номер метки
 */
function keep (d, id) {
  return tokenFormatter.call(this, d, id);
}

// ---------------------------------------------------------------------------------------------------------------
// Разбор XML в дерево элементов (позиции в строке) — один проход

var TAG_REGEX = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * @return {Object} { root, tokens } — tokens: жетоны с элементом, внутри которого (или в теге которого) они стоят
 */
function parse (xml, registry) {
  var _root = { name : '', start : 0, openEnd : 0, closeStart : xml.length, end : xml.length, parent : null, children : [] };
  var _stack = [_root];
  var _tokens = [];
  TOKEN_REGEX.lastIndex = 0;
  var _token = TOKEN_REGEX.exec(xml);
  var _nextToken = function () {
    _token = TOKEN_REGEX.exec(xml);
  };
  var _assign = function (upTo, el) {
    while (_token !== null && _token.index < upTo) {
      var _id = parseInt(_token[2], 10);
      if (_token[1] === registry.nonce && registry[_id] !== undefined) {
        _tokens.push({ id : _id, cond : _token[3] === '1', pos : _token.index, len : _token[0].length, el : el || _stack[_stack.length - 1] });
      }
      _nextToken();
    }
  };
  TAG_REGEX.lastIndex = 0;
  var _match;
  while ((_match = TAG_REGEX.exec(xml)) !== null) {
    var _start = _match.index;
    var _end = _start + _match[0].length;
    _assign(_start, null);
    if (_match[2] === undefined) {
      // комментарий, CDATA, объявление
      _assign(_end, null);
      continue;
    }
    if (_match[1] === '/') {
      var _el = _stack.pop();
      // несбалансированный XML — поднимаемся до одноимённого открытого элемента
      while (_el !== _root && _el.name !== _match[2] && _stack.length > 1) {
        _el.closeStart = _start;
        _el.end = _start;
        _el = _stack.pop();
      }
      if (_el === _root) {
        _stack.push(_root);
        continue;
      }
      _el.closeStart = _start;
      _el.end = _end;
      continue;
    }
    var _parent = _stack[_stack.length - 1];
    var _node = { name : _match[2], start : _start, openEnd : _end, closeStart : _end, end : _end, parent : _parent, children : [], index : _parent.children.length };
    _parent.children.push(_node);
    // жетон в атрибуте (замещающий текст картинки) принадлежит самому элементу
    _assign(_end, _node);
    if (_match[4] !== '/') {
      _stack.push(_node);
    }
  }
  _assign(Infinity, null);
  return { root : _root, tokens : _tokens };
}

function closest (el, names, check) {
  for (var _el = el; _el !== null; _el = _el.parent) {
    if (names.indexOf(_el.name) !== -1 && (check === undefined || check(_el) === true)) {
      return _el;
    }
  }
  return null;
}

function hasDescendant (el, names) {
  for (var i = 0; i < el.children.length; i++) {
    if (names.indexOf(el.children[i].name) !== -1 || hasDescendant(el.children[i], names) === true) {
      return true;
    }
  }
  return false;
}

/** Потомки с именем name, ближайший предок-«владелец» (ownerNames) которых — owner */
function owned (owner, name, ownerNames) {
  var _res = [];
  var _walk = function (el) {
    for (var i = 0; i < el.children.length; i++) {
      var _child = el.children[i];
      if (_child.name === name) {
        _res.push(_child);
      }
      // вложенная таблица — свои строки и ячейки
      if (ownerNames.indexOf(_child.name) === -1) {
        _walk(_child);
      }
    }
  };
  _walk(owner);
  return _res;
}

function startTag (xml, el) {
  return xml.slice(el.start, el.openEnd);
}

function attr (xml, el, name) {
  var _match = new RegExp('\\s' + name.replace(/[.:-]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(startTag(xml, el));
  if (_match === null) {
    return null;
  }
  return _match[1] !== undefined ? _match[1] : _match[2];
}

function setAttr (tag, name, value) {
  return tag.replace(new RegExp('(\\s' + name.replace(/[.:-]/g, '\\$&') + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\')'), '$1"' + value + '"');
}

// ---------------------------------------------------------------------------------------------------------------
// Правила по форматам

function family (ext) {
  if (ext === 'docx') {
    return 'w';
  }
  if (ext === 'pptx') {
    return 'p';
  }
  if (ext === 'xlsx') {
    return 'x';
  }
  return 'odf';
}

/**
 * Элемент, который удаляет drop(el) с меткой внутри node, или null
 */
function findTarget (fam, el, node) {
  var _found;
  if (fam === 'w') {
    var _drawing = function (names) {
      var _d = closest(node, ['w:drawing'], function (x) {
        return hasDescendant(x, names);
      });
      // фигура и диаграмма в Word обычно лежат в mc:AlternateContent (Choice + запасной VML) — удаляем весь блок
      if (_d !== null && _d.parent !== null && _d.parent.name === 'mc:Choice' && _d.parent.parent !== null && _d.parent.parent.name === 'mc:AlternateContent') {
        return _d.parent.parent;
      }
      if (_d !== null) {
        return _d;
      }
      // метка в запасном VML (mc:Fallback) того же объекта
      return closest(node, ['mc:AlternateContent'], function (x) {
        return x.children.some(function (choice) {
          return choice.name === 'mc:Choice' && choice.children.some(function (d) {
            return d.name === 'w:drawing' && hasDescendant(d, names);
          });
        });
      });
    };
    switch (el) {
      case 'p': return closest(node, ['w:p']);
      case 'row': return closest(node, ['w:tr']);
      case 'table': return closest(node, ['w:tbl']);
      case 'img': return _drawing(['pic:pic']);
      case 'shape': return _drawing(['wps:wsp', 'wpg:wgp', 'wpc:wpc']);
      case 'chart': return _drawing(['c:chart']);
      default: return null;
    }
  }
  if (fam === 'p') {
    switch (el) {
      case 'p': return closest(node, ['a:p']);
      case 'row': return closest(node, ['a:tr']);
      case 'table':
        _found = closest(node, ['a:tbl']);
        return _found === null ? null : (closest(_found, ['p:graphicFrame']) || _found);
      case 'img': return closest(node, ['p:pic']);
      case 'shape': return closest(node, ['p:sp', 'p:cxnSp', 'p:grpSp']);
      case 'chart': return closest(node, ['p:graphicFrame'], function (x) {
        return hasDescendant(x, ['c:chart']);
      });
      default: return null;
    }
  }
  if (fam === 'x') {
    return el === 'row' ? closest(node, ['row']) : null;
  }
  switch (el) {
    case 'p': return closest(node, ['text:p']);
    case 'h': return closest(node, ['text:h']);
    case 'item': return closest(node, ['text:list-item']);
    case 'row': return closest(node, ['table:table-row']);
    case 'table':
      _found = closest(node, ['table:table']);
      // таблица презентации лежит во фрейме
      return _found !== null && _found.parent !== null && _found.parent.name === 'draw:frame' ? _found.parent : _found;
    case 'sheet': return closest(node, ['table:table'], function (x) {
      return x.parent !== null && x.parent.name === 'office:spreadsheet';
    });
    case 'slide': return closest(node, ['draw:page']);
    case 'img': return closest(node, ['draw:frame'], function (x) {
      return hasDescendant(x, ['draw:image']);
    });
    case 'chart': return closest(node, ['draw:frame'], function (x) {
      return hasDescendant(x, ['draw:object', 'draw:object-ole']);
    });
    case 'shape': return closest(node, ODF_SHAPES, function (x) {
      return x.name !== 'draw:frame' || hasDescendant(x, ['draw:text-box']);
    });
    default: return null;
  }
}

// таблицы для drop(col): ячейка, строка, таблица, описание столбцов
var COL = {
  w   : { cells : ['w:tc'], row : 'w:tr', table : 'w:tbl', column : 'w:gridCol' },
  p   : { cells : ['a:tc'], row : 'a:tr', table : 'a:tbl', column : 'a:gridCol' },
  odf : { cells : ['table:table-cell', 'table:covered-table-cell'], row : 'table:table-row', table : 'table:table', column : 'table:table-column' },
  x   : { cells : ['c'], row : 'row', table : null, column : 'col' }
};

// ---------------------------------------------------------------------------------------------------------------

/**
 * Обработать жетоны drop/keep в собранном XML файла
 * @param  {String} xml
 * @param  {Array}  registry   записи prepare
 * @param  {String} extension
 * @return {String}
 */
function apply (xml, registry, extension) {
  if (registry === null || registry === undefined || typeof xml !== 'string' || xml.indexOf(OPEN) === -1) {
    return xml;
  }
  var _ext = typeof extension === 'string' ? extension.toLowerCase() : '';
  var _fam = family(_ext);
  var _parsed = parse(xml, registry);
  var _removed = new Set();
  var _replaced = new Map();
  var _tagEdits = new Map();
  var _inserts = [];
  var _edits = [];
  var _cols = new Map(); // таблица → { indices: Set, source }
  var _checked = new Set(); // таблицы, проверенные для drop(col)
  var _sourceOf = new Map(); // удалённый элемент → метка (для ошибок)

  _parsed.tokens.forEach(function (token) {
    var _entry = registry[token.id];
    _edits.push({ start : token.pos, end : token.pos + token.len, rep : '' });
    var _remove = (_entry.kind === 'drop') === token.cond;
    if (_entry.el === 'col') {
      var _c = COL[_fam];
      var _cell = closest(token.el, _c.cells);
      var _row = _cell === null ? null : closest(_cell.parent, [_c.row]);
      var _table = _row === null ? null : (_c.table === null ? _parsed.root : closest(_row.parent, [_c.table]));
      if (_table === null) {
        throw templateError('Для ' + _entry.kind + '(col) метка должна стоять ' + WHERE.col + '.', _entry.source);
      }
      if (_checked.has(_table) === false) {
        checkColumns(xml, _fam, _table, _entry.source);
        _checked.add(_table);
      }
      if (_remove === true) {
        var _index = columnIndex(xml, _fam, _c, _row, _cell);
        var _col = _cols.get(_table);
        if (_col === undefined) {
          _col = { indices : new Set(), source : _entry.source };
          _cols.set(_table, _col);
        }
        _col.indices.add(_index);
      }
      return;
    }
    var _target = findTarget(_fam, _entry.el, token.el);
    if (_target === null) {
      throw templateError('Для ' + _entry.kind + '(' + _entry.el + ') метка должна стоять ' + WHERE[_entry.el] + '.', _entry.source);
    }
    if (_remove === false) {
      return;
    }
    _removed.add(_target);
    _sourceOf.set(_target, _entry.source);
    // drop(p, 3) / drop(row, 3): текущий и N−1 следующих элементов того же типа в том же родителе
    if (_entry.n > 1 && _target.parent !== null) {
      var _siblings = _target.parent.children;
      var _left = _entry.n - 1;
      for (var s = _target.index + 1; s < _siblings.length && _left > 0; s++) {
        if (_siblings[s].name === _target.name) {
          _removed.add(_siblings[s]);
          _sourceOf.set(_siblings[s], _entry.source);
          _left--;
        }
      }
    }
  });

  _cols.forEach(function (col, table) {
    removeColumns(xml, _fam, table, col, _removed, _tagEdits);
  });

  var _isRemoved = function (el) {
    for (var _el = el; _el !== null; _el = _el.parent) {
      if (_removed.has(_el) === true) {
        return true;
      }
    }
    return false;
  };

  fixStructure(xml, _fam, _ext, _parsed.root, _removed, _replaced, _inserts, _cols, _sourceOf, _isRemoved);

  _removed.forEach(function (el) {
    _edits.push({ start : el.start, end : el.end, rep : _replaced.has(el) === true ? _replaced.get(el) : '' });
  });
  _tagEdits.forEach(function (tag, el) {
    _edits.push({ start : el.start, end : el.openEnd, rep : tag });
  });
  _inserts.forEach(function (insert) {
    _edits.push({ start : insert.pos, end : insert.pos, rep : insert.rep });
  });
  // по началу; вставка раньше элемента с тем же началом; внешний элемент раньше вложенного
  _edits.sort(function (a, b) {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if ((a.start === a.end) !== (b.start === b.end)) {
      return a.start === a.end ? -1 : 1;
    }
    return b.end - a.end;
  });
  var _out = '';
  var _cursor = 0;
  for (var i = 0; i < _edits.length; i++) {
    var _edit = _edits[i];
    if (_edit.start < _cursor) {
      // правка внутри уже удалённого элемента
      continue;
    }
    _out += xml.slice(_cursor, _edit.start) + _edit.rep;
    _cursor = Math.max(_cursor, _edit.end);
  }
  return _out + xml.slice(_cursor);
}

function repeatOf (xml, el, name) {
  var _value = parseInt(attr(xml, el, name) || '1', 10);
  return Number.isFinite(_value) === true && _value > 0 ? _value : 1;
}

/** Номер столбца ячейки (с 0) */
function columnIndex (xml, fam, c, row, cell) {
  var _cells = rowCells(row, c);
  var _index = 0;
  for (var i = 0; i < _cells.length; i++) {
    if (_cells[i] === cell) {
      return _index;
    }
    _index += fam === 'odf' ? repeatOf(xml, _cells[i], 'table:number-columns-repeated') : 1;
  }
  return _index;
}

/** Ячейки строки по порядку (все виды ячеек формата) */
function rowCells (row, c) {
  var _res = [];
  var _walk = function (el) {
    for (var i = 0; i < el.children.length; i++) {
      var _child = el.children[i];
      if (c.cells.indexOf(_child.name) !== -1) {
        _res.push(_child);
      }
      else if (_child.name !== c.table && _child.name !== c.row) {
        _walk(_child);
      }
    }
  };
  _walk(row);
  return _res;
}

/**
 * Можно ли удалять столбцы таблицы. Проверяется у каждой метки drop(col), независимо от условия.
 */
function checkColumns (xml, fam, table, source) {
  var c = COL[fam];
  var _owners = c.table === null ? [] : [c.table];
  var _rows = owned(table, c.row, _owners);
  // форматированная таблица Excel (xl/tables/*.xml) хранит заголовки и диапазон столбцов отдельно от листа —
  // после удаления столбца Excel «восстанавливает» файл
  if (fam === 'x' && /<(?:\w+:)?tablePart\b/.test(xml) === true) {
    throw templateError('drop(col) не поддерживается на листах XLSX с форматированными таблицами («Форматировать как таблицу»): '
      + 'преобразуйте таблицу в обычный диапазон или скрывайте столбец иначе.', source);
  }
  var _mergeError = function () {
    return templateError('drop(col) не поддерживается в таблицах с объединёнными по горизонтали ячейками.', source);
  };
  // объединённые ячейки по горизонтали сдвигают номера столбцов — не поддерживаются
  _rows.forEach(function (row) {
    rowCells(row, c).forEach(function (cell) {
      if (fam === 'w') {
        var _span = owned(cell, 'w:gridSpan', ['w:tbl', 'w:tc']).filter(function (g) {
          return parseInt(attr(xml, g, 'w:val') || '1', 10) > 1;
        });
        if (_span.length > 0 || owned(cell, 'w:hMerge', ['w:tbl', 'w:tc']).length > 0) {
          throw _mergeError();
        }
      }
      else if (fam === 'p') {
        if (parseInt(attr(xml, cell, 'gridSpan') || '1', 10) > 1 || /^(?:1|true)$/.test(attr(xml, cell, 'hMerge') || '') === true) {
          throw _mergeError();
        }
      }
      else if (fam === 'odf') {
        if (repeatOf(xml, cell, 'table:number-columns-spanned') > 1) {
          throw _mergeError();
        }
      }
    });
    if (fam === 'w' && (owned(row, 'w:gridBefore', ['w:tbl', 'w:tc']).length > 0 || owned(row, 'w:gridAfter', ['w:tbl', 'w:tc']).length > 0)) {
      throw _mergeError();
    }
  });
}

/**
 * Удалить столбцы indices таблицы: ячейки во всех строках и описания столбцов
 */
function removeColumns (xml, fam, table, col, removed, tagEdits) {
  var c = COL[fam];
  var _owners = c.table === null ? [] : [c.table];
  var _rows = owned(table, c.row, _owners);
  var _cut = function (items, repeatAttr) {
    var _index = 0;
    items.forEach(function (item) {
      var _count = repeatAttr === null ? 1 : repeatOf(xml, item, repeatAttr);
      var _hit = 0;
      col.indices.forEach(function (index) {
        if (index >= _index && index < _index + _count) {
          _hit++;
        }
      });
      if (_hit === _count) {
        removed.add(item);
      }
      else if (_hit > 0) {
        tagEdits.set(item, setAttr(startTag(xml, item), repeatAttr, String(_count - _hit)));
      }
      _index += _count;
    });
  };
  var _repeatCell = fam === 'odf' ? 'table:number-columns-repeated' : null;
  _rows.forEach(function (row) {
    _cut(rowCells(row, c), _repeatCell);
  });
  if (fam === 'x') {
    // <col min max> — номера с 1, сдвигаются на число удалённых столбцов левее
    var _removedList = Array.from(col.indices);
    owned(table, 'col', []).forEach(function (def) {
      var _min = parseInt(attr(xml, def, 'min'), 10);
      var _max = parseInt(attr(xml, def, 'max'), 10);
      if (Number.isFinite(_min) === false || Number.isFinite(_max) === false) {
        return;
      }
      var _before = _removedList.filter(function (index) {
        return index + 1 < _min;
      }).length;
      var _inside = _removedList.filter(function (index) {
        return index + 1 >= _min && index + 1 <= _max;
      }).length;
      if (_inside === _max - _min + 1) {
        removed.add(def);
        // <cols> без <col> недопустим (Excel «восстанавливает» файл)
        if (def.parent !== null && def.parent.name === 'cols' && def.parent.children.every(function (x) {
          return x.name !== 'col' || removed.has(x) === true;
        }) === true) {
          removed.add(def.parent);
        }
        return;
      }
      if (_before > 0 || _inside > 0) {
        tagEdits.set(def, setAttr(setAttr(startTag(xml, def), 'min', String(_min - _before)), 'max', String(_max - _before - _inside)));
      }
    });
    return;
  }
  _cut(owned(table, c.column, _owners), fam === 'odf' ? 'table:number-columns-repeated' : null);
}

/**
 * Чтобы файл оставался валидным: таблица без строк или столбцов удаляется целиком, ячейка Word кончается абзацем,
 * текст фигуры PowerPoint — хотя бы один абзац, лист ODS — хотя бы одна строка; удалить все листы или слайды нельзя.
 */
// контейнеры блоков Word: 'p' — должен кончаться абзацем, 'any' — хотя бы один блок
var WORD_BLOCKS = {
  'w:tc'          : 'p',
  'w:txbxContent' : 'p',
  'w:hdr'         : 'p',
  'w:ftr'         : 'p',
  'w:footnote'    : 'p',
  'w:endnote'     : 'p',
  'w:comment'     : 'p',
  'w:sdtContent'  : 'any'
};

function fixStructure (xml, fam, ext, root, removed, replaced, inserts, cols, sourceOf, isRemoved) {
  var c = COL[fam];
  if (fam === 'odf') {
    // группы строк и столбцов ODF (заголовок, группа) не бывают пустыми — удаляются вместе с последним элементом
    var _groups = {
      'table:table-header-rows'    : 'table:table-row',
      'table:table-rows'           : 'table:table-row',
      'table:table-row-group'      : 'table:table-row',
      'table:table-header-columns' : 'table:table-column',
      'table:table-columns'        : 'table:table-column',
      'table:table-column-group'   : 'table:table-column'
    };
    Array.from(removed).forEach(function (el) {
      for (var _group = el.parent; _group !== null && _groups[_group.name] !== undefined && removed.has(_group) === false; _group = _group.parent) {
        var _empty = _group.children.every(function (child) {
          return (child.name !== _groups[_group.name] && _groups[child.name] === undefined) || isRemoved(child) === true;
        });
        if (_empty === false) {
          break;
        }
        removed.add(_group);
        sourceOf.set(_group, sourceOf.get(el));
      }
    });
  }
  if (c.table !== null) {
    var _tables = new Set();
    removed.forEach(function (el) {
      if (el.name === c.row || el.name === c.column) {
        var _t = closest(el.parent, [c.table]);
        if (_t !== null) {
          _tables.add(_t);
          if (sourceOf.has(_t) === false) {
            sourceOf.set(_t, sourceOf.get(el));
          }
        }
      }
    });
    cols.forEach(function (col, table) {
      _tables.add(table);
      if (sourceOf.has(table) === false) {
        sourceOf.set(table, col.source);
      }
    });
    _tables.forEach(function (table) {
      if (isRemoved(table) === true) {
        return;
      }
      var _rows = owned(table, c.row, [c.table]);
      var _liveRows = _rows.filter(function (r) {
        return isRemoved(r) === false;
      });
      var _columns = owned(table, c.column, [c.table]);
      var _noColumns = _columns.length > 0 && _columns.every(isRemoved);
      if (_liveRows.length > 0 && _noColumns === false) {
        return;
      }
      var _isSheet = ext === 'ods' && table.parent !== null && table.parent.name === 'office:spreadsheet';
      if (_isSheet === true) {
        // лист без строк недопустим — оставляем одну пустую строку
        if (_liveRows.length === 0 && _rows.length > 0) {
          replaced.set(_rows[_rows.length - 1], '<table:table-row><table:table-cell/></table:table-row>');
        }
        return;
      }
      var _whole = table;
      if (fam === 'p') {
        _whole = closest(table, ['p:graphicFrame']) || table;
      }
      else if (fam === 'odf' && table.parent !== null && table.parent.name === 'draw:frame') {
        _whole = table.parent;
      }
      removed.add(_whole);
      sourceOf.set(_whole, sourceOf.get(table));
    });
  }
  // контейнеры, из которых что-то удалено
  var _containers = new Set();
  removed.forEach(function (el) {
    if (el.parent !== null && isRemoved(el.parent) === false) {
      _containers.add(el.parent);
    }
  });
  _containers.forEach(function (parent) {
    if (fam === 'w' && WORD_BLOCKS[parent.name] !== undefined) {
      // ячейка, надпись, колонтитул, сноска, примечание Word должны кончаться абзацем; блок sdt — не быть пустым
      var _last = null;
      parent.children.forEach(function (child) {
        if ((child.name === 'w:p' || child.name === 'w:tbl' || child.name === 'w:sdt') && isRemoved(child) === false) {
          _last = child;
        }
      });
      if (_last === null || (WORD_BLOCKS[parent.name] === 'p' && _last.name !== 'w:p')) {
        inserts.push({ pos : parent.closeStart, rep : '<w:p/>' });
      }
    }
    else if (fam === 'p' && (parent.name === 'a:txBody' || parent.name === 'p:txBody')) {
      var _hasP = parent.children.some(function (child) {
        return child.name === 'a:p' && isRemoved(child) === false;
      });
      if (_hasP === false) {
        inserts.push({ pos : parent.closeStart, rep : '<a:p/>' });
      }
    }
    else if (fam === 'odf' && (parent.name === 'office:presentation' || parent.name === 'office:spreadsheet')) {
      var _kind = parent.name === 'office:presentation' ? 'draw:page' : 'table:table';
      var _all = parent.children.filter(function (child) {
        return child.name === _kind;
      });
      if (_all.length > 0 && _all.every(isRemoved) === true) {
        var _source = sourceOf.get(_all.find(function (x) {
          return sourceOf.has(x);
        }));
        throw templateError(_kind === 'draw:page'
          ? 'drop(slide) удалил бы все слайды презентации: хотя бы один слайд должен остаться.'
          : 'drop(sheet) удалил бы все листы: хотя бы один лист должен остаться.', _source);
      }
    }
  });
}

module.exports = {
  prepare,
  apply,
  formatters : { drop, keep },
  SUPPORTED
};
