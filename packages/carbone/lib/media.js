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
//      загружаются (loadImage: data URI или адрес http(s) из белого списка, не больше 4 загрузок одновременно),
//      в контейнере меняются ссылка на файл и размеры, добавляются media-файл и связь (OOXML: .rels и
//      [Content_Types].xml; OpenDocument: META-INF/manifest.xml); пустое значение удаляет контейнер. Без жетонов
//      документ не меняется.
//
// Форматы (DOCX, PPTX, XLSX, ODT, ODS, ODP): правила разметки — lib/media-formats.js, по семействам
// (xmltree.family); источники данных — LOADERS по виду записи реестра (kind).
//
// Штрихкоды (§32.3): «{d.code:barcode(qrcode, scale:4)}» в замещающем тексте — та же метка изображения: форматтер
// barcode передаёт тип и опции своему __img (как imageFit), запись реестра получает kind 'barcode', а LOADERS.barcode
// строит PNG через bwip-js. Дальше — общий путь картинок (imageFit, лимиты 10/50 МБ, пустое значение — удаление).

var crypto = require('crypto');
var bwipjs = require('bwip-js');
var imageSize = require('image-size').imageSize;
var splitChain = require('./set').splitChain;
var xmltree = require('./xmltree');
var formats = require('./media-formats');

var formatOf = formats.formatOf;
var TYPES = formats.TYPES;

// жетон: символы частного использования, отличные от агрегаторов (U+E000/U+E001) и drop/keep (U+E010/U+E011)
var OPEN = '';
var CLOSE = '';
var TOKEN_REGEX = /m([0-9a-f]{12})i(\d+)/g;

var MB = 1024 * 1024;
var MAX_IMAGE = 10 * MB; // одно изображение после декодирования
var MAX_TOTAL = 50 * MB; // все изображения отчёта
var CONCURRENCY = 4; // одновременных загрузок на отчёт (§32.2)
var DEFAULT_TIMEOUT = 5000; // мс на загрузку одного изображения по адресу (IMAGE_URL_TIMEOUT_MS)

var FITS = ['fillWidth', 'contain', 'fill'];
var DEFAULT_FIT = 'fillWidth';

var DATA_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

// штрихкоды: типы bwip-js (имена совпадают с документацией Carbone), масштаб по умолчанию, предел размера растра
var BARCODE_TYPES = new Set(bwipjs.symbolList.map(function (symbol) {
  return symbol.bcid;
}));
var BARCODE_SCALE = 3;
var BARCODE_PIXELS = 16000000; // ширина × высота до выделения памяти под растр (опция sizelimit bwip-js)

/**
 * Опции штрихкода «имя:значение» (§32.3) в порядке записи в реестр: проверка значения → значение для bwip-js
 * (undefined — недопустимое) и подсказка для ошибки. svg принимается и игнорируется: вывод всегда PNG.
 */
var BARCODE_OPTIONS = {
  width           : { hint : 'число миллиметров больше 0', parse : positive },
  height          : { hint : 'число миллиметров больше 0', parse : positive },
  scale           : { hint : 'целое от 1 до 10', parse : function (v) {
    return /^\d+$/.test(v) === true && Number(v) >= 1 && Number(v) <= 10 ? Number(v) : undefined;
  } },
  includetext     : { hint : 'true или false', parse : bool },
  textsize        : { hint : 'число больше 0', parse : positive },
  textxalign      : { hint : 'left, center, right или justify', parse : oneOf(['left', 'center', 'right', 'justify'], false) },
  textyalign      : { hint : 'below, center или above', parse : oneOf(['below', 'center', 'above'], false) },
  rotate          : { hint : 'N, R, L или I', parse : oneOf(['N', 'R', 'L', 'I'], true) },
  barcolor        : { hint : 'цвет #RRGGBB', parse : color },
  textcolor       : { hint : 'цвет #RRGGBB', parse : color },
  backgroundcolor : { hint : 'цвет #RRGGBB', parse : color },
  eclevel         : { hint : 'L, M, Q или H', parse : oneOf(['L', 'M', 'Q', 'H'], true) },
  svg             : { hint : 'true или false', parse : bool, ignored : true }
};

