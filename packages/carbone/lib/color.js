// :color Carbone EE — своя реализация (чистая комната) по открытой документации
// (docs/superpowers/notes/2026-10-10-ee-images-barcodes-colors.md §3, спецификация §32.4, решение R5 плана 2.4.0).
//
// Метка «{d.c:color(scope, type)}» ничего не печатает, а красит элемент документа вокруг себя. Порядок как у drop
// (lib/drop.js):
//   1. prepare — до сборки: проверка аргументов и сочетания с форматом; color(p, text) переписывается в
//      «color(k<ключ>i<номер>)», номер ведёт к записи { scope, type, source } этой сборки;
//   2. форматтер color печатает жетон «k<ключ>i<номер>c<RRGGBB>» из области частного использования;
//   3. apply — после сборки XML файла: каждый жетон красит своё вхождение элемента (в цикле — каждую строку своим
//      цветом), сами жетоны вырезаются. Файл без жетонов не затрагивается.
//
// DOCX и PPTX — свойства прямо в разметке (w:color, w:shd, a:solidFill…), с порядком дочерних элементов по схеме.
// ODT и ODP (R5) — новый автоматический стиль CRc<n>: родитель — исходный общий стиль элемента; исходный
// автоматический стиль этого файла копируется целиком (автоматический стиль не бывает родителем). Одинаковые стили
// (семейство, исходный стиль, свойства) в файле не дублируются.

var crypto = require('crypto');
var splitChain = require('./set').splitChain;
var xmltree = require('./xmltree');

var closest = xmltree.closest;
var descendants = xmltree.descendants;
var startTag = xmltree.startTag;
var attr = xmltree.attr;
var putAttr = xmltree.putAttr;

// жетон: символы частного использования, отличные от агрегаторов (U+E000/U+E001) и drop/keep (U+E010/U+E011)
var OPEN = '';
var CLOSE = '';
var TOKEN_REGEX = /k([0-9a-f]{12})i(\d+)c([0-9A-F]{6})/g;

var SCOPES = ['p', 'cell', 'row', 'shape', 'part'];
var TYPES = ['text', 'highlight', 'background', 'border'];
var GRAY = '888888';

// сочетания по форматам (справочник §3, спецификация §32.4): DOCX — text, background; ODT/ODP — text, highlight,
// background; PPTX — всё, border только у фигур; part — только ODT. Фигуры в DOCX и фон абзаца в PPTX не заявлены.
var SUPPORTED = {
  docx : {
    p    : ['text', 'background'],
    cell : ['text', 'background'],
    row  : ['text', 'background']
  },
  pptx : {
    p     : ['text', 'highlight'],
    cell  : ['text', 'highlight', 'background'],
    row   : ['text', 'highlight', 'background'],
    shape : ['text', 'highlight', 'background', 'border']
  },
  odt : {
    p     : ['text', 'highlight', 'background'],
    cell  : ['text', 'highlight', 'background'],
    row   : ['text', 'highlight', 'background'],
    shape : ['text', 'highlight', 'background'],
    part  : ['text', 'highlight']
  },
  odp : {
    p     : ['text', 'highlight', 'background'],
    cell  : ['text', 'highlight', 'background'],
    row   : ['text', 'highlight', 'background'],
    shape : ['text', 'highlight', 'background']
  }
};

// где должна стоять метка (для ошибки «элемент не найден»)
var WHERE = {
  p     : 'внутри абзаца',
  cell  : 'в ячейке таблицы',
  row   : 'внутри строки таблицы',
  shape : 'в тексте или замещающем тексте фигуры',
  part  : 'внутри фрагмента текста со своим стилем (text:span)'
};

var ODF_SHAPES = ['draw:custom-shape', 'draw:rect', 'draw:ellipse', 'draw:circle', 'draw:line', 'draw:polyline',
  'draw:polygon', 'draw:regular-polygon', 'draw:path', 'draw:connector', 'draw:measure', 'draw:caption', 'draw:frame'];

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

/** Аргументы форматтера через запятую вне кавычек: «p, text» → ['p', 'text'] */
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

