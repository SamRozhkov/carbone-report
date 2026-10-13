// :html (2.5.0, спецификация §34.3–34.4): общие для записи DOCX (lib/html-docx.js) и ODT (lib/html-odt.js) помощники —
// экранирование текста, жетоны части, проходы по абзацам с жетонами, объявление пространств имён на корне части,
// независимые от формата правила: маркеры и номера уровней списков, символ флажка, размер изображения.

var xmltree = require('./xmltree');

// R6: жетон :html вне текста абзаца (DOCX, ODT, имя отчёта)
var MSG_OUTSIDE = 'html ставится в текст абзаца.';

// символы, недопустимые в XML 1.0, и одиночные суррогаты
var INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// уровни списков (повтор по кругу): маркеры и форматы номеров (как type у ol в HTML: 1, a, i)
var BULLETS = ['•', '◦', '▪'];
var NUMBER_FORMATS = ['1', 'a', 'i'];
// изображение: EMU (914400 на дюйм, 360000 на см) на пиксель при 96 dpi; ширина без width/height — 5 см; наибольшая
// сторона — 22 дюйма (наибольший размер страницы Word)
var EMU_PER_PX = 9525;
var DEFAULT_IMAGE_WIDTH = 1800000;
var MAX_IMAGE_EMU = 20116800;

function templateError (message, source) {
  return new Error(message + ' Source: "' + source + '"');
}

