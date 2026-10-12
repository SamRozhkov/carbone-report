// :html (2.5.0, спецификация §34.3–34.4): стили ODT для lib/html-odt.js. Своя реализация (чистая комната) по открытой
// документации carbone.io и ODF 1.2.
//   - parts(template) — общие для отчёта стили styles.xml (office:styles): поиск стилей метки и стили заголовков,
//     создаваемые при отсутствии (styles.xml создаётся вместе с записью в manifest.xml, если его нет); save() — после
//     всех частей отчёта (styles.xml переписывается и как часть с колонтитулами);
//   - create(job) — автоматические стили части (ctx.odfStyles): CRh<n> (текст), CRhp<n> (абзац; автоматический стиль
//     метки родителем быть не может — его свойства копируются вместе с его родителем), style:font-face Courier New;
//     save(xml) пишет их в office:automatic-styles и office:font-face-decls части (элементы создаются при отсутствии).

var xmltree = require('./xmltree');
var common = require('./html-xml');
var formats = require('./media-formats');

var PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';

var NAMESPACES = {
  office : 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style  : 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text   : 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  fo     : 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg    : 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0'
};

// кегль созданного стиля заголовка (pt) по уровню 1…6
var HEADING_SIZES = [20, 16, 14, 13, 12, 11];
var COURIER = 'Courier New';
var COURIER_FACE = '<style:font-face style:name="Courier New" svg:font-family="\'Courier New\'" style:font-family-generic="modern" style:font-pitch="fixed"/>';
// длины ODF в см
var CM_PER_UNIT = { cm : 1, mm : 0.1, in : 2.54, pt : 2.54 / 72, pc : 2.54 / 6, px : 2.54 / 96 };

/** Атрибуты [[имя, значение]] → ' имя="значение"…' (значения уже экранированы) */
function attrsXml (props) {
  return props.map(function (prop) {
    return ' ' + prop[0] + '="' + prop[1] + '"';
  }).join('');
}