/** Проверить область и тип для формата; ошибка шаблона или ничего */
function check (ext, extension, scope, type, source) {
  if (SCOPES.indexOf(scope) === -1) {
    throw templateError('color: неизвестная область «' + scope + '». Доступно: ' + SCOPES.join(', ') + '.', source);
  }
  if (TYPES.indexOf(type) === -1) {
    throw templateError('color: неизвестный тип «' + type + '». Доступно: ' + TYPES.join(', ') + '.', source);
  }
  if (ext === 'xlsx' || ext === 'ods') {
    throw templateError('color не поддерживается в XLSX/ODS', source);
  }
  var _formats = SUPPORTED[ext];
  if (_formats === undefined) {
    throw templateError('color не поддерживается в ' + formatName(extension) + '. Доступно в DOCX, PPTX, ODT и ODP.', source);
  }
  if (scope === 'part' && ext !== 'odt') {
    throw templateError('color(part) работает только в ODT.', source);
  }
  if (type === 'border' && scope !== 'shape') {
    throw templateError('color(' + scope + ', border): рамка (border) задаётся только для фигур — color(shape, border).', source);
  }
  if (_formats[scope] === undefined) {
    throw templateError('color(' + scope + ') не поддерживается в ' + formatName(extension) + '. Доступно: ' + Object.keys(_formats).join(', ') + '.', source);
  }
  if (_formats[scope].indexOf(type) === -1) {
    throw templateError('color(' + scope + ', ' + type + ') не поддерживается в ' + formatName(extension) + '. Для ' + scope + ' доступно: '
      + _formats[scope].join(', ') + '.', source);
  }
}

/**
 * Проверить и переписать метки с color. Вызывается в buildXML перед сборкой.
 * @param  {Array}  markers    метки сборки (name меняется, исходное имя сохраняется в source)
 * @param  {String} extension  формат шаблона (options.extension)
 * @return {Array|null}        записи { scope, type, source } по номерам или null — в метках нет color
 */
function prepare (markers, extension) {
  var _registry = null;
  var _ext = typeof extension === 'string' ? extension.toLowerCase() : '';
  for (var i = 0; i < markers.length; i++) {
    var _marker = markers[i];
    if (/:\s*color\b/.test(_marker.name) === false) {
      continue;
    }
    var _chain = splitChain(_marker.name);
    var _changed = false;
    for (var j = 1; j < _chain.length; j++) {
      var _str = _chain[j].trim();
      var _open = _str.indexOf('(');
      var _name = (_open === -1 ? _str : _str.slice(0, _open)).trim();
      if (_name !== 'color') {
        continue;
      }
      var _source = '{' + (_marker.source || _marker.name).replace(/^_root\./, '') + '}';
      if (j !== _chain.length - 1) {
        throw templateError('color должен быть последним форматтером метки: он ничего не печатает, а задаёт цвет элемента документа.', _source);
      }
      var _inside = _open === -1 ? '' : _str.slice(_open + 1, _str.lastIndexOf(')'));
      var _args = _inside.trim() === '' ? [] : splitArgs(_inside).map(unquote);
      if (_args.length > 2) {
        throw templateError('У color не больше двух аргументов: область и тип, например color(p, text) или color(cell, background).', _source);
      }
      var _scope = _args.length > 0 && _args[0] !== '' ? _args[0] : 'p';
      var _type = _args.length > 1 && _args[1] !== '' ? _args[1] : 'text';
      check(_ext, extension, _scope, _type, _source);
      if (_registry === null) {
        _registry = [];
        _registry.nonce = crypto.randomBytes(6).toString('hex');
      }
      _chain[j] = 'color(k' + _registry.nonce + 'i' + _registry.length + ')';
      _registry.push({ scope : _scope, type : _type, source : _source });
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

/** Цвет из данных: 6 hex-цифр с # или без (регистр любой) → «RRGGBB»; иначе светло-серый 888888 */
function normalize (value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return GRAY;
  }
  var _match = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  return _match === null ? GRAY : _match[1].toUpperCase();
}

/**
 * Красит абзац, ячейку, строку таблицы, фигуру или фрагмент текста (ODT) цветом из данных. Ничего не печатает.
 * Только платная сборка 2.4.0.
 *
 * @version 2.4.0
 * @param {String} d   цвет: 6 hex-цифр с # или без; иначе #888888
 * @param {String} id  внутренний номер метки (переписывается из «color(p, text)» до сборки)
 */
function color (d, id) {
  // без номера (метка не прошла prepare) жетон не печатается
  if (/^k[0-9a-f]{12}i\d+$/.test(String(id)) === false) {
    return '';
  }
  return OPEN + id + 'c' + normalize(d) + CLOSE;
}

// ---------------------------------------------------------------------------------------------------------------
// OOXML: «пожелания» к дочерним элементам — дерево по элементу-якорю, правки строятся одним проходом, чтобы
// несколько меток на одном элементе (последняя побеждает) и вложенные контейнеры не давали пересекающихся правок

var FILL = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];
var A_RPR = ['a:ln'].concat(FILL, ['a:effectLst', 'a:effectDag', 'a:highlight', 'a:uLnTx', 'a:uLn', 'a:uFillTx', 'a:uFill',
  'a:latin', 'a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst']);
var W_RPR = ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo', 'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps',
  'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid',
  'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u',
  'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
  'w:specVanish', 'w:oMath'];

