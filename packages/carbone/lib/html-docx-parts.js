// :html (2.5.0, спецификация §34.4): части пакета DOCX, общие для всех частей одного отчёта (тело, колонтитулы) —
// word/numbering.xml (определения списков) и word/styles.xml (стили заголовков, цитат, таблиц). Своя реализация
// (чистая комната) по открытой документации carbone.io и ECMA-376.
//
// Часть ищется по связи основного документа (word/_rels/document.xml.rels, тип numbering/styles); если связи нет —
// word/numbering.xml (word/styles.xml). Отсутствующая часть создаётся, связь и Override в [Content_Types].xml
// дописываются при отсутствии. Части читаются при первом обращении, изменения записываются одним save() после
// всех частей отчёта (номера w:num не повторяются между телом и колонтитулами).

var path = require('path');
var formats = require('./media-formats');

var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
var REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
var PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

var PARTS = {
  numbering : {
    rel     : REL_BASE + 'numbering',
    type    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    name    : 'numbering.xml',
    root    : 'w:numbering',
    idStart : 'rIdCrNum'
  },
  styles : {
    rel     : REL_BASE + 'styles',
    type    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    name    : 'styles.xml',
    root    : 'w:styles',
    idStart : 'rIdCrSty'
  }
};

// маркеры и форматы номеров по уровням (повтор по кругу), отступ уровня
var BULLETS = ['•', '◦', '▪'];
var NUM_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];
var LEVELS = 9;
var LEVEL_INDENT = 720;
var HANGING = 360;
// кегль созданного стиля заголовка (полупункты) по уровню 1…6
var HEADING_SIZES = [40, 32, 28, 26, 24, 22];
// отступ созданного стиля цитаты (twips) — как один уровень blockquote
var QUOTE_INDENT = 600;
var TABLE_BORDER = ' w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
// ширина текста раздела по умолчанию (twips): A4 (11906) без полей 2 см (1134) с каждой стороны
var DEFAULT_TEXT_WIDTH = 9638;