/** Текст для XML: недопустимые символы удаляются, & < > " экранируются */
function escapeText (text) {
  return text.replace(INVALID_XML, function (all) {
    // у одиночного младшего суррогата сохраняется предыдущий символ
    return all.length === 2 ? all[0] : '';
  }).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Символ флажка: ☒ — отмечен, ☐ — нет */
function checkboxSymbol (checked) {
  return checked === true ? '☒' : '☐';
}

/**
 * Размер изображения в EMU: width/height в px (96 dpi); задан один — второй по пропорциям; ни одного — ширина 5 см
 * с пропорциями (неизвестные пропорции — размер изображения 0 — как у квадрата). Больше MAX_IMAGE_EMU по любой
 * стороне — уменьшается с пропорциями; каждая сторона — целое, не меньше 1 EMU
 * @param  {Object} inline  { width, height } — px или null
 * @param  {Object} image   { width, height } — размер изображения в пикселях
 * @return {Object}         { cx, cy }
 */
function imageSize (inline, image) {
  var _ratio = image.width > 0 && image.height > 0 ? image.height / image.width : 1;
  var _cx;
  var _cy;
  if (inline.width !== null && inline.height !== null) {
    _cx = inline.width * EMU_PER_PX;
    _cy = inline.height * EMU_PER_PX;
  }
  else if (inline.width !== null) {
    _cx = inline.width * EMU_PER_PX;
    _cy = _cx * _ratio;
  }
  else if (inline.height !== null) {
    _cy = inline.height * EMU_PER_PX;
    _cx = _cy / _ratio;
  }
  else {
    _cx = DEFAULT_IMAGE_WIDTH;
    _cy = DEFAULT_IMAGE_WIDTH * _ratio;
  }
  var _scale = Math.min(1, MAX_IMAGE_EMU / _cx, MAX_IMAGE_EMU / _cy);
  return { cx : Math.max(1, Math.round(_cx * _scale)), cy : Math.max(1, Math.round(_cy * _scale)) };
}

/** Жетоны этого рендера в XML (xmltree.parse: { root, tokens }) */
function parseTokens (xml, job) {
  return xmltree.parse(xml, job.tokenRegex, function (match) {
    var _id = parseInt(match[2], 10);
    return match[1] === job.registry.nonce && job.registry.items[_id] !== undefined ? { id : _id } : null;
  });
}

/**
 * Переписать абзацы части с жетонами. Абзацы внутри других абзацев с жетонами (надпись в абзаце) — раньше внешних:
 * внешний абзац уходит в следующий проход (абзацы с вложенными отмечаются подъёмом по предкам — линейно по числу
 * абзацев и глубине)
 * @param  {Object}   job             { xml, tokens, … }
 * @param  {Function} paragraphOf     paragraphOf(token, job) → элемент абзаца жетона (или ошибка шаблона R6)
 * @param  {Function} writeParagraph  writeParagraph(xmlАбзаца, job) → XML на его месте
 * @return {String}                   новый XML части
 */
function rewriteParagraphs (job, paragraphOf, writeParagraph) {
  var _xml = job.xml;
  var _tokens = job.tokens;
  for (;;) {
    var _groups = new Set();
    _tokens.forEach(function (token) {
      _groups.add(paragraphOf(token, job));
    });
    if (_groups.size === 0) {
      return _xml;
    }
    var _outer = new Set();
    _groups.forEach(function (p) {
      for (var _el = p.parent; _el !== null; _el = _el.parent) {
        if (_groups.has(_el) === true) {
          _outer.add(_el);
        }
      }
    });
    var _edits = [];
    _groups.forEach(function (p) {
      if (_outer.has(p) === false) {
        _edits.push({ start : p.start, end : p.end, rep : writeParagraph(_xml.slice(p.start, p.end), job) });
      }
    });
    _xml = xmltree.applyEdits(_xml, _edits);
    if (_outer.size === 0) {
      return _xml;
    }
    _tokens = parseTokens(_xml, job).tokens;
  }
}

/**
 * Окно абзаца с жетонами — линейная обработка многих жетонов в одном абзаце. writeParagraph (DOCX, ODT) переписывает
 * жетоны по одному слева направо, и каждый шаг разбирает свой XML абзаца; раньше это был весь остаток абзаца
 * (квадратично от числа жетонов). Окно — тот же абзац, в котором:
 *   - обработанное слева от места разреза свёрнуто в заглушки: на каждом уровне открытых элементов содержимое до
 *     разреза заменено комментарием-меткой и минимальным XML с теми же свойствами, что видят следующие шаги
 *     (пустота части, последний символ, rPr — см. stub у писателей); открывающие теги открытых элементов — как есть;
 *   - справа исходный XML абзаца — только до первого символа следующего жетона включительно, открытые там элементы
 *     закрыты: шаг видит ровно один жетон, а все проверки «пусто ли после жетона» — то же, что в целом абзаце
 *     (символ следующего жетона — непустой текст).
 * Поэтому каждый шаг даёт тот же XML, что на целом абзаце, только со свёрнутыми заглушками; expand в конце
 * разворачивает их (каждую один раз).
 * @param  {String}   pXml          XML ровно одного абзаца
 * @param  {Object}   job
 * @param  {Function} contentStart  contentStart(xml, p) → начало содержимого абзаца (после свойств абзаца)
 * @param  {Function} stub          stub(содержимое, элемент) → XML заглушки без комментария-метки (содержимое не пустое)
 * @return {Object}                 { xml — окно с первым жетоном, advance(xml, cutAt), closer(тег), expand(xml) }
 */
function paragraphWindow (pXml, job, contentStart, stub) {
  var _parsed = parseTokens(pXml, job);
  var _p = _parsed.root.children[0];
  var _tokens = _parsed.tokens;
  var _stubs = [];
  var _label = '<!--crhtml:' + job.registry.nonce + ':';
  var _labelRegex = new RegExp(_label + '(\\d+)-->', 'g');
  var _closer = pXml.slice(_p.closeStart);
  // окно содержит жетон _next - 1 целиком и первый символ жетона _next; исходный XML — до _limit, затем _closers
  var _next = 0;
  var _limit = 0;
  var _closers = '';

  // закрывающие теги элементов абзаца, открытых на первом символе жетона k (изнутри наружу)
  var _closersAt = function (k) {
    var _tags = '';
    if (k < _tokens.length) {
      for (var _el = _tokens[k].el; _el !== _p; _el = _el.parent) {
        _tags += '</' + _el.name + '>';
      }
    }
    return _tags;
  };

  var _extend = function (xml) {
    var _suffix = _closers + _closer;
    if (xml.slice(xml.length - _suffix.length) !== _suffix) {
      throw new Error('html: нарушен хвост окна абзаца');
    }
    _next++;
    var _to = _next < _tokens.length ? _tokens[_next].pos + 1 : _p.closeStart;
    var _tags = _closersAt(_next);
    var _xml = xml.slice(0, xml.length - _suffix.length) + pXml.slice(_limit, _to) + _tags + _closer;
    _limit = _to;
    _closers = _tags;
    return _xml;
  };

  var _stubOf = function (content, el) {
    if (content === '') {
      return '';
    }
    var _text = _label + _stubs.length + '-->' + stub(content, el);
    _stubs.push({ text : _text, content : content });
    return _text;
  };

  // элемент среди детей el, внутри содержимого которого стоит pos (пустой элемент <x/> — не контейнер)
  var _childAt = function (el, pos) {
    for (var i = 0; i < el.children.length; i++) {
      var _child = el.children[i];
      if (_child.openEnd <= pos && pos <= _child.closeStart && _child.closeStart < _child.end) {
        return _child;
      }
    }
    return null;
  };

  // свернуть содержимое окна левее cutAt (на каждом уровне открытых там элементов)
  var _compact = function (xml, cutAt) {
    var _el = xmltree.parse(xml).root.children[0];
    var _from = contentStart(xml, _el);
    var _out = xml.slice(0, _from);
    for (;;) {
      var _child = _childAt(_el, cutAt);
      _out += _stubOf(xml.slice(_from, _child !== null ? _child.start : cutAt), _el);
      if (_child === null) {
        return _out + xml.slice(cutAt);
      }
      _out += xml.slice(_child.start, _child.openEnd);
      _el = _child;
      _from = _child.openEnd;
    }
  };

  return {
    xml : _extend(_closer),

    /**
     * Следующий шаг: xml — окно после обработки жетона, cutAt — место разреза в нём (всё левее обработано) или null
     * (сворачивать нечего)
     */
    advance : function (xml, cutAt) {
      return _extend(cutAt !== null ? _compact(xml, cutAt) : xml);
    },

    /** Закрывающий тег абзаца окна сменился (после разделения абзаца — копия) */
    closer : function (tag) {
      _closer = tag;
    },

    /** Развернуть заглушки (вложенные — тоже) */
    expand : function (xml) {
      var _out = [];
      var _stack = [{ xml : xml, pos : 0 }];
      while (_stack.length > 0) {
        var _top = _stack[_stack.length - 1];
        _labelRegex.lastIndex = _top.pos;
        var _match = _labelRegex.exec(_top.xml);
        if (_match === null) {
          _out.push(_top.xml.slice(_top.pos));
          _stack.pop();
          continue;
        }
        var _stub = _stubs[parseInt(_match[1], 10)];
        if (_stub === undefined || _top.xml.startsWith(_stub.text, _match.index) === false) {
          throw new Error('html: заглушка окна абзаца изменена');
        }
        _out.push(_top.xml.slice(_top.pos, _match.index));
        _top.pos = _match.index + _stub.text.length;
        _stack.push({ xml : _stub.content, pos : 0 });
      }
      return _out.join('');
    }
  };
}

/**
 * Объявить на корне части пространства имён used (префикс → true), если их там нет. Открывающий тег корня берётся
 * по дереву root: правки части не должны сдвигать его (они идут после него)
 * @param  {String} xml
 * @param  {Object} root        дерево xmltree.parse (корень — первый элемент)
 * @param  {Object} used        { префикс : true }
 * @param  {Object} namespaces  { префикс : URI }
 * @return {String}
 */
function declareNs (xml, root, used, namespaces) {
  var _top = root.children.length > 0 ? root.children[0] : null;
  if (_top === null) {
    return xml;
  }
  var _tag = xml.slice(_top.start, _top.openEnd);
  var _new = _tag;
  Object.keys(namespaces).forEach(function (prefix) {
    if (used[prefix] === true && new RegExp('\\sxmlns:' + prefix + '\\s*=').test(_new) === false) {
      _new = xmltree.putAttr(_new, 'xmlns:' + prefix, namespaces[prefix]);
    }
  });
  return _new === _tag ? xml : xml.slice(0, _top.start) + _new + xml.slice(_top.openEnd);
}

module.exports = {
  MSG_OUTSIDE,
  BULLETS,
  NUMBER_FORMATS,
  checkboxSymbol,
  imageSize,
  templateError,
  escapeText,
  parseTokens,
  paragraphWindow,
  rewriteParagraphs,
  declareNs
};