// порядок дочерних элементов по схеме; элементы не из списка считаются стоящими после известных
var ORDER = {
  'w:p'          : ['w:pPr'],
  'w:r'          : ['w:rPr'],
  'w:tc'         : ['w:tcPr'],
  'w:rPr'        : W_RPR,
  'w:pPr'        : ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
    'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
    'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd', 'w:snapToGrid',
    'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection',
    'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange'],
  'w:tcPr'       : ['w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar',
    'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark', 'w:headers', 'w:cellIns', 'w:cellDel', 'w:cellMerge', 'w:tcPrChange'],
  'a:r'          : ['a:rPr', 'a:t'],
  'a:fld'        : ['a:rPr', 'a:pPr', 'a:t'],
  'a:br'         : ['a:rPr'],
  'a:rPr'        : A_RPR,
  'a:endParaRPr' : A_RPR,
  'a:tc'         : ['a:txBody', 'a:tcPr', 'a:extLst'],
  'a:tcPr'       : ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB', 'a:lnTlToBr', 'a:lnBlToTr', 'a:cell3D'].concat(FILL, ['a:headers', 'a:extLst']),
  'p:spPr'       : ['a:xfrm', 'a:custGeom', 'a:prstGeom'].concat(FILL, ['a:ln', 'a:effectLst', 'a:effectDag', 'a:scene3d', 'a:sp3d', 'a:extLst']),
  'a:ln'         : FILL.concat(['a:prstDash', 'a:custDash', 'a:round', 'a:bevel', 'a:miter', 'a:headEnd', 'a:tailEnd', 'a:extLst'])
};

/**
 * Пожелание: у элемента el по пути path (имя или группа взаимозаменяемых имён на каждом шаге) должен быть leaf
 * (готовый XML последнего элемента). Недостающие контейнеры создаются, существующий элемент группы заменяется.
 */
function want (desires, el, path, leaf) {
  var _node = desires.get(el);
  if (_node === undefined) {
    _node = { kids : [] };
    desires.set(el, _node);
  }
  for (var i = 0; i < path.length; i++) {
    var _names = typeof path[i] === 'string' ? [path[i]] : path[i];
    var _kid = null;
    for (var k = 0; k < _node.kids.length; k++) {
      if (_node.kids[k].names[0] === _names[0]) {
        _kid = _node.kids[k];
      }
    }
    if (_kid === null) {
      _kid = { names : _names, kids : [], leaf : null };
      _node.kids.push(_kid);
    }
    if (i === path.length - 1) {
      _kid.leaf = leaf;
    }
    _node = _kid;
  }
}

function orderIndex (parentName, name) {
  var _order = ORDER[parentName] || [];
  var _index = _order.indexOf(name);
  return _index === -1 ? Infinity : _index;
}

function sortedKids (parentName, node) {
  return node.kids.slice().sort(function (a, b) {
    return orderIndex(parentName, a.names[0]) - orderIndex(parentName, b.names[0]);
  });
}