function positive (v) {
  return /^\d+(?:\.\d+)?$/.test(v) === true && Number(v) > 0 ? Number(v) : undefined;
}

function bool (v) {
  return v === 'true' ? true : (v === 'false' ? false : undefined);
}

/** «#RRGGBB» → «RRGGBB» (bwip-js ждёт цвет без решётки) */
function color (v) {
  return /^#[0-9a-fA-F]{6}$/.test(v) === true ? v.slice(1).toUpperCase() : undefined;
}

/** одно из значений; upper — без учёта регистра, к верхнему регистру */
function oneOf (list, upper) {
  return function (v) {
    var _v = upper === true ? v.toUpperCase() : v;
    return list.indexOf(_v) !== -1 ? _v : undefined;
  };
}

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
  badUrl      : 'неверный адрес изображения',
  urlAuth     : 'адрес изображения с именем пользователя или паролем не поддерживается',
  fitOutside  : 'imageFit ставится в метку изображения — в замещающий текст (название или описание) картинки',
  barcodeOutside : 'штрихкод ставится в замещающий текст картинки',
  barcodeType    : 'barcode: укажите тип штрихкода, например barcode(qrcode)',
  barcodeValue   : 'значение штрихкода должно быть строкой или числом',
  barcodeTooBig  : 'штрихкод больше 16 млн пикселей (уменьшите scale, width или height)',
  outside     : 'метка изображения должна стоять в замещающем тексте (названии или описании) картинки'
};

function badType (mime) {
  return 'тип изображения «' + mime + '» не поддерживается (изображения: PNG, JPEG, GIF)';
}

function badFit (mode) {
  return 'imageFit: неизвестный режим «' + mode + '» (fillWidth, contain или fill)';
}

function badBarcodeValue (name, value) {
  return 'barcode: недопустимое значение «' + value + '» опции ' + name + ' (' + BARCODE_OPTIONS[name].hint + ')';
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
    if (/:\s*(?:__img|imageFit|barcode)\b/.test(_marker.name) === false) {
      continue;
    }
    var _chain = splitChain(_marker.name);
    var _names = _chain.map(function (part) {
      return part.trim().split('(')[0].trim();
    });
    var _source = sourceOf(_marker);
    if (_names.indexOf('barcode', 1) !== -1 && _names.indexOf('__img', 1) === -1) {
      throw templateError(MSG.barcodeOutside, _source);
    }
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
      else if (_names[j] === 'barcode') {
        var _bstr = _chain[j].trim();
        var _bopen = _bstr.indexOf('(');
        var _bargs = _bopen === -1 ? '' : _bstr.slice(_bopen + 1, _bstr.lastIndexOf(')')).trim();
        // литералы проверяются сразу (и в метке, которая при сборке не выполнится); пути (.type, d.x, c.x) — при сборке
        parseBarcode(splitArgs(_bargs).map(function (arg) {
          return /^\s*'/.test(arg) === false && /^\s*(?:\.|[dc]\.)/.test(arg) === true ? null : unquote(arg);
        }), _source);
        _chain[j] = 'barcode(' + (_bargs !== '' ? _bargs + ', ' : '') + _k + ')';
      }
    }
    _marker.source = _source.slice(1, -1);
    _marker.name = _chain.join(':');
  }
}

/** Аргументы форматтера через запятую; запятая в кавычках — часть аргумента (как в builder.getFormatterString) */
function splitArgs (str) {
  if (str.trim() === '') {
    return [];
  }
  var _args = [];
  var _current = '';
  var _quote = false;
  for (var i = 0; i < str.length; i++) {
    if (str[i] === '\'') {
      _quote = !_quote;
    }
    else if (str[i] === ',' && _quote === false) {
      _args.push(_current);
      _current = '';
      continue;
    }
    _current += str[i];
  }
  _args.push(_current);
  return _args;
}

