// Изображения из данных Carbone EE — своя реализация (чистая комната) по открытой документации
// (docs/superpowers/notes/2026-10-10-ee-images-barcodes-colors.md, спецификация §32.1).
//
// Картинка-заглушка шаблона с меткой в замещающем тексте («{d.img}» в описании) заменяется изображением из данных.
// Порядок:
//   1. preprocess — до сборки: меткам в замещающем тексте картинки дописывается последний форматтер «:__img»
//      (решение R2); тот же текст в обычном абзаце не меняется;
//   2. prepare — в buildXML перед сборкой: «__img» → «__img(<k>)», «imageFit(x)» → «imageFit(x, <k>)», где k ведёт
//      к метке (для ошибок) в реестре рендера options.__media.sources;
//   3. форматтер __img кладёт значение в реестр options.__media.items и печатает жетон «m<ключ>i<n>» из области
//      частного использования (ключ — случайный на рендер: жетон из данных отчёта не совпадёт с ним);
//   4. finish — после сборки всех файлов (renderBuffer): жетоны группируются по картинке-контейнеру, данные
//      загружаются (loadImage), в контейнере меняются ссылка на файл и размеры, добавляются media-файл, связь и тип
//      в [Content_Types].xml; пустое значение удаляет контейнер. Без жетонов документ не меняется.
//
// Форматы: правила разметки — таблица FORMATS по семействам (xmltree.family), источники данных — LOADERS по виду
// записи реестра (kind).

var crypto = require('crypto');
var path = require('path');
var imageSize = require('image-size').imageSize;
var splitChain = require('./set').splitChain;
var xmltree = require('./xmltree');

var closest = xmltree.closest;
var descendants = xmltree.descendants;
var startTag = xmltree.startTag;
var attr = xmltree.attr;
var setAttr = xmltree.setAttr;
var putAttr = xmltree.putAttr;

// жетон: символы частного использования, отличные от агрегаторов (U+E000/U+E001) и drop/keep (U+E010/U+E011)
var OPEN = '';
var CLOSE = '';
var TOKEN_REGEX = /m([0-9a-f]{12})i(\d+)/g;

var MB = 1024 * 1024;
var MAX_IMAGE = 10 * MB; // одно изображение после декодирования
var MAX_TOTAL = 50 * MB; // все изображения отчёта
var CONCURRENCY = 4; // одновременных загрузок на отчёт (§32.2)

var FITS = ['fillWidth', 'contain', 'fill'];
var DEFAULT_FIT = 'fillWidth';

// тип изображения (по заголовку файла) → расширение и MIME
var TYPES = {
  png  : { ext : 'png', mime : 'image/png' },
  jpeg : { ext : 'jpeg', mime : 'image/jpeg' },
  gif  : { ext : 'gif', mime : 'image/gif' }
};
var DATA_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

var EMU_PER_PX = 9525; // 96 dpi
var EMU_PER_PT = 12700;
var IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
var RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// метки, которые не становятся метками изображения: удаление элемента и условные блоки
var NOT_IMAGE_MARKER = /:\s*(?:__img|drop|keep|showBegin|showEnd|hideBegin|hideEnd)\b/;

var MSG = {
  notImage    : 'значение не изображение (ожидается data URI или адрес http(s))',
  badUri      : 'неверный data URI изображения (ожидается data:image/png;base64,…)',
  svg         : 'SVG не поддерживается (изображения: PNG, JPEG, GIF)',
  corrupt     : 'данные изображения повреждены или это не PNG, JPEG, GIF',
  tooBig      : 'изображение больше 10 МБ',
  tooBigTotal : 'изображения отчёта больше 50 МБ',
  urlDisabled : 'загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST)',
  fitOutside  : 'imageFit ставится в метку изображения — в замещающий текст (название или описание) картинки',
  outside     : 'метка изображения должна стоять в замещающем тексте (названии или описании) картинки'
};