function buildKid (kid) {
  if (kid.leaf !== null) {
    return kid.leaf;
  }
  var _name = kid.names[0];
  return '<' + _name + '>' + sortedKids(_name, kid).map(buildKid).join('') + '</' + _name + '>';
}

/** Правки по пожеланиям node к существующему элементу el */
function desireEdits (xml, el, node, edits) {
  var _tag = startTag(xml, el);
  var _kids = sortedKids(el.name, node);
  if (/\/\s*>$/.test(_tag) === true) {
    // пустой элемент <x/> — пересобираем целиком
    edits.push({ start : el.start, end : el.end, rep : _tag.replace(/\s*\/\s*>$/, '>') + _kids.map(buildKid).join('') + '</' + el.name + '>' });
    return;
  }
  _kids.forEach(function (kid) {
    var _existing = null;
    for (var i = 0; i < el.children.length && _existing === null; i++) {
      if (kid.names.indexOf(el.children[i].name) !== -1) {
        _existing = el.children[i];
      }
    }
    if (_existing !== null) {
      if (kid.leaf !== null) {
        edits.push({ start : _existing.start, end : _existing.end, rep : kid.leaf });
      }
      else {
        desireEdits(xml, _existing, kid, edits);
      }
      return;
    }
    // вставка перед первым дочерним, который по схеме стоит позже (или неизвестен)
    var _index = orderIndex(el.name, kid.names[0]);
    var _pos = el.closeStart;
    for (var j = 0; j < el.children.length; j++) {
      if (orderIndex(el.name, el.children[j].name) > _index) {
        _pos = el.children[j].start;
        break;
      }
    }
    edits.push({ start : _pos, end : _pos, rep : buildKid(kid) });
  });
}

/** Элементы names внутри el, ближайший владелец (ownerNames) которых — el */
function owned (el, names, ownerNames) {
  return descendants(el, names).filter(function (x) {
    return closest(x.parent, ownerNames) === el;
  });
}

function child (el, name) {
  for (var i = 0; i < el.children.length; i++) {
    if (el.children[i].name === name) {
      return el.children[i];
    }
  }
  return null;
}

// --- DOCX

function wordTarget (scope, node) {
  switch (scope) {
    case 'p': return closest(node, ['w:p']);
    case 'cell': return closest(node, ['w:tc']);
    case 'row': return closest(node, ['w:tr']);
    default: return null;
  }
}

var W_OWNER = { p : 'w:p', cell : 'w:tc', row : 'w:tr' };

function wordApply (xml, target, entry, hex, desires) {
  var _shd = '<w:shd w:val="clear" w:color="auto" w:fill="' + hex + '"/>';
  if (entry.type === 'background') {
    if (entry.scope === 'p') {
      want(desires, target, ['w:pPr', 'w:shd'], _shd);
      return;
    }
    var _cells = entry.scope === 'cell' ? [target] : owned(target, ['w:tc'], ['w:tr']);
    _cells.forEach(function (cell) {
      want(desires, cell, ['w:tcPr', 'w:shd'], _shd);
    });
    return;
  }
  // text: все прогоны (w:rPr создаётся) и знак абзаца в существующем w:pPr
  var _leaf = '<w:color w:val="' + hex + '"/>';
  var _owner = [W_OWNER[entry.scope]];
  owned(target, ['w:r'], _owner).forEach(function (run) {
    if (closest(run.parent, ['w:p']) !== null) {
      want(desires, run, ['w:rPr', 'w:color'], _leaf);
    }
  });
  var _paragraphs = entry.scope === 'p' ? [target] : owned(target, ['w:p'], _owner);
  _paragraphs.forEach(function (p) {
    var _pPr = child(p, 'w:pPr');
    if (_pPr !== null) {
      want(desires, _pPr, ['w:rPr', 'w:color'], _leaf);
    }
  });
}

// --- PPTX

function pptxTarget (scope, node) {
  switch (scope) {
    case 'p': return closest(node, ['a:p']);
    case 'cell': return closest(node, ['a:tc']);
    case 'row': return closest(node, ['a:tr']);
    case 'shape': return closest(node, ['p:sp', 'p:cxnSp']);
    default: return null;
  }
}

var P_OWNER = { p : 'a:p', cell : 'a:tc', row : 'a:tr', shape : 'p:sp' };

