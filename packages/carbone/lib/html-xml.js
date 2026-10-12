// :html (2.5.0, спецификация §34.3): общие для записи DOCX (lib/html-docx.js) и ODT (lib/html-odt.js) помощники —
// экранирование текста, жетоны части, проходы по абзацам с жетонами, объявление пространств имён на корне части.

var xmltree = require('./xmltree');

// R6: жетон :html вне текста абзаца (DOCX, ODT, имя отчёта)
var MSG_OUTSIDE = 'html ставится в текст абзаца.';

// символы, недопустимые в XML 1.0, и одиночные суррогаты
var INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
  templateError,
  escapeText,
  parseTokens,
  rewriteParagraphs,
  declareNs
};