/** Значение атрибута name в тексте открывающего тега или null */
function attrOf (tag, name) {
  var _match = new RegExp('\\s' + name.replace(/[:]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag);
  return _match === null ? null : (_match[1] !== undefined ? _match[1] : _match[2]);
}

function escapeAttr (value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Вставить xml перед первым совпадением regex в file.data (или перед закрывающим тегом корня) */
function insertBefore (file, regex, root, xml) {
  if (xml === '') {
    return;
  }
  var _match = regex !== null ? regex.exec(file.data) : null;
  var _at = _match !== null ? _match.index : file.data.lastIndexOf('</' + root + '>');
  if (_at !== -1) {
    file.data = file.data.slice(0, _at) + xml + file.data.slice(_at);
    return;
  }
  // пустой корень <w:numbering …/>
  file.data = file.data.replace(new RegExp('<' + root + '([^>]*?)\\s*/>'), '<' + root + '$1>' + xml + '</' + root + '>');
}

/** Имя основного документа по _rels/.rels (officeDocument), иначе word/document.xml */
function mainPart (template) {
  var _rels = formats.topFile(template, '_rels/.rels');
  var _found = null;
  if (_rels !== undefined && typeof _rels.data === 'string') {
    _rels.data.replace(/<Relationship\s[^>]*>/g, function (tag) {
      if (_found === null && /\/officeDocument$/.test(attrOf(tag, 'Type') || '') === true) {
        _found = (attrOf(tag, 'Target') || '').replace(/^\//, '');
      }
      return tag;
    });
  }
  return _found !== null && _found !== '' ? _found : 'word/document.xml';
}

/**
 * Часть пакета по связи основного документа (создаётся при отсутствии вместе со связью и типом)
 * @param  {Boolean} [create]  false — не создавать: нет части — null
 * @return {Object|null} файл шаблона { name, data }
 */
function openPart (template, kind, create) {
  var _def = PARTS[kind];
  var _main = mainPart(template);
  var _dir = path.posix.dirname(_main);
  var _relsName = formats.relsPath(_main);
  var _rels = formats.topFile(template, _relsName);
  var _target = null;
  var _ids = new Set();
  if (_rels !== undefined) {
    _rels.data.replace(/<Relationship\s[^>]*>/g, function (tag) {
      _ids.add(attrOf(tag, 'Id'));
      if (_target === null && attrOf(tag, 'Type') === _def.rel && attrOf(tag, 'TargetMode') !== 'External') {
        _target = attrOf(tag, 'Target');
      }
      return tag;
    });
  }
  var _name = _target === null ? path.posix.join(_dir, _def.name)
    : (_target[0] === '/' ? _target.slice(1) : path.posix.normalize(path.posix.join(_dir, _target)));
  if (create === false && formats.topFile(template, _name) === undefined) {
    return null;
  }
  if (_target === null) {
    if (_rels === undefined) {
      _rels = formats.addFile(template, { name : _relsName, data : PROLOG + '<Relationships xmlns="' + formats.RELS_NS + '"></Relationships>', isMarked : false, parent : '' });
    }
    var _id = _def.idStart;
    for (var i = 2; _ids.has(_id) === true; i++) {
      _id = _def.idStart + i;
    }
    insertBefore(_rels, null, 'Relationships', '<Relationship Id="' + _id + '" Type="' + _def.rel + '" Target="' + escapeAttr(path.posix.relative(_dir, _name)) + '"/>');
  }
  var _types = formats.topFile(template, '[Content_Types].xml');
  if (_types !== undefined && new RegExp('PartName\\s*=\\s*["\']/' + _name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '["\']', 'i').test(_types.data) === false) {
    insertBefore(_types, null, 'Types', '<Override PartName="/' + escapeAttr(_name) + '" ContentType="' + _def.type + '"/>');
  }
  var _file = formats.topFile(template, _name);
  if (_file === undefined) {
    _file = formats.addFile(template, { name : _name, data : PROLOG + '<' + _def.root + ' xmlns:w="' + W_NS + '"></' + _def.root + '>', isMarked : false, parent : '' });
  }
  return _file;
}

// ---------------------------------------------------------------------------------------------------------------
// numbering.xml

function abstractNumXml (id, ordered) {
  var _levels = '';
  for (var i = 0; i < LEVELS; i++) {
    _levels += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + (ordered === true ? NUM_FORMATS[i % 3] : 'bullet') + '"/>'
      + '<w:lvlText w:val="' + (ordered === true ? '%' + (i + 1) + '.' : BULLETS[i % 3]) + '"/><w:lvlJc w:val="left"/>'
      + '<w:pPr><w:ind w:left="' + (LEVEL_INDENT * (i + 1)) + '" w:hanging="' + HANGING + '"/></w:pPr></w:lvl>';
  }
  return '<w:abstractNum w:abstractNumId="' + id + '"><w:multiLevelType w:val="hybridMultilevel"/>' + _levels + '</w:abstractNum>';
}

function numbering (template) {
  var _file = null;
  var _nextAbstract = 0;
  var _nextNum = 1;
  var _abstract = { true : null, false : null };
  var _abstractXml = '';
  var _numXml = '';
  var _open = function () {
    _file = openPart(template, 'numbering');
    _file.data.replace(/<w:(abstractNum|num)\s[^>]*>/g, function (tag, name) {
      var _id = parseInt(attrOf(tag, name === 'num' ? 'w:numId' : 'w:abstractNumId'), 10);
      if (name === 'num' && _id >= _nextNum) {
        _nextNum = _id + 1;
      }
      else if (name === 'abstractNum' && _id >= _nextAbstract) {
        _nextAbstract = _id + 1;
      }
      return tag;
    });
  };
  return {
    /**
     * Новый список: w:num на общем для документа w:abstractNum своего типа
     * @param  {Boolean} ordered  нумерованный (ol) или маркированный (ul)
     * @param  {Number}  [level]  уровень пунктов списка (0…): у нумерованного счёт этого уровня начинается с 1
     * @return {Number}           numId
     */
    add : function (ordered, level) {
      if (_file === null) {
        _open();
      }
      var _ordered = ordered === true;
      if (_abstract[_ordered] === null) {
        _abstract[_ordered] = _nextAbstract++;
        _abstractXml += abstractNumXml(_abstract[_ordered], _ordered);
      }
      var _id = _nextNum++;
      // Word ведёт счёт по abstractNum: без startOverride следующий список продолжил бы номера предыдущего
      var _override = _ordered === true ? '<w:lvlOverride w:ilvl="' + (level || 0) + '"><w:startOverride w:val="1"/></w:lvlOverride>' : '';
      _numXml += '<w:num w:numId="' + _id + '"><w:abstractNumId w:val="' + _abstract[_ordered] + '"/>' + _override + '</w:num>';
      return _id;
    },
    save : function () {
      if (_file === null) {
        return;
      }
      // схема: w:abstractNum — перед всеми w:num, w:num — перед w:numIdMacAtCleanup
      // без w:num якорь — w:numIdMacAtCleanup (иначе abstractNum встал бы после него)
      insertBefore(_file, /<w:(?:num|numIdMacAtCleanup)[\s>/]/, 'w:numbering', _abstractXml);
      insertBefore(_file, /<w:numIdMacAtCleanup[\s>/]/, 'w:numbering', _numXml);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// styles.xml

function headingStyleXml (id, name, level) {
  var _sz = HEADING_SIZES[level - 1];
  return '<w:style w:type="paragraph" w:styleId="' + escapeAttr(id) + '"><w:name w:val="' + escapeAttr(name) + '"/>'
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="' + (level - 1) + '"/></w:pPr>'
    + '<w:rPr><w:b/><w:bCs/><w:sz w:val="' + _sz + '"/><w:szCs w:val="' + _sz + '"/></w:rPr></w:style>';
}

function quoteStyleXml (id) {
  return '<w:style w:type="paragraph" w:styleId="' + escapeAttr(id) + '"><w:name w:val="' + escapeAttr(id) + '"/>'
    + '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="' + QUOTE_INDENT + '"/></w:pPr></w:style>';
}

function tableStyleXml (id) {
  var _borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
    return '<w:' + side + TABLE_BORDER;
  }).join('');
  return '<w:style w:type="table" w:styleId="' + escapeAttr(id) + '"><w:name w:val="' + (id === 'TableGrid' ? 'Table Grid' : escapeAttr(id)) + '"/>'
    + '<w:tblPr><w:tblBorders>' + _borders + '</w:tblBorders></w:tblPr></w:style>';
}

function styles (template) {
  var _file = null;
  var _ids = null;
  var _names = null;
  var _defaultTable = null;
  var _added = '';
  // create false — только прочитать существующую часть (не создавать styles.xml ради поиска стиля)
  var _open = function (create) {
    _file = openPart(template, 'styles', create);
    if (_file === null) {
      return;
    }
    _ids = new Set();
    _names = new Map();
    // самозакрытый w:style — первым, иначе вторая ветка захватила бы его вместе со следующим стилем
    _file.data.replace(/<w:style\s[^>]*\/>|<w:style(?:\s[^>]*)?>([\s\S]*?)<\/w:style>/g, function (all, inner) {
      var _tag = /^<w:style[^>]*>/.exec(all)[0];
      var _id = attrOf(_tag, 'w:styleId');
      if (_id === null) {
        return all;
      }
      _ids.add(_id);
      var _type = attrOf(_tag, 'w:type') || 'paragraph';
      var _name = inner !== undefined ? /<w:name\s[^>]*>/.exec(inner) : null;
      var _nameVal = _name !== null ? attrOf(_name[0], 'w:val') : null;
      if (_nameVal !== null && _names.has(_type + ':' + _nameVal.toLowerCase()) === false) {
        _names.set(_type + ':' + _nameVal.toLowerCase(), _id);
      }
      if (_type === 'table' && _defaultTable === null && /^(1|true|on)$/.test(attrOf(_tag, 'w:default') || '') === true) {
        _defaultTable = _id;
      }
      return all;
    });
  };
  var _ensureOpen = function () {
    if (_file === null) {
      _open(true);
    }
  };
  return {
    /**
     * Стиль styleId есть в styles.xml (добавляется простой, если нет)
     * @param  {String} styleId
     * @param  {String} kind     'heading' | 'quote' | 'table'
     * @param  {Number} [level]  уровень заголовка 1…6
     * @return {String}          styleId для w:pStyle/w:tblStyle (встроенный стиль шаблона может иметь другой id:
     *                           русский Word хранит «heading 1» как styleId «1»)
     */
    ensure : function (styleId, kind, level) {
      _ensureOpen();
      if (_ids.has(styleId) === true) {
        return styleId;
      }
      var _builtin = kind === 'heading' && styleId === 'Heading' + level ? 'heading ' + level
        : (kind === 'table' && styleId === 'TableGrid' ? 'table grid' : null);
      var _type = kind === 'table' ? 'table' : 'paragraph';
      if (_builtin !== null && _names.has(_type + ':' + _builtin) === true) {
        return _names.get(_type + ':' + _builtin);
      }
      if (kind === 'heading') {
        _added += headingStyleXml(styleId, _builtin !== null ? _builtin : styleId, level);
      }
      else if (kind === 'table') {
        _added += tableStyleXml(styleId);
      }
      else {
        _added += quoteStyleXml(styleId);
      }
      _ids.add(styleId);
      return styleId;
    },
    /**
     * Стиль, который уже есть в styles.xml (часть не создаётся): по styleId или по имени
     * @param  {String} styleId
     * @param  {String} type     w:type стиля (paragraph, character, table)
     * @param  {String} name     имя стиля (w:name, без учёта регистра)
     * @return {String|null}     styleId или null
     */
    find : function (styleId, type, name) {
      if (_file === null) {
        _open(false);
      }
      if (_file === null) {
        return null;
      }
      if (_ids.has(styleId) === true) {
        return styleId;
      }
      var _byName = _names.get(type + ':' + name.toLowerCase());
      return _byName !== undefined ? _byName : null;
    },
    /** Стиль таблиц по умолчанию документа (w:default) или null */
    defaultTable : function () {
      _ensureOpen();
      return _defaultTable;
    },
    save : function () {
      if (_file !== null) {
        insertBefore(_file, null, 'w:styles', _added);
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Ширина текста раздела

/** Атрибут name элемента tag (первого) в xml как число или null */
function numberAttr (xml, tag, name) {
  var _match = new RegExp('<' + tag + '\\b[^>]*>').exec(xml);
  if (_match === null) {
    return null;
  }
  var _value = parseInt(attrOf(_match[0], name), 10);
  return Number.isFinite(_value) === true ? _value : null;
}

/**
 * Ширина текста раздела (twips): w:pgSz w:w − w:pgMar w:left − w:right последнего w:sectPr основного документа;
 * без w:pgSz w:w (или при ширине не больше 0) — DEFAULT_TEXT_WIDTH (A4 с полями 2 см)
 */
function textWidth (template) {
  var _file = formats.topFile(template, mainPart(template));
  var _xml = _file !== undefined && typeof _file.data === 'string' ? _file.data : '';
  var _at = _xml.lastIndexOf('<w:sectPr');
  if (_at === -1) {
    return DEFAULT_TEXT_WIDTH;
  }
  var _end = _xml.indexOf('</w:sectPr>', _at);
  var _sect = _xml.slice(_at, _end === -1 ? _xml.length : _end);
  var _page = numberAttr(_sect, 'w:pgSz', 'w:w');
  if (_page === null) {
    return DEFAULT_TEXT_WIDTH;
  }
  var _width = _page - (numberAttr(_sect, 'w:pgMar', 'w:left') || 0) - (numberAttr(_sect, 'w:pgMar', 'w:right') || 0);
  return _width > 0 ? _width : DEFAULT_TEXT_WIDTH;
}

/**
 * Общие части DOCX одного отчёта
 * @param  {Object} template  собранный шаблон { files }
 * @return {Object}           { numbering : { add }, styles : { ensure, find, defaultTable }, textWidth(), save() }
 */
function create (template) {
  var _numbering = numbering(template);
  var _styles = styles(template);
  var _width = null;
  return {
    numbering : _numbering,
    styles    : _styles,
    // ширина текста раздела — один раз на отчёт
    textWidth : function () {
      if (_width === null) {
        _width = textWidth(template);
      }
      return _width;
    },
    save      : function () {
      _numbering.save();
      _styles.save();
    }
  };
}

module.exports = {
  create,
  LEVEL_INDENT,
  HANGING,
  LEVELS,
  HEADING_SIZES
};