function pptxApply (xml, target, entry, hex, desires) {
  var _fill = '<a:solidFill><a:srgbClr val="' + hex + '"/></a:solidFill>';
  if (entry.type === 'background' || entry.type === 'border') {
    if (entry.scope === 'shape') {
      var _spPr = child(target, 'p:spPr');
      if (_spPr !== null) {
        want(desires, _spPr, entry.type === 'border' ? ['a:ln', FILL] : [FILL], _fill);
      }
      return;
    }
    var _cells = entry.scope === 'cell' ? [target] : owned(target, ['a:tc'], ['a:tr']);
    _cells.forEach(function (cell) {
      want(desires, cell, ['a:tcPr', FILL], _fill);
    });
    return;
  }
  // text, highlight: все прогоны (a:rPr создаётся) и свойства конца абзаца
  var _path = entry.type === 'highlight' ? ['a:highlight'] : [FILL];
  var _leaf = entry.type === 'highlight' ? '<a:highlight><a:srgbClr val="' + hex + '"/></a:highlight>' : _fill;
  var _owner = [P_OWNER[entry.scope]];
  owned(target, ['a:r', 'a:fld', 'a:br'], _owner).forEach(function (run) {
    want(desires, run, ['a:rPr'].concat([_path[0]]), _leaf);
  });
  owned(target, ['a:endParaRPr'], _owner).forEach(function (end) {
    want(desires, end, _path, _leaf);
  });
}

// --- ODT / ODP

function odfTarget (scope, node) {
  switch (scope) {
    case 'p': return closest(node, ['text:p', 'text:h']);
    case 'cell': return closest(node, ['table:table-cell']);
    case 'row': return closest(node, ['table:table-row']);
    case 'shape': return closest(node, ODF_SHAPES);
    case 'part': return closest(node, ['text:span']);
    default: return null;
  }
}

var O_OWNER = { p : ['text:p', 'text:h'], cell : ['table:table-cell'], row : ['table:table-row'], shape : ODF_SHAPES };

/** Атрибут стиля и семейство элемента ODF */
function odfStyleOf (xml, el) {
  switch (el.name) {
    case 'text:p':
    case 'text:h':
      return { attr : 'text:style-name', family : 'paragraph' };
    case 'text:span':
      return { attr : 'text:style-name', family : 'text' };
    case 'table:table-cell':
      return { attr : 'table:style-name', family : 'table-cell' };
    default:
      // фигура: заполнитель презентации — стиль семейства presentation, прочие — graphic
      if (attr(xml, el, 'presentation:style-name') !== null && attr(xml, el, 'draw:style-name') === null) {
        return { attr : 'presentation:style-name', family : 'presentation' };
      }
      return { attr : 'draw:style-name', family : 'graphic' };
  }
}

/** Пожелание свойства стиля элемента: props[свойства][атрибут] = значение */
function odfWant (xml, styled, el, propsName, values) {
  var _entry = styled.get(el);
  if (_entry === undefined) {
    _entry = { style : odfStyleOf(xml, el), props : {} };
    styled.set(el, _entry);
  }
  var _props = _entry.props[propsName] || (_entry.props[propsName] = {});
  for (var _name in values) {
    _props[_name] = values[_name];
  }
}