function badType (mime) {
  return 'тип изображения «' + mime + '» не поддерживается (изображения: PNG, JPEG, GIF)';
}

function badFit (mode) {
  return 'imageFit: неизвестный режим «' + mode + '» (fillWidth, contain или fill)';
}

function templateError (message, source) {
  return new Error(message + ' Source: "' + source + '"');
}

function unquote (arg) {
  var _match = /^\s*'([\s\S]*)'\s*$/.exec(arg);
  return _match !== null ? _match[1] : arg.trim();
}

/** Реестр рендера: создаётся в renderBuffer, общий для всех файлов документа */
function createRegistry () {
  return { nonce : crypto.randomBytes(6).toString('hex'), items : [], sources : [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Правила форматов

/** Картинка Word: w:drawing, у которого a:graphicData содержит pic:pic напрямую (не группа, не фигура с картинкой) */
function isWordPicture (drawing) {
  return drawing.children.some(function (frame) {
    return (frame.name === 'wp:inline' || frame.name === 'wp:anchor') && frame.children.some(function (graphic) {
      return graphic.name === 'a:graphic' && graphic.children.some(function (data) {
        return data.name === 'a:graphicData' && data.children.some(function (pic) {
          return pic.name === 'pic:pic';
        });
      });
    });
  });
}

function isAlternateWithPicture (el) {
  return el.children.some(function (choice) {
    return choice.name === 'mc:Choice' && choice.children.some(function (d) {
      return d.name === 'w:drawing' && isWordPicture(d);
    });
  });
}

/**
 * Контейнер картинки Word вокруг элемента: w:drawing с картинкой (или охватывающий mc:AlternateContent вместе с
 * запасным VML), либо старая картинка VML w:pict с v:imagedata; иначе null
 */
function wordContainer (el) {
  var _drawing = closest(el, ['w:drawing'], isWordPicture);
  if (_drawing !== null) {
    var _choice = _drawing.parent;
    if (_choice !== null && _choice.name === 'mc:Choice' && _choice.parent !== null && _choice.parent.name === 'mc:AlternateContent') {
      return _choice.parent;
    }
    return _drawing;
  }
  var _alternate = closest(el, ['mc:AlternateContent'], isAlternateWithPicture);
  if (_alternate !== null) {
    return _alternate;
  }
  return closest(el, ['w:pict'], function (x) {
    return descendants(x, ['v:imagedata']).length > 0;
  });
}

// единицы размеров VML (style="width:72pt;height:36pt") в EMU
var VML_UNITS = { pt : EMU_PER_PT, in : 914400, cm : 360000, mm : 36000, px : EMU_PER_PX };

function vmlSize (style, name) {
  var _match = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([\\d.]+)\\s*(pt|in|cm|mm|px)?\\s*(?:;|$)').exec(style || '');
  if (_match === null) {
    return null;
  }
  var _value = parseFloat(_match[1]) * VML_UNITS[_match[2] || 'px'];
  return _value > 0 ? _value : null;
}

function setVmlSize (style, name, emu) {
  var _pt = String(Math.round(emu / EMU_PER_PT * 100) / 100) + 'pt';
  var _regex = new RegExp('((?:^|;)\\s*' + name + '\\s*:\\s*)[\\d.]+\\s*(?:pt|in|cm|mm|px)?');
  return _regex.test(style) === true ? style.replace(_regex, '$1' + _pt) : style;
}

/**
 * Правки картинки Word под изображение: рамка — первый wp:extent (или размер VML), размеры по imageFit,
 * ссылки a:blip r:embed / v:imagedata r:id — на новую связь
 * @return {Array} [{ el, tag : function (startTag) → startTag }]
 */
function wordPlace (xml, container, image, relId, fit) {
  var _extents = descendants(container, ['wp:extent']);
  var _xfrmExts = descendants(container, ['a:ext']).filter(function (x) {
    return x.parent !== null && x.parent.name === 'a:xfrm';
  });
  var _vmlShapes = descendants(container, ['v:imagedata']).map(function (x) {
    return x.parent;
  }).filter(function (x) {
    return x !== null && attr(xml, x, 'style') !== null;
  });
  var _frame = null;
  if (_extents.length > 0) {
    var _cx = parseInt(attr(xml, _extents[0], 'cx'), 10);
    var _cy = parseInt(attr(xml, _extents[0], 'cy'), 10);
    if (_cx > 0 && _cy > 0) {
      _frame = { cx : _cx, cy : _cy };
    }
  }
  if (_frame === null && _vmlShapes.length > 0) {
    var _style = attr(xml, _vmlShapes[0], 'style');
    var _w = vmlSize(_style, 'width');
    var _h = vmlSize(_style, 'height');
    if (_w !== null && _h !== null) {
      _frame = { cx : _w, cy : _h };
    }
  }
  var _size = fitSize(_frame, image, fit);
  var _edits = [];
  var _setSize = function (tag) {
    return setAttr(setAttr(tag, 'cx', String(_size.cx)), 'cy', String(_size.cy));
  };
  _extents.concat(_xfrmExts).forEach(function (el) {
    _edits.push({ el : el, tag : _setSize });
  });
  descendants(container, ['a:blip']).forEach(function (el) {
    _edits.push({ el : el, tag : function (tag) {
      return putAttr(tag, 'r:embed', relId);
    } });
  });
  descendants(container, ['v:imagedata']).forEach(function (el) {
    _edits.push({ el : el, tag : function (tag) {
      return putAttr(tag, 'r:id', relId);
    } });
  });
  _vmlShapes.forEach(function (el) {
    _edits.push({ el : el, tag : function (tag) {
      var _style = /\sstyle\s*=\s*"([^"]*)"/.exec(tag);
      if (_style === null) {
        return tag;
      }
      return setAttr(tag, 'style', setVmlSize(setVmlSize(_style[1], 'width', _size.cx), 'height', _size.cy));
    } });
  });
  return _edits;
}

/** Позиции замещающего текста (значения атрибутов) у элементов картинок; attrs — { элемент: [атрибуты] } */
function attrAltRanges (attrs, container) {
  return function (xml, root) {
    var _ranges = [];
    var _walk = function (el) {
      for (var i = 0; i < el.children.length; i++) {
        var _child = el.children[i];
        var _names = attrs[_child.name];
        if (_names !== undefined && startTag(xml, _child).indexOf('{') !== -1 && container(_child) !== null) {
          _names.forEach(function (name) {
            var _range = xmltree.attrRange(xml, _child, name);
            if (_range !== null && xml.slice(_range.start, _range.end).indexOf('{') !== -1) {
              _ranges.push(_range);
            }
          });
        }
        _walk(_child);
      }
    };
    _walk(root);
    return _ranges;
  };
}

/**
 * Правила форматов по семействам (xmltree.family). Каждое:
 *   altHint              — быстрая проверка файла до разбора: есть ли метка в замещающем тексте;
 *   altRanges(xml, root) → [{ start, end }] — где метка становится меткой изображения (решение R2);
 *   container(el)        → контейнер картинки вокруг элемента с жетоном или null;
 *   place(xml, container, image, relId, fit) → правки открывающих тегов внутри контейнера;
 *   mediaDir             — папка media-файлов в архиве.
 * Связи и [Content_Types].xml — общие для OOXML (relsPath). ODF (manifest.xml) добавит Task 2.
 */
var WORD_ALT = {
  'wp:docPr'    : ['descr', 'title'],
  'pic:cNvPr'   : ['descr', 'title'],
  'v:shape'     : ['alt', 'o:title'],
  'v:rect'      : ['alt', 'o:title'],
  'v:imagedata' : ['o:title']
};

var FORMATS = {
  w : {
    altHint   : /\s(?:descr|title|alt|o:title)\s*=\s*(?:"[^"]*\{|'[^']*\{)/,
    altRanges : attrAltRanges(WORD_ALT, wordContainer),
    container : wordContainer,
    place     : wordPlace,
    mediaDir  : 'word/media/'
  }
};

// поддержанные расширения шаблона → семейство FORMATS
var FORMAT_OF = {
  docx : 'w'
};

function formatOf (extension) {
  var _fam = FORMAT_OF[typeof extension === 'string' ? extension.toLowerCase() : ''];
  return _fam === undefined ? null : FORMATS[_fam];
}

/** Размер изображения в EMU по рамке заглушки и режиму imageFit */
function fitSize (frame, image, fit) {
  if (frame === null) {
    // рамки нет — исходный размер при 96 dpi
    return { cx : image.width * EMU_PER_PX, cy : image.height * EMU_PER_PX };
  }
  if (fit === 'fill') {
    return { cx : Math.round(frame.cx), cy : Math.round(frame.cy) };
  }
  var _scale = frame.cx / image.width;
  if (fit === 'contain') {
    _scale = Math.min(_scale, frame.cy / image.height);
  }
  return { cx : Math.round(image.width * _scale), cy : Math.round(image.height * _scale) };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. preprocess

/**
 * Дописать «:__img» меткам в замещающем тексте картинок-заглушек файла шаблона (до сборки)
 * @param {Object} file       файл шаблона { name, data, isMarked, parent } (data меняется)
 * @param {String} extension  формат шаблона
 */
function preprocess (file, extension) {
  var _fmt = formatOf(extension);
  if (_fmt === null || file === null || typeof file.data !== 'string' || _fmt.altHint.test(file.data) === false) {
    return;
  }
  var _xml = file.data;
  var _ranges = _fmt.altRanges(_xml, xmltree.parse(_xml).root);
  if (_ranges.length === 0) {
    return;
  }
  file.data = xmltree.applyEdits(_xml, _ranges.map(function (range) {
    return { start : range.start, end : range.end, rep : markImageMarkers(_xml.slice(range.start, range.end)) };
  }));
}

function markImageMarkers (text) {
  return text.replace(/\{(\s*[dc](?=[\s.[:}])[^{}]*)\}/g, function (all, inner) {
    if (NOT_IMAGE_MARKER.test(inner) === true) {
      return all;
    }
    return '{' + inner.replace(/\s+$/, '') + ':__img}';
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 2. prepare

/** Метка для ошибок: как в шаблоне, без служебного __img */
function sourceOf (marker) {
  var _name = (marker.source || marker.name).replace(/^_root\./, '');
  return '{' + _name.replace(/:\s*__img(?:\([^)]*\))?(?=:|$)/g, '') + '}';
}

/**
 * Переписать метки изображений перед сборкой (buildXML): номер метки в реестре для __img и imageFit
 * @param  {Array}  markers  метки сборки (name меняется; исходный текст — в source, без __img)
 * @param  {Object} options  опции рендера (options.__media — реестр; без него — старый render(), метки не меняются)
 */
function prepare (markers, options) {
  var _registry = options !== null && options !== undefined ? options.__media : undefined;
  for (var i = 0; i < markers.length; i++) {
    var _marker = markers[i];
    if (/:\s*(?:__img|imageFit)\b/.test(_marker.name) === false) {
      continue;
    }
    var _chain = splitChain(_marker.name);
    var _names = _chain.map(function (part) {
      return part.trim().split('(')[0].trim();
    });
    var _source = sourceOf(_marker);
    if (_names.indexOf('imageFit', 1) !== -1 && _names.indexOf('__img', 1) === -1) {
      throw templateError(MSG.fitOutside, _source);
    }
    if (_registry === undefined || _names.indexOf('__img', 1) === -1) {
      continue;
    }
    var _k = _registry.sources.length;
    _registry.sources.push(_source);
    for (var j = 1; j < _chain.length; j++) {
      if (_names[j] === '__img') {
        _chain[j] = '__img(' + _k + ')';
      }
      else if (_names[j] === 'imageFit') {
        var _str = _chain[j].trim();
        var _open = _str.indexOf('(');
        var _arg = _open === -1 ? '' : _str.slice(_open + 1, _str.lastIndexOf(')'));
        var _mode = unquote(_arg);
        // литерал проверяется сразу; путь (.fit, d.fit, c.fit) — при сборке
        if (/^(?:\.|[dc]\.)/.test(_mode) === false && FITS.indexOf(_mode) === -1) {
          throw templateError(badFit(_mode), _source);
        }
        _chain[j] = 'imageFit(' + _arg.trim() + ', ' + _k + ')';
      }
    }
    _marker.source = _source.slice(1, -1);
    _marker.name = _chain.join(':');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3. форматтеры

/**
 * Режим размещения изображения в рамке картинки-заглушки: fillWidth (по умолчанию) — ширина рамки, высота по
 * пропорциям; contain — вписать с пропорциями; fill — растянуть. Ставится перед концом метки изображения.
 *
 * @version 2.4.0
 * @param {Mixed}  d
 * @param {String} mode  fillWidth | contain | fill
 * @param {String} k     внутренний номер метки (дописывается до сборки)
 */
function imageFit (d, mode, k) {
  var _registry = this.__media;
  if (_registry === undefined || _registry === null) {
    return d;
  }
  if (FITS.indexOf(mode) === -1) {
    throw templateError(badFit(mode), _registry.sources[k]);
  }
  // режим передаётся __img этой же метки (номер k), чужой метке он не достанется
  this.__mediaFit = { k : String(k), mode : mode };
  return d;
}

/**
 * Служебный: значение метки изображения — в реестр рендера, в документ — жетон
 *
 * @private
 * @param {Mixed}  d
 * @param {String} k  внутренний номер метки
 */
function __img (d, k) {
  var _registry = this.__media;
  if (_registry === undefined || _registry === null || /^\d+$/.test(String(k)) === false || _registry.sources[k] === undefined) {
    return '';
  }
  var _fit = DEFAULT_FIT;
  if (this.__mediaFit !== undefined && this.__mediaFit !== null && this.__mediaFit.k === String(k)) {
    _fit = this.__mediaFit.mode;
  }
  this.__mediaFit = null;
  _registry.items.push({ value : d, fit : _fit, kind : 'image', source : _registry.sources[k] });
  return OPEN + 'm' + _registry.nonce + 'i' + (_registry.items.length - 1) + CLOSE;
}

// ---------------------------------------------------------------------------------------------------------------
// Загрузка изображений

/**
 * Изображение по заголовку файла: тип и размер в пикселях
 * @return {Object} { buffer, type : 'png'|'jpeg'|'gif', width, height }
 */
function identify (buffer, source) {
  if (buffer.length > MAX_IMAGE) {
    throw templateError(MSG.tooBig, source);
  }
  var _info;
  try {
    _info = imageSize(buffer);
  }
  catch (e) {
    throw templateError(MSG.corrupt, source);
  }
  if (_info.type === 'svg') {
    throw templateError(MSG.svg, source);
  }
  var _type = { png : 'png', jpg : 'jpeg', gif : 'gif' }[_info.type];
  if (_type === undefined || !(_info.width > 0) || !(_info.height > 0)) {
    throw templateError(MSG.corrupt, source);
  }
  return { buffer : buffer, type : _type, width : _info.width, height : _info.height };
}

/** data:image/(png|jpeg|gif)[;параметры];base64,… */
function decodeDataUri (value, source) {
  var _match = /^data:([^,;]*)((?:;[^,;]*)*),([\s\S]*)$/i.exec(value);
  if (_match === null) {
    throw templateError(MSG.badUri, source);
  }
  var _mime = _match[1].trim().toLowerCase();
  if (_mime === 'image/svg+xml') {
    throw templateError(MSG.svg, source);
  }
  if (_mime === '') {
    throw templateError(MSG.badUri, source);
  }
  if (DATA_MIMES.indexOf(_mime) === -1) {
    throw templateError(badType(_mime), source);
  }
  var _params = _match[2].split(';').map(function (p) {
    return p.trim().toLowerCase();
  });
  var _base64 = _match[3].replace(/\s+/g, '');
  if (_params[_params.length - 1] !== 'base64' || /^[A-Za-z0-9+/]*={0,2}$/.test(_base64) === false || _base64.length % 4 === 1 || _base64.length === 0) {
    throw templateError(MSG.badUri, source);
  }
  // размер — до декодирования
  if (Math.floor(_base64.replace(/=+$/, '').length * 3 / 4) > MAX_IMAGE) {
    throw templateError(MSG.tooBig, source);
  }
  return identify(Buffer.from(_base64, 'base64'), source);
}

/** Изображение по адресу http(s) — §32.2 (загрузка — Task 3 плана 2.4.0) */
function loadUrl (url, item, options) {
  var _allowlist = options.imageUrlAllowlist;
  if (Array.isArray(_allowlist) === false || _allowlist.length === 0) {
    throw templateError(MSG.urlDisabled, item.source);
  }
  throw templateError('загрузка изображений по адресу пока не поддерживается', item.source);
}

/** Источники данных записи реестра по виду (kind); barcode добавит Task 4 */
var LOADERS = {
  image : function (item, options) {
    var _value = item.value;
    if (typeof _value === 'string') {
      _value = _value.trim();
    }
    if (_value === null || _value === undefined || _value === '') {
      return null;
    }
    if (typeof _value !== 'string') {
      throw templateError(MSG.notImage, item.source);
    }
    if (/^data:/i.test(_value) === true) {
      return decodeDataUri(_value, item.source);
    }
    if (/^https?:\/\//i.test(_value) === true) {
      return loadUrl(_value, item, options);
    }
    throw templateError(MSG.notImage, item.source);
  }
};

/**
 * Данные изображения записи реестра
 * @param  {Object} item     { value, fit, kind, source }
 * @param  {Object} options  опции рендера (imageUrlAllowlist, imageUrlTimeoutMs, warnings)
 * @return {Promise<Object|null>} { buffer, type, width, height } или null — заглушку удалить
 */
function loadImage (item, options) {
  return Promise.resolve().then(function () {
    var _loader = LOADERS[item.kind];
    if (_loader === undefined) {
      throw templateError('неизвестный вид изображения «' + item.kind + '»', item.source);
    }
    return _loader(item, options || {});
  });
}

/** fn по элементам списка, не больше limit одновременно; результаты { value } или { error } по порядку */
function mapLimit (list, limit, fn) {
  return new Promise(function (resolve) {
    var _results = new Array(list.length);
    var _next = 0;
    var _done = 0;
    if (list.length === 0) {
      return resolve(_results);
    }
    var _run = function () {
      var _i = _next++;
      Promise.resolve().then(function () {
        return fn(list[_i], _i);
      }).then(function (value) {
        _results[_i] = { value : value };
      }, function (error) {
        _results[_i] = { error : error };
      }).then(function () {
        _done++;
        if (_done === list.length) {
          return resolve(_results);
        }
        if (_next < list.length) {
          _run();
        }
      });
    };
    for (var i = 0; i < Math.min(limit, list.length); i++) {
      _run();
    }
  });
}

function itemKey (item) {
  return item.kind + '\u0000' + (item.barcode !== undefined ? JSON.stringify(item.barcode) : '') + '\u0000' + String(item.value);
}

// ---------------------------------------------------------------------------------------------------------------
// 4. finish

/** Путь файла связей части OOXML: word/document.xml → word/_rels/document.xml.rels */
function relsPath (name) {
  return path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels');
}

function escapeAttr (value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Заменить картинки-заглушки изображениями после сборки всех файлов (renderBuffer, между walkFiles и finishXlsx)
 * @param  {Object} template  собранный шаблон { files, extension }
 * @param  {Object} options   опции рендера (реестр options.__media)
 * @return {Promise<void>}
 */
function finish (template, options) {
  var _registry = options !== null && options !== undefined ? options.__media : undefined;
  if (_registry === undefined || _registry === null || _registry.items.length === 0 || template === null || Array.isArray(template.files) === false) {
    return Promise.resolve();
  }
  return Promise.resolve().then(function () {
    var _fmt = formatOf(template.extension || options.extension);
    var _jobs = collect(template, _registry, _fmt);
    if (_jobs.length === 0) {
      return;
    }
    // одинаковые значения грузятся один раз и делят media-файл
    var _unique = [];
    var _keyOf = new Map();
    _jobs.forEach(function (job) {
      job.containers.forEach(function (id) {
        var _key = itemKey(_registry.items[id]);
        if (_keyOf.has(_key) === false) {
          _keyOf.set(_key, _unique.length);
          _unique.push(_registry.items[id]);
        }
      });
    });
    return mapLimit(_unique, CONCURRENCY, function (item) {
      return loadImage(item, options);
    }).then(function (results) {
      var _total = 0;
      var _images = results.map(function (result, i) {
        if (result.error !== undefined) {
          throw result.error;
        }
        if (result.value !== null) {
          _total += result.value.buffer.length;
          if (_total > MAX_TOTAL) {
            throw templateError(MSG.tooBigTotal, _unique[i].source);
          }
        }
        return result.value;
      });
      write(template, _registry, _fmt, _jobs, function (id) {
        return _images[_keyOf.get(itemKey(_registry.items[id]))];
      });
    });
  });
}

/**
 * Жетоны этого рендера по файлам верхнего уровня
 * @return {Array} [{ file, tokens, containers : Map(контейнер → номер первой записи) }]
 */
function collect (template, registry, fmt) {
  var _jobs = [];
  template.files.forEach(function (file) {
    if ((file.parent !== '' && file.parent !== undefined) || typeof file.data !== 'string' || file.data.indexOf(OPEN) === -1) {
      return;
    }
    var _parsed = xmltree.parse(file.data, TOKEN_REGEX, function (match) {
      var _id = parseInt(match[2], 10);
      return match[1] === registry.nonce && registry.items[_id] !== undefined ? { id : _id } : null;
    });
    if (_parsed.tokens.length === 0) {
      return;
    }
    var _containers = new Map();
    _parsed.tokens.forEach(function (token) {
      var _container = fmt === null ? null : fmt.container(token.el);
      if (_container === null) {
        throw templateError(MSG.outside, registry.items[token.id].source);
      }
      if (_containers.has(_container) === false) {
        _containers.set(_container, token.id);
      }
    });
    _jobs.push({ file : file, tokens : _parsed.tokens, containers : _containers });
  });
  return _jobs;
}

/** Правки документа, связи, media-файлы и типы содержимого */
function write (template, registry, fmt, jobs, imageOf) {
  var _names = new Set(template.files.map(function (f) {
    return f.name;
  }));
  var _mediaOf = new Map(); // изображение → путь media-файла
  var _types = new Set();
  var _counter = 0;
  var _mediaPath = function (image) {
    if (_mediaOf.has(image) === false) {
      var _name;
      do {
        _name = fmt.mediaDir + 'cr-img-' + (++_counter) + '.' + TYPES[image.type].ext;
      } while (_names.has(_name) === true);
      _names.add(_name);
      _mediaOf.set(image, _name);
      _types.add(image.type);
      template.files.push({ name : _name, data : image.buffer, isMarked : false, parent : '' });
    }
    return _mediaOf.get(image);
  };
  var _stripTokens = function (str) {
    return str.replace(TOKEN_REGEX, function (all, nonce) {
      return nonce === registry.nonce ? '' : all;
    });
  };

  jobs.forEach(function (job) {
    var _xml = job.file.data;
    var _rels = null;
    var _edits = job.tokens.map(function (token) {
      return { start : token.pos, end : token.pos + token.len, rep : '' };
    });
    job.containers.forEach(function (id, container) {
      var _item = registry.items[id];
      var _image = imageOf(id);
      if (_image === null) {
        _edits.push({ start : container.start, end : container.end, rep : '' });
        return;
      }
      if (_rels === null) {
        _rels = relations(template, job.file.name);
      }
      var _target = path.posix.relative(path.posix.dirname(job.file.name), _mediaPath(_image));
      var _relId = _rels.idFor(_target);
      fmt.place(_xml, container, _image, _relId, _item.fit).forEach(function (edit) {
        _edits.push({ start : edit.el.start, end : edit.el.openEnd, rep : edit.tag(_stripTokens(startTag(_xml, edit.el))) });
      });
    });
    job.file.data = xmltree.applyEdits(_xml, _edits);
    if (_rels !== null) {
      _rels.save();
    }
  });
  if (_types.size > 0) {
    addContentTypes(template, _types);
  }
}

/**
 * Связи части: существующий .rels или новый; idFor(target) — Id связи-изображения (новой или уже добавленной)
 */
function relations (template, partName) {
  var _name = relsPath(partName);
  var _file = template.files.find(function (f) {
    return f.name === _name && (f.parent === '' || f.parent === undefined);
  });
  if (_file === undefined) {
    _file = { name : _name, data : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + RELS_NS + '"></Relationships>', isMarked : false, parent : '' };
    template.files.push(_file);
  }
  if (Buffer.isBuffer(_file.data) === true) {
    _file.data = _file.data.toString('utf8');
  }
  var _ids = new Set();
  _file.data.replace(/\sId\s*=\s*"([^"]*)"/g, function (all, id) {
    _ids.add(id);
    return all;
  });
  var _added = new Map();
  var _counter = 0;
  return {
    idFor : function (target) {
      if (_added.has(target) === false) {
        var _id;
        do {
          _id = 'rIdCrImg' + (++_counter);
        } while (_ids.has(_id) === true);
        _ids.add(_id);
        _added.set(target, _id);
      }
      return _added.get(target);
    },
    save : function () {
      if (_added.size === 0) {
        return;
      }
      var _xml = '';
      _added.forEach(function (id, target) {
        _xml += '<Relationship Id="' + id + '" Type="' + IMAGE_REL + '" Target="' + escapeAttr(target) + '"/>';
      });
      var _close = _file.data.lastIndexOf('</Relationships>');
      if (_close !== -1) {
        _file.data = _file.data.slice(0, _close) + _xml + _file.data.slice(_close);
      }
      else {
        // пустой <Relationships …/>
        _file.data = _file.data.replace(/<Relationships([^>]*)\/>/, '<Relationships$1>' + _xml + '</Relationships>');
      }
    }
  };
}

/** Default Extension для типов новых media-файлов в [Content_Types].xml (если их ещё нет) */
function addContentTypes (template, types) {
  var _file = template.files.find(function (f) {
    return f.name === '[Content_Types].xml' && (f.parent === '' || f.parent === undefined);
  });
  if (_file === undefined) {
    return;
  }
  if (Buffer.isBuffer(_file.data) === true) {
    _file.data = _file.data.toString('utf8');
  }
  var _xml = '';
  types.forEach(function (type) {
    var _ext = TYPES[type].ext;
    if (new RegExp('<Default\\s[^>]*Extension\\s*=\\s*"' + _ext + '"', 'i').test(_file.data) === false) {
      _xml += '<Default Extension="' + _ext + '" ContentType="' + TYPES[type].mime + '"/>';
    }
  });
  var _close = _file.data.lastIndexOf('</Types>');
  if (_xml !== '' && _close !== -1) {
    _file.data = _file.data.slice(0, _close) + _xml + _file.data.slice(_close);
  }
}

module.exports = {
  createRegistry,
  preprocess,
  prepare,
  finish,
  loadImage,
  formatters : { imageFit, __img },
  TOKEN_REGEX
};
