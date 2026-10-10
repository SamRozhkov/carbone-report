// Разбор XML документа в дерево элементов (позиции в строке) — общий для drop/keep (lib/drop.js), изображений
// (lib/media.js) и следующих модулей 2.4.0. Один проход по тегам, без DOM: элемент — { name, start, openEnd,
// closeStart, end, parent, children, index }, где start…openEnd — открывающий тег, closeStart…end — закрывающий
// (у пустого элемента closeStart = end = openEnd).

var TAG_REGEX = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Разобрать XML и найти в нём жетоны
 * @param  {String}   xml
 * @param  {RegExp}   [tokenRegex]  жетоны (флаг g); без него — только дерево
 * @param  {Function} [accept]      accept(match) → объект жетона или null (чужой жетон пропускается);
 *                                  к объекту добавляются pos, len и el — элемент, внутри которого жетон стоит
 *                                  (жетон в атрибуте, например в замещающем тексте картинки, принадлежит самому элементу)
 * @return {Object} { root, tokens }
 */
function parse (xml, tokenRegex, accept) {
  var _root = { name : '', start : 0, openEnd : 0, closeStart : xml.length, end : xml.length, parent : null, children : [] };
  var _stack = [_root];
  var _tokens = [];
  var _token = null;
  if (tokenRegex instanceof RegExp) {
    tokenRegex.lastIndex = 0;
    _token = tokenRegex.exec(xml);
  }
  var _assign = function (upTo, el) {
    while (_token !== null && _token.index < upTo) {
      var _accepted = typeof accept === 'function' ? accept(_token) : {};
      if (_accepted !== null && _accepted !== undefined) {
        _accepted.pos = _token.index;
        _accepted.len = _token[0].length;
        _accepted.el = el || _stack[_stack.length - 1];
        _tokens.push(_accepted);
      }
      _token = tokenRegex.exec(xml);
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

/** Ближайший предок (или сам элемент) с именем из names, для которого check(el) истинно */
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

/** Все потомки с именем из names по порядку документа */
function descendants (el, names) {
  var _res = [];
  var _walk = function (node) {
    for (var i = 0; i < node.children.length; i++) {
      if (names.indexOf(node.children[i].name) !== -1) {
        _res.push(node.children[i]);
      }
      _walk(node.children[i]);
    }
  };
  _walk(el);
  return _res;
}

function startTag (xml, el) {
  return xml.slice(el.start, el.openEnd);
}

function attrRegex (name) {
  return new RegExp('\\s' + name.replace(/[.:-]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
}

/** Значение атрибута (как в XML, без раскрытия сущностей) или null */
function attr (xml, el, name) {
  var _match = attrRegex(name).exec(startTag(xml, el));
  if (_match === null) {
    return null;
  }
  return _match[1] !== undefined ? _match[1] : _match[2];
}

/** Позиция значения атрибута в xml { start, end } (без кавычек) или null */
function attrRange (xml, el, name) {
  var _match = attrRegex(name).exec(startTag(xml, el));
  if (_match === null) {
    return null;
  }
  var _value = _match[1] !== undefined ? _match[1] : _match[2];
  // значение — перед закрывающей кавычкой в конце совпадения
  var _end = el.start + _match.index + _match[0].length - 1;
  return { start : _end - _value.length, end : _end };
}

/** Заменить значение существующего атрибута в открывающем теге (value уже экранирован для XML) */
function setAttr (tag, name, value) {
  return tag.replace(new RegExp('(\\s' + name.replace(/[.:-]/g, '\\$&') + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\')'), function (all, head) {
    return head + '"' + value + '"';
  });
}

/** Заменить значение атрибута или дописать атрибут в конец открывающего тега */
function putAttr (tag, name, value) {
  if (attrRegex(name).test(tag) === true) {
    return setAttr(tag, name, value);
  }
  return tag.replace(/\s*(\/?)>$/, function (all, slash) {
    return ' ' + name + '="' + value + '"' + slash + '>';
  });
}

/**
 * Применить правки { start, end, rep } к строке. По началу; вставка (start = end) раньше элемента с тем же началом;
 * внешняя правка раньше вложенной; правки внутри уже заменённого участка пропускаются.
 */
function applyEdits (xml, edits) {
  edits.sort(function (a, b) {
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
  for (var i = 0; i < edits.length; i++) {
    var _edit = edits[i];
    if (_edit.start < _cursor) {
      // правка внутри уже удалённого элемента
      continue;
    }
    _out += xml.slice(_cursor, _edit.start) + _edit.rep;
    _cursor = Math.max(_cursor, _edit.end);
  }
  return _out + xml.slice(_cursor);
}

/**
 * Семейство формата: 'w' — DOCX, 'p' — PPTX, 'x' — XLSX, 'odf' — прочие (ODT, ODS, ODP, а также текстовые шаблоны —
 * модули сами проверяют, поддерживают ли они расширение)
 */
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

module.exports = {
  TAG_REGEX,
  parse,
  closest,
  hasDescendant,
  descendants,
  startTag,
  attr,
  attrRange,
  setAttr,
  putAttr,
  applyEdits,
  family
};