function odfApply (xml, ext, target, entry, hex, styled) {
  var _color = '#' + hex.toLowerCase();
  var _textProp = entry.type === 'highlight' ? 'fo:background-color' : 'fo:color';
  var _text = {};
  _text[_textProp] = _color;
  if (entry.scope === 'part') {
    odfWant(xml, styled, target, 'style:text-properties', _text);
    return;
  }
  if (entry.type === 'background') {
    if (entry.scope === 'p') {
      odfWant(xml, styled, target, 'style:paragraph-properties', { 'fo:background-color' : _color });
      return;
    }
    if (entry.scope === 'shape') {
      odfWant(xml, styled, target, 'style:graphic-properties', { 'draw:fill' : 'solid', 'draw:fill-color' : _color });
      return;
    }
    var _cells = entry.scope === 'cell' ? [target] : owned(target, ['table:table-cell'], ['table:table-row']);
    _cells.forEach(function (cell) {
      // ячейка таблицы презентации заливается как фигура
      if (ext === 'odp') {
        odfWant(xml, styled, cell, 'style:graphic-properties', { 'draw:fill' : 'solid', 'draw:fill-color' : _color });
      }
      else {
        odfWant(xml, styled, cell, 'style:table-cell-properties', { 'fo:background-color' : _color });
      }
    });
    return;
  }
  // text, highlight: стиль абзацев и фрагментов текста со своим стилем (их свойства перекрыли бы цвет абзаца)
  var _paragraphs = entry.scope === 'p' ? [target] : owned(target, ['text:p', 'text:h'], O_OWNER[entry.scope]);
  _paragraphs.forEach(function (p) {
    odfWant(xml, styled, p, 'style:text-properties', _text);
    owned(p, ['text:span'], ['text:p', 'text:h']).forEach(function (span) {
      if (attr(xml, span, 'text:style-name') !== null) {
        odfWant(xml, styled, span, 'style:text-properties', _text);
      }
    });
  });
}

var STYLE_PROPS = ['style:graphic-properties', 'style:table-cell-properties', 'style:paragraph-properties', 'style:text-properties'];

function propsOrder (name) {
  var _index = STYLE_PROPS.indexOf(name);
  return _index === -1 ? Infinity : _index;
}

function propsTag (name, values) {
  return '<' + name + Object.keys(values).map(function (key) {
    return ' ' + key + '="' + values[key] + '"';
  }).join('') + '/>';
}

/** XML нового автоматического стиля name по исходному (автоматический стиль файла копируется) */
function buildStyle (xml, name, family, base, auto, props) {
  var _propNames = Object.keys(props).sort(function (a, b) {
    return propsOrder(a) - propsOrder(b);
  });
  if (auto === null) {
    return '<style:style style:name="' + name + '" style:family="' + family + '"' + (base !== null ? ' style:parent-style-name="' + base + '"' : '') + '>'
      + _propNames.map(function (p) {
        return propsTag(p, props[p]);
      }).join('') + '</style:style>';
  }
  var _offset = auto.start;
  var _src = xml.slice(auto.start, auto.end);
  var _tag = startTag(xml, auto);
  var _newTag = putAttr(_tag, 'style:name', name);
  if (/\/\s*>$/.test(_tag) === true) {
    return _newTag.replace(/\s*\/\s*>$/, '>') + _propNames.map(function (p) {
      return propsTag(p, props[p]);
    }).join('') + '</style:style>';
  }
  var _edits = [{ start : 0, end : _tag.length, rep : _newTag }];
  _propNames.forEach(function (p) {
    var _existing = child(auto, p);
    if (_existing !== null) {
      var _ptag = startTag(xml, _existing);
      for (var _key in props[p]) {
        _ptag = putAttr(_ptag, _key, props[p][_key]);
      }
      _edits.push({ start : _existing.start - _offset, end : _existing.openEnd - _offset, rep : _ptag });
      return;
    }
    var _pos = auto.closeStart;
    for (var j = 0; j < auto.children.length; j++) {
      if (propsOrder(auto.children[j].name) > propsOrder(p)) {
        _pos = auto.children[j].start;
        break;
      }
    }
    _edits.push({ start : _pos - _offset, end : _pos - _offset, rep : propsTag(p, props[p]) });
  });
  return xmltree.applyEdits(_src, _edits);
}

/** Свойства стиля строкой с упорядоченными ключами — ключ дедупликации */
function serialize (props) {
  return Object.keys(props).sort().map(function (p) {
    return p + '{' + Object.keys(props[p]).sort().map(function (k) {
      return k + '=' + props[p][k];
    }).join(';') + '}';
  }).join('');
}