/**
 * Тип и опции штрихкода из аргументов barcode(тип, имя:значение, …)
 * @param  {Array}  args    аргументы без кавычек; null — путь, значение известно только при сборке (не проверяется)
 * @param  {String} source  метка (для ошибки)
 * @return {Object} { type, options } — options в порядке BARCODE_OPTIONS, значения для bwip-js
 */
function parseBarcode (args, source) {
  var _type = args.length > 0 ? args[0] : '';
  if (typeof _type === 'string') {
    _type = _type.trim();
    if (_type === '') {
      throw templateError(MSG.barcodeType, source);
    }
    if (BARCODE_TYPES.has(_type) === false) {
      throw templateError('неизвестный тип штрихкода «' + _type + '»', source);
    }
  }
  var _parsed = {};
  for (var i = 1; i < args.length; i++) {
    if (args[i] === null || args[i] === undefined) {
      continue;
    }
    var _arg = String(args[i]).trim();
    var _colon = _arg.indexOf(':');
    if (_colon === -1) {
      throw templateError('barcode: опция «' + _arg + '» записывается как имя:значение', source);
    }
    var _name = _arg.slice(0, _colon).trim().toLowerCase();
    var _raw = _arg.slice(_colon + 1).trim();
    if (Object.prototype.hasOwnProperty.call(BARCODE_OPTIONS, _name) === false) {
      throw templateError('barcode: неизвестная опция «' + _arg.slice(0, _colon).trim() + '» (' + Object.keys(BARCODE_OPTIONS).join(', ') + ')', source);
    }
    var _value = BARCODE_OPTIONS[_name].parse(_raw);
    if (_value === undefined) {
      throw templateError(badBarcodeValue(_name, _raw), source);
    }
    _parsed[_name] = _value;
  }
  var _options = {};
  Object.keys(BARCODE_OPTIONS).forEach(function (name) {
    if (_parsed[name] !== undefined && BARCODE_OPTIONS[name].ignored !== true) {
      _options[name] = _parsed[name];
    }
  });
  return { type : _type, options : _options };
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
 * Штрихкод вместо картинки-заглушки: barcode(тип, опция:значение, …) в замещающем тексте картинки. Типы — bwip-js
 * (qrcode, ean13, code128, …); опции: width, height (мм), scale (1–10, по умолчанию 3), includetext, textsize,
 * textxalign, textyalign, rotate (N/R/L/I), barcolor, textcolor, backgroundcolor (#RRGGBB), eclevel (L/M/Q/H),
 * svg (игнорируется: вывод PNG). Значение не меняется — его забирает __img этой же метки.
 *
 * @version 2.4.0
 * @param {Mixed}  d
 * @param {String} type  тип штрихкода, затем опции «имя:значение»; последний аргумент — внутренний номер метки
 */
function barcode (d) {
  var _registry = this.__media;
  if (_registry === undefined || _registry === null || arguments.length < 2) {
    return d;
  }
  var _args = Array.prototype.slice.call(arguments, 1);
  var _k = String(_args.pop());
  var _parsed = parseBarcode(_args.map(function (arg) {
    return arg === null || arg === undefined ? '' : String(arg);
  }), _registry.sources[_k]);
  // тип и опции передаются __img этой же метки (номер k), чужой метке они не достанутся
  this.__mediaBarcode = { k : _k, type : _parsed.type, options : _parsed.options };
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
  var _item = { value : d, fit : _fit, kind : 'image', source : _registry.sources[k] };
  if (this.__mediaBarcode !== undefined && this.__mediaBarcode !== null && this.__mediaBarcode.k === String(k)) {
    _item.kind = 'barcode';
    _item.barcode = { type : this.__mediaBarcode.type, options : this.__mediaBarcode.options };
  }
  this.__mediaBarcode = null;
  _registry.items.push(_item);
  return OPEN + 'm' + _registry.nonce + 'i' + (_registry.items.length - 1) + CLOSE;
}

// ---------------------------------------------------------------------------------------------------------------
// Загрузка изображений

/**
 * Изображение по заголовку файла: тип и размер в пикселях
 * @param  {Buffer} buffer
 * @param  {String} source  метка (для ошибки)
 * @param  {String} [origin] откуда данные (адрес без query-строки) — дописывается в текст ошибки
 * @return {Object} { buffer, type : 'png'|'jpeg'|'gif', width, height }
 */
function identify (buffer, source, origin) {
  var _where = origin !== undefined ? ' (адрес ' + origin + ')' : '';
  if (buffer.length > MAX_IMAGE) {
    throw templateError(MSG.tooBig + _where, source);
  }
  var _info;
  try {
    _info = imageSize(buffer);
  }
  catch (e) {
    throw templateError(MSG.corrupt + _where, source);
  }
  if (_info.type === 'svg') {
    throw templateError(MSG.svg + _where, source);
  }
  var _type = { png : 'png', jpg : 'jpeg', gif : 'gif' }[_info.type];
  if (_type === undefined || !(_info.width > 0) || !(_info.height > 0)) {
    throw templateError(MSG.corrupt + _where, source);
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

var DEFAULT_PORTS = { 'http:' : '80', 'https:' : '443' };

/**
 * Хост адреса в белом списке: точное совпадение имени без учёта регистра, без масок; порт — часть хоста, только если
 * указан в списке («example.org» — только порт по умолчанию; «example.org:8443» — только он)
 * @param  {URL}      url
 * @param  {String[]} allowlist
 * @return {Boolean}
 */
function hostAllowed (url, allowlist) {
  var _port = url.port !== '' ? url.port : DEFAULT_PORTS[url.protocol];
  var _variants = [url.hostname + ':' + _port];
  if (url.port === '') {
    _variants.push(url.hostname);
  }
  return (allowlist || []).some(function (entry) {
    if (typeof entry !== 'string') {
      return false;
    }
    var _entry = entry.trim().toLowerCase();
    return _entry !== '' && _variants.indexOf(_entry) !== -1;
  });
}

/** Адрес для журнала: без учётных данных, query-строки и фрагмента */
function safeUrl (url) {
  return url.protocol + '//' + url.host + url.pathname;
}

/** Ошибка загрузки по сети: заглушка удаляется, отчёт строится (§32.1) */
function NetworkFailure (reason) {
  this.reason = reason;
}

/**
 * Тело ответа потоком с подсчётом байт: чтение обрывается, как только превышен лимит (тело целиком не копится)
 * @return {Promise<Buffer>}
 */
function readLimited (response, limit) {
  var _length = Number(response.headers.get('content-length'));
  if (Number.isFinite(_length) && _length > limit) {
    return response.body.cancel().catch(function () {}).then(function () {
      throw new NetworkFailure(MSG.tooBig);
    });
  }
  var _reader = response.body.getReader();
  var _chunks = [];
  var _size = 0;
  var _next = function () {
    return _reader.read().then(function (part) {
      if (part.done === true) {
        return Buffer.concat(_chunks, _size);
      }
      _size += part.value.length;
      if (_size > limit) {
        return _reader.cancel().catch(function () {}).then(function () {
          throw new NetworkFailure(MSG.tooBig);
        });
      }
      _chunks.push(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.length));
      return _next();
    });
  };
  return _next();
}

/**
 * Проверка адреса до загрузки (§32.2): загрузка включена, адрес разбирается, без учётных данных, хост в белом
 * списке (options.imageUrlAllowlist). Иначе — ошибка шаблона.
 * @return {URL}
 */
function checkUrl (value, item, options) {
  var _allowlist = options.imageUrlAllowlist;
  if (Array.isArray(_allowlist) === false || _allowlist.length === 0) {
    throw templateError(MSG.urlDisabled, item.source);
  }
  var _url;
  try {
    _url = new URL(value);
  }
  catch (e) {
    throw templateError(MSG.badUrl, item.source);
  }
  if (_url.username !== '' || _url.password !== '') {
    throw templateError(MSG.urlAuth, item.source);
  }
  if (hostAllowed(_url, _allowlist) === false) {
    throw templateError('хост «' + _url.host + '» не входит в белый список IMAGE_URL_ALLOWLIST', item.source);
  }
  return _url;
}

/**
 * Изображение по адресу http(s) — §32.2: адрес из checkUrl, без перенаправлений, тайм-аут
 * options.imageUrlTimeoutMs на всю загрузку, до 10 МБ. Сбой сети, код ответа не 2xx, превышение размера —
 * предупреждение в options.warnings (адрес без query-строки) и null (заглушка удаляется). Не изображение в
 * ответе — ошибка шаблона с адресом. signal — общая отмена загрузок отчёта (finish): после неё предупреждений нет.
 */
function loadUrl (value, item, options, signal) {
  var _url = checkUrl(value, item, options);
  var _timeout = Number.isFinite(options.imageUrlTimeoutMs) && options.imageUrlTimeoutMs > 0 ? options.imageUrlTimeoutMs : DEFAULT_TIMEOUT;
  var _signal = signal !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(_timeout)]) : AbortSignal.timeout(_timeout);
  return fetch(_url.href, { redirect : 'manual', signal : _signal }).then(function (response) {
    if (response.status < 200 || response.status > 299) {
      if (response.body !== null) {
        response.body.cancel().catch(function () {});
      }
      throw new NetworkFailure('код ответа ' + response.status);
    }
    if (response.body === null) {
      return Buffer.alloc(0);
    }
    return readLimited(response, MAX_IMAGE);
  }).then(function (buffer) {
    return identify(buffer, item.source, safeUrl(_url));
  }, function (error) {
    if (signal !== undefined && signal.aborted === true) {
      return null; // отчёт уже завершается ошибкой
    }
    var _reason;
    if (error instanceof NetworkFailure) {
      _reason = error.reason;
    }
    else if (error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      _reason = 'тайм-аут ' + _timeout + ' мс';
    }
    else {
      var _cause = error !== null && typeof error === 'object' && error.cause !== undefined && error.cause !== null ? error.cause : error;
      _reason = 'ошибка сети' + (_cause !== null && typeof _cause === 'object' && typeof _cause.code === 'string' ? ' ' + _cause.code : '');
    }
    if (Array.isArray(options.warnings) === true) {
      options.warnings.push('изображение не загружено: ' + safeUrl(_url) + ' — ' + _reason + ' Метка: ' + item.source);
    }
    return null;
  });
}

/**
 * Вид значения изображения: пусто, data URI или адрес http(s); иное — ошибка шаблона (R3)
 * @return {Object} { kind : 'empty'|'data'|'url', value }
 */
function imageValue (item) {
  var _value = item.value;
  if (typeof _value === 'string') {
    _value = _value.trim();
  }
  if (_value === null || _value === undefined || _value === '') {
    return { kind : 'empty', value : null };
  }
  if (typeof _value === 'string' && /^data:/i.test(_value) === true) {
    return { kind : 'data', value : _value };
  }
  if (typeof _value === 'string' && /^https?:\/\//i.test(_value) === true) {
    return { kind : 'url', value : _value };
  }
  throw templateError(MSG.notImage, item.source);
}

/**
 * Проверки записи реестра до первой загрузки (синхронно, по порядку документа): ошибка шаблона в поздней
 * картинке не ждёт загрузок ранних
 */
var CHECKS = {
  image : function (item, options) {
    var _image = imageValue(item);
    if (_image.kind === 'url') {
      checkUrl(_image.value, item, options);
    }
  },
  barcode : function (item) {
    barcodeText(item);
  }
};

/**
 * Текст штрихкода: строка или число; пусто (null, undefined, '', одни пробелы) — null, заглушка удаляется
 * @return {String|null}
 */
function barcodeText (item) {
  var _value = item.value;
  if (_value === null || _value === undefined || (typeof _value === 'string' && _value.trim() === '')) {
    return null;
  }
  if (typeof _value === 'number' && Number.isFinite(_value) === true) {
    return String(_value);
  }
  if (typeof _value !== 'string') {
    throw templateError(MSG.barcodeValue, item.source);
  }
  return _value;
}

/**
 * PNG штрихкода через bwip-js (toBuffer). Ошибка bwip-js (недопустимые данные для типа и т. п.) — ошибка шаблона
 * с причиной от bwip-js; растр больше BARCODE_PIXELS не строится (sizelimit). PNG проходит те же проверки, что
 * изображение (identify: 10 МБ).
 * @return {Promise<Object|null>}
 */
function renderBarcode (item) {
  var _text = barcodeText(item);
  if (_text === null) {
    return null;
  }
  var _type = item.barcode.type;
  var _opts = Object.assign({ bcid : _type, text : _text, scale : BARCODE_SCALE }, item.barcode.options, { sizelimit : BARCODE_PIXELS });
  return Promise.resolve().then(function () {
    return bwipjs.toBuffer(_opts);
  }).then(function (png) {
    return identify(png, item.source);
  }, function (error) {
    var _message = String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error);
    if (/^Image size over (?:default )?limit/.test(_message) === true) {
      throw templateError(MSG.barcodeTooBig, item.source);
    }
    // «bwipp.ean13badLength#6878: EAN-13 must be 12 or 13 digits» → причина без служебного префикса
    var _reason = _message.replace(/^bwipp\.[\w-]+(?:#\d+)?:\s*/, '').replace(/^bwip-js:\s*/, '');
    throw templateError('штрихкод ' + _type + ' не построен: ' + _reason, item.source);
  });
}

/** Источники данных записи реестра по виду (kind) */
var LOADERS = {
  barcode : renderBarcode,
  image : function (item, options, signal) {
    var _image = imageValue(item);
    if (_image.kind === 'data') {
      return decodeDataUri(_image.value, item.source);
    }
    if (_image.kind === 'url') {
      return loadUrl(_image.value, item, options, signal);
    }
    return null;
  }
};

/** Проверить запись реестра до загрузки (CHECKS по виду); вида без проверки — ничего */
function checkImage (item, options) {
  var _check = CHECKS[item.kind];
  if (_check !== undefined) {
    _check(item, options || {});
  }
}

/**
 * Данные изображения записи реестра
 * @param  {Object} item      { value, fit, kind, source }
 * @param  {Object} options   опции рендера (imageUrlAllowlist, imageUrlTimeoutMs, warnings)
 * @param  {AbortSignal} [signal] отмена загрузки (ошибка другой картинки отчёта)
 * @return {Promise<Object|null>} { buffer, type, width, height } или null — заглушку удалить
 */
function loadImage (item, options, signal) {
  return Promise.resolve().then(function () {
    var _loader = LOADERS[item.kind];
    if (_loader === undefined) {
      throw templateError('неизвестный вид изображения «' + item.kind + '»', item.source);
    }
    return _loader(item, options || {}, signal);
  });
}

/**
 * fn(элемент, номер, signal) по элементам списка, не больше limit одновременно; результаты по порядку.
 * Первая ошибка сразу отклоняет обещание: новые элементы не запускаются, идущие отменяются через signal.
 * @return {Promise<Array>}
 */
function loadAll (list, limit, fn) {
  return new Promise(function (resolve, reject) {
    var _results = new Array(list.length);
    var _controller = new AbortController();
    var _next = 0;
    var _done = 0;
    var _failed = false;
    if (list.length === 0) {
      return resolve(_results);
    }
    var _run = function () {
      var _i = _next++;
      Promise.resolve().then(function () {
        return fn(list[_i], _i, _controller.signal);
      }).then(function (value) {
        if (_failed === true) {
          return;
        }
        _results[_i] = value;
        _done++;
        if (_done === list.length) {
          return resolve(_results);
        }
        if (_next < list.length) {
          _run();
        }
      }, function (error) {
        if (_failed === true) {
          return;
        }
        _failed = true;
        _controller.abort();
        reject(error);
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
    // ошибки адресов и значений — до первой загрузки, по порядку документа
    _unique.forEach(function (item) {
      checkImage(item, options);
    });
    // суммарный лимит — по мере загрузки: превышение сразу останавливает остальные
    var _total = 0;
    return loadAll(_unique, CONCURRENCY, function (item, i, signal) {
      return loadImage(item, options, signal).then(function (image) {
        if (image !== null) {
          _total += image.buffer.length;
          if (_total > MAX_TOTAL) {
            throw templateError(MSG.tooBigTotal, item.source);
          }
        }
        return image;
      });
    }).then(function (_images) {
      write(template, _registry, _fmt, _jobs, function (id) {
        return _images[_keyOf.get(itemKey(_registry.items[id]))];
      });
    });
  });
}

/**
 * Жетоны этого рендера по файлам верхнего уровня
 * @return {Array} [{ file, root, tokens, containers : Map(контейнер → номер первой записи) }]
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
    _jobs.push({ file : file, root : _parsed.root, tokens : _parsed.tokens, containers : _containers });
  });
  return _jobs;
}

/** Правки документа, связи, media-файлы и их регистрация в пакете (правила формата — lib/media-formats.js) */
function write (template, registry, fmt, jobs, imageOf) {
  var _names = new Set(template.files.map(function (f) {
    return f.name;
  }));
  var _mediaOf = new Map(); // изображение → путь media-файла
  var _media = []; // новые файлы [{ name, type }]
  var _counter = 0;
  var _mediaPath = function (image) {
    if (_mediaOf.has(image) === false) {
      var _name;
      do {
        _name = fmt.mediaDir + 'cr-img-' + (++_counter) + '.' + TYPES[image.type].ext;
      } while (_names.has(_name) === true);
      _names.add(_name);
      _mediaOf.set(image, _name);
      _media.push({ name : _name, type : image.type });
      formats.addFile(template, { name : _name, data : image.buffer, isMarked : false, parent : '' });
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
    var _links = null;
    var _edits = job.tokens.map(function (token) {
      return { start : token.pos, end : token.pos + token.len, rep : '' };
    });
    // правки открывающих тегов по элементам: несколько правил одного тега применяются по очереди
    var _tags = new Map();
    var _tag = function (el, fn) {
      if (_tags.has(el) === false) {
        _tags.set(el, []);
      }
      _tags.get(el).push(fn);
    };
    var _kept = new Set();
    job.containers.forEach(function (id, container) {
      var _image = imageOf(id);
      if (_image === null) {
        _edits.push({ start : container.start, end : container.end, rep : '' });
        return;
      }
      _kept.add(container);
      if (_links === null) {
        _links = fmt.links(template, job.file.name);
      }
      fmt.place(_xml, container, _image, _links.ref(_mediaPath(_image)), registry.items[id].fit).forEach(function (edit) {
        if (edit.remove === true) {
          _edits.push({ start : edit.el.start, end : edit.el.end, rep : '' });
        }
        else {
          _tag(edit.el, edit.tag);
        }
      });
    });
    if (fmt.idTags !== null && _kept.size > 0) {
      formats.uniqueIds(_xml, job.root, fmt.idTags, _kept).forEach(function (edit) {
        _tag(edit.el, edit.tag);
      });
    }
    _tags.forEach(function (fns, el) {
      var _rep = fns.reduce(function (tag, fn) {
        return fn(tag);
      }, _stripTokens(xmltree.startTag(_xml, el)));
      _edits.push({ start : el.start, end : el.openEnd, rep : _rep });
    });
    job.file.data = xmltree.applyEdits(_xml, _edits);
    if (_links !== null) {
      _links.save();
    }
  });
  if (_media.length > 0) {
    fmt.register(template, _media);
  }
}

module.exports = {
  createRegistry,
  preprocess,
  prepare,
  finish,
  loadImage,
  hostAllowed,
  formatters : { imageFit, barcode, __img },
  TOKEN_REGEX
};