/** Имена атрибутов открывающего тега */
function attrNames (tag) {
  var _names = [];
  tag.replace(/\s([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, function (all, name) {
    _names.push(name);
    return all;
  });
  return _names;
}

function childNamed (el, name) {
  for (var i = 0; i < el.children.length; i++) {
    if (el.children[i].name === name) {
      return el.children[i];
    }
  }
  return null;
}

/** Длина ODF в см или null (проценты и неизвестные единицы) */
function lengthCm (value) {
  var _match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(cm|mm|in|pt|pc|px)\s*$/.exec(value || '');
  return _match === null ? null : parseFloat(_match[1]) * CM_PER_UNIT[_match[2]];
}

function formatCm (cm) {
  return String(Math.round(cm * 1000) / 1000) + 'cm';
}

/** Стили style:style элемента-контейнера (office:styles, office:automatic-styles) → Map 'семейство|имя' → { src, el } */
function indexStyles (src, container, map) {
  if (container === null) {
    return;
  }
  container.children.forEach(function (el) {
    if (el.name === 'style:style') {
      map.set(xmltree.attr(src, el, 'style:family') + '|' + xmltree.attr(src, el, 'style:name'), { src : src, el : el });
    }
  });
}

/** Элемент верхнего уровня части (office:document-content / office:document-styles) */
function topOf (root) {
  return root.children.length > 0 ? root.children[0] : null;
}

/**
 * Вставить xml в конец элемента name верхнего уровня (или создать элемент после последнего из after; без них —
 * сразу после открывающего тега корня) — правка { start, end, rep } или null
 */
function appendEdit (src, top, name, xml, after) {
  var _el = childNamed(top, name);
  if (_el !== null && _el.openEnd === _el.end) {
    // <office:automatic-styles/>
    return { start : _el.start, end : _el.end, rep : src.slice(_el.start, _el.end).replace(/\s*\/>$/, '>') + xml + '</' + name + '>' };
  }
  if (_el !== null) {
    return { start : _el.closeStart, end : _el.closeStart, rep : xml };
  }
  var _at = top.openEnd;
  top.children.forEach(function (child) {
    if (after.indexOf(child.name) !== -1) {
      _at = child.end;
    }
  });
  return { start : _at, end : _at, rep : '<' + name + '>' + xml + '</' + name + '>' };
}

// ---------------------------------------------------------------------------------------------------------------
// Общие части отчёта: стили styles.xml (office:styles)

/**
 * Общие стили отчёта (styles.xml): поиск (оформление метки, отступы) и стили заголовков, создаваемые при отсутствии.
 * Изменения записываются одним save() после всех частей отчёта (styles.xml может переписываться и как часть с
 * колонтитулами)
 * @param  {Object} template  собранный шаблон { files }
 * @return {Object}           { common(name, family) → { src, el } | null, heading(name, level, display) → name, save() }
 */
function parts (template) {
  var _index = null;
  var _pending = [];
  var _created = new Set();
  var _load = function () {
    if (_index === null) {
      _index = new Map();
      var _file = formats.topFile(template, 'styles.xml');
      if (_file !== undefined && typeof _file.data === 'string') {
        var _top = topOf(xmltree.parse(_file.data).root);
        if (_top !== null) {
          indexStyles(_file.data, childNamed(_top, 'office:styles'), _index);
        }
      }
    }
    return _index;
  };
  return {
    common : function (name, family) {
      var _found = _load().get(family + '|' + name);
      return _found === undefined ? null : _found;
    },
    heading : function (name, level, display) {
      if (_load().has('paragraph|' + name) === false && _created.has(name) === false) {
        _created.add(name);
        _pending.push('<style:style style:name="' + name + '"' + (display ? ' style:display-name="' + display + '"' : '')
          + ' style:family="paragraph" style:default-outline-level="' + level + '"><style:text-properties fo:font-size="'
          + HEADING_SIZES[level - 1] + 'pt" fo:font-weight="bold"/></style:style>');
      }
      return name;
    },
    save : function () {
      if (_pending.length === 0) {
        return;
      }
      var _xml = _pending.join('');
      var _file = formats.topFile(template, 'styles.xml');
      if (_file === undefined) {
        createStyles(template, _xml);
        return;
      }
      var _root = xmltree.parse(_file.data).root;
      var _top = topOf(_root);
      if (_top === null) {
        return;
      }
      var _data = xmltree.applyEdits(_file.data, [appendEdit(_file.data, _top, 'office:styles', _xml, ['office:font-face-decls'])]);
      _file.data = common.declareNs(_data, _root, { style : true, fo : true }, NAMESPACES);
    }
  };
}

/** styles.xml для пакета без него: office:styles с xml, запись в manifest.xml; версия ODF — как у content.xml */
function createStyles (template, xml) {
  var _content = formats.topFile(template, 'content.xml');
  var _version = _content !== undefined ? /<office:document-content\b[^>]*?\soffice:version\s*=\s*["']([^"']*)["']/.exec(_content.data) : null;
  var _ns = ['office', 'style', 'text', 'fo', 'svg'].map(function (prefix) {
    return ' xmlns:' + prefix + '="' + NAMESPACES[prefix] + '"';
  }).join('');
  formats.addFile(template, {
    name     : 'styles.xml',
    data     : PROLOG + '<office:document-styles' + _ns + (_version !== null ? ' office:version="' + _version[1] + '"' : '') + '><office:styles>' + xml + '</office:styles></office:document-styles>',
    isMarked : false,
    parent   : ''
  });
  var _manifest = formats.topFile(template, 'META-INF/manifest.xml');
  var _close = _manifest !== undefined ? _manifest.data.lastIndexOf('</manifest:manifest>') : -1;
  if (_close !== -1 && /manifest:full-path\s*=\s*["']styles\.xml["']/.test(_manifest.data) === false) {
    _manifest.data = _manifest.data.slice(0, _close) + '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' + _manifest.data.slice(_close);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Автоматические стили части (ctx.odfStyles)

/**
 * Автоматические стили части: CRh<n> (текст), CRhp<n> (абзац); одинаковые наборы свойств — один стиль; номера —
 * выше уже занятых в части. Свойства — массив [[атрибут, значение]] (значение экранировано)
 * @return {Object} { text(props) → имя | null, paragraph(base, props) → имя | base, font(), chain(name, family),
 *                   automatic(name, family), save(xml) → xml }
 */
function createOdfStyles (job) {
  var _max = {};
  job.xml.replace(/style:name\s*=\s*["'](CRh[a-z]?)(\d+)["']/g, function (all, prefix, n) {
    _max[prefix] = Math.max(_max[prefix] || 0, parseInt(n, 10));
    return all;
  });
  var _next = function (prefix) {
    _max[prefix] = (_max[prefix] || 0) + 1;
    return prefix + _max[prefix];
  };
  var _top = topOf(job.root);
  var _auto = new Map();
  if (_top !== null) {
    indexStyles(job.xml, childNamed(_top, 'office:automatic-styles'), _auto);
  }
  var _cache = new Map();
  var _added = [];
  // Courier New: null — не нужен, true — дописать, false — уже есть
  var _font = null;
  var _api = {
    automatic : function (name, family) {
      var _found = _auto.get(family + '|' + name);
      return _found === undefined ? null : _found;
    },
    /** Стиль и его родители: автоматический этой части или общий из styles.xml, далее — родители (общие) */
    chain : function (name, family) {
      var _list = [];
      var _entry = name !== null ? _api.automatic(name, family) : null;
      var _seen = new Set();
      if (_entry === null && name !== null) {
        _entry = job.parts !== null ? job.parts.common(name, family) : null;
      }
      while (_entry !== null && _seen.has(_entry.el) === false && _list.length < 32) {
        _seen.add(_entry.el);
        _list.push(_entry);
        var _parent = xmltree.attr(_entry.src, _entry.el, 'style:parent-style-name');
        _entry = _parent !== null && job.parts !== null ? job.parts.common(_parent, family) : null;
      }
      return _list;
    },
    text : function (props) {
      if (props.length === 0) {
        return null;
      }
      var _attrs = attrsXml(props);
      var _key = 'text' + _attrs;
      if (_cache.has(_key) === false) {
        var _name = _next('CRh');
        _cache.set(_key, _name);
        _added.push('<style:style style:name="' + _name + '" style:family="text"><style:text-properties' + _attrs + '/></style:style>');
      }
      return _cache.get(_key);
    },
    /** Стиль абзаца: base (имя как в XML или null) с изменёнными свойствами абзаца; без свойств — base */
    paragraph : function (base, props) {
      if (props.length === 0) {
        return base;
      }
      var _key = 'paragraph|' + (base === null ? '' : base) + '|' + attrsXml(props);
      if (_cache.has(_key) === false) {
        var _name = _next('CRhp');
        _cache.set(_key, _name);
        var _own = base !== null ? _api.automatic(base, 'paragraph') : null;
        _added.push(_own !== null ? cloneParagraph(_own, _name, props)
          : '<style:style style:name="' + _name + '" style:family="paragraph"' + (base !== null ? ' style:parent-style-name="' + base + '"' : '')
            + '><style:paragraph-properties' + attrsXml(props) + '/></style:style>');
      }
      return _cache.get(_key);
    },
    /** style:font-face Courier New (дописывается, если его нет в части) */
    font : function () {
      if (_font === null) {
        var _decls = _top !== null ? childNamed(_top, 'office:font-face-decls') : null;
        _font = _decls === null || _decls.children.every(function (el) {
          return el.name !== 'style:font-face' || xmltree.attr(job.xml, el, 'style:name') !== COURIER;
        });
      }
    },
    /** Записать новые стили и шрифт в XML части (после переписанных абзацев) */
    save : function (xml) {
      if (_added.length === 0 && _font !== true) {
        return xml;
      }
      var _root = xmltree.parse(xml).root;
      var _newTop = topOf(_root);
      var _edits = [];
      if (_font === true) {
        job.ns.svg = true;
        _edits.push(appendEdit(xml, _newTop, 'office:font-face-decls', COURIER_FACE, ['office:scripts']));
      }
      if (_added.length > 0) {
        _edits.push(appendEdit(xml, _newTop, 'office:automatic-styles', _added.join(''), ['office:scripts', 'office:font-face-decls', 'office:styles']));
      }
      job.ns.style = true;
      job.ns.fo = true;
      return xmltree.applyEdits(xml, _edits);
    }
  };
  return _api;
}

/** Копия автоматического стиля абзаца с именем name и свойствами абзаца props (поверх его собственных) */
function cloneParagraph (entry, name, props) {
  var _src = entry.src;
  var _el = entry.el;
  var _tag = xmltree.setAttr(xmltree.startTag(_src, _el), 'style:name', name);
  if (_el.openEnd === _el.end) {
    return _tag.replace(/\s*\/>$/, '>') + '<style:paragraph-properties' + attrsXml(props) + '/></style:style>';
  }
  var _pp = childNamed(_el, 'style:paragraph-properties');
  if (_pp === null) {
    return _tag + '<style:paragraph-properties' + attrsXml(props) + '/>' + _src.slice(_el.openEnd, _el.end);
  }
  var _ppTag = xmltree.startTag(_src, _pp);
  props.forEach(function (prop) {
    _ppTag = xmltree.putAttr(_ppTag, prop[0], prop[1]);
  });
  return _tag + _src.slice(_el.openEnd, _pp.start) + _ppTag + _src.slice(_pp.openEnd, _el.end);
}

/** Имена свойств текста стиля (style:text-properties) */
function textPropNames (entry) {
  var _tp = childNamed(entry.el, 'style:text-properties');
  return _tp === null ? [] : attrNames(xmltree.startTag(entry.src, _tp));
}

/** Свойство абзаца стиля по цепочке родителей или null */
function paragraphProp (styles, base, name) {
  var _chain = styles.chain(base, 'paragraph');
  for (var i = 0; i < _chain.length; i++) {
    var _pp = childNamed(_chain[i].el, 'style:paragraph-properties');
    var _value = _pp !== null ? xmltree.attr(_chain[i].src, _pp, name) : null;
    if (_value !== null) {
      return _value;
    }
  }
  return null;
}

/** Отступ слева стиля абзаца (по цепочке родителей), см; без него или в процентах — 0 */
function marginCm (styles, base) {
  var _cm = lengthCm(paragraphProp(styles, base, 'fo:margin-left'));
  return _cm !== null ? _cm : 0;
}

module.exports = {
  parts,
  create : createOdfStyles,
  textPropNames,
  marginCm,
  formatCm,
  NAMESPACES,
  COURIER
};