/** Создать стили CRc<n> и правки элементов; стили — в office:automatic-styles файла */
function odfStyles (xml, root, styled, edits) {
  if (styled.size === 0) {
    return;
  }
  var _doc = null;
  for (var i = 0; i < root.children.length && _doc === null; i++) {
    _doc = root.children[i];
  }
  var _autoStyles = _doc === null ? null : child(_doc, 'office:automatic-styles');
  // автоматические стили файла по семейству и имени
  var _autoByName = new Map();
  if (_autoStyles !== null) {
    _autoStyles.children.forEach(function (s) {
      if (s.name === 'style:style') {
        _autoByName.set(attr(xml, s, 'style:family') + '\u0000' + attr(xml, s, 'style:name'), s);
      }
    });
  }
  var _used = new Set();
  xml.replace(/\sstyle:name\s*=\s*"(CRc\d+)"/g, function (all, name) {
    _used.add(name);
    return all;
  });
  var _counter = 0;
  var _cache = new Map();
  var _out = '';
  styled.forEach(function (entry, el) {
    var _base = attr(xml, el, entry.style.attr);
    var _auto = _base === null ? null : (_autoByName.get(entry.style.family + '\u0000' + _base) || null);
    var _key = entry.style.family + '\u0000' + (_base === null ? '' : _base) + '\u0000' + serialize(entry.props);
    var _name = _cache.get(_key);
    if (_name === undefined) {
      do {
        _counter++;
        _name = 'CRc' + _counter;
      } while (_used.has(_name) === true);
      _cache.set(_key, _name);
      // родитель — исходный общий стиль; у копии автоматического стиля — его родитель (атрибут копируется)
      _out += buildStyle(xml, _name, entry.style.family, _base, _auto, entry.props);
    }
    edits.push({ start : el.start, end : el.openEnd, rep : putAttr(startTag(xml, el), entry.style.attr, _name) });
  });
  if (_autoStyles !== null) {
    if (_autoStyles.openEnd === _autoStyles.end && /\/\s*>$/.test(startTag(xml, _autoStyles)) === true) {
      edits.push({ start : _autoStyles.start, end : _autoStyles.end, rep : startTag(xml, _autoStyles).replace(/\s*\/\s*>$/, '>') + _out + '</office:automatic-styles>' });
    }
    else {
      edits.push({ start : _autoStyles.closeStart, end : _autoStyles.closeStart, rep : _out });
    }
    return;
  }
  // нет office:automatic-styles — создаём перед телом (content.xml) или макетами страниц (styles.xml)
  var _pos = _doc === null ? 0 : _doc.openEnd;
  if (_doc !== null) {
    var _before = child(_doc, 'office:body') || child(_doc, 'office:master-styles');
    if (_before !== null) {
      _pos = _before.start;
    }
  }
  edits.push({ start : _pos, end : _pos, rep : '<office:automatic-styles>' + _out + '</office:automatic-styles>' });
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Обработать жетоны color в собранном XML файла
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
  var _parsed = xmltree.parse(xml, TOKEN_REGEX, function (match) {
    var _id = parseInt(match[2], 10);
    if (match[1] !== registry.nonce || registry[_id] === undefined) {
      return null;
    }
    return { id : _id, hex : match[3] };
  });
  var _edits = [];
  var _desires = new Map();
  var _styled = new Map();
  _parsed.tokens.forEach(function (token) {
    var _entry = registry[token.id];
    _edits.push({ start : token.pos, end : token.pos + token.len, rep : '' });
    var _target = null;
    if (_ext === 'docx') {
      _target = wordTarget(_entry.scope, token.el);
    }
    else if (_ext === 'pptx') {
      _target = pptxTarget(_entry.scope, token.el);
    }
    else if (_ext === 'odt' || _ext === 'odp') {
      _target = odfTarget(_entry.scope, token.el);
    }
    if (_target === null) {
      throw templateError('Для color(' + _entry.scope + ') метка должна стоять ' + WHERE[_entry.scope] + '.', _entry.source);
    }
    if (_ext === 'docx') {
      wordApply(xml, _target, _entry, token.hex, _desires);
    }
    else if (_ext === 'pptx') {
      pptxApply(xml, _target, _entry, token.hex, _desires);
    }
    else {
      odfApply(xml, _ext, _target, _entry, token.hex, _styled);
    }
  });
  _desires.forEach(function (node, el) {
    desireEdits(xml, el, node, _edits);
  });
  odfStyles(xml, _parsed.root, _styled, _edits);
  return xmltree.applyEdits(xml, _edits);
}

module.exports = {
  prepare,
  apply,
  normalize,
  formatters : { color },
  SUPPORTED
};
