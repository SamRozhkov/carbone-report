// Проверка адресов динамических ссылок и :defaultURL Carbone EE — своя реализация (чистая комната) по открытой
// документации (docs/superpowers/notes/2026-10-10-ee-images-barcodes-colors.md §4, спецификация §32.5).
//
// Адрес ссылки — Target связи с Type «…/hyperlink» в любом *.rels (DOCX, PPTX, XLSX) и xlink:href у text:a / draw:a
// (OpenDocument). Порядок:
//   1. preprocess — до сборки: в адресе с меткой метки «{d.…}» (и «%7Bd.…%7D», как их кодирует редактор) получают
//      последний форматтер «:__url»; «:defaultURL(x)» из такой метки переносится в «:__url(x)»; адрес целиком
//      обрамляется служебными символами OPEN…CLOSE (с ключом процесса);
//   2. форматтер __url печатает жетон: значение метки и запасной адрес в encodeURIComponent (в жетоне нет кавычек
//      и разметки — данные не порвут атрибут до проверки);
//   3. apply — после сборки файла (builder.buildXML): каждый адрес OPEN…CLOSE собирается и проверяется целиком
//      (normalizeUrl) и печатается экранированным для XML. Одна метка без статической части — значение как есть;
//      статическая часть + метки (решение R4) — значения меток через encodeURIComponent. Недопустимый адрес (или
//      пустые значения всех меток при :defaultURL) — запасной адрес :defaultURL, проверенный так же; без него или
//      при недопустимом запасном — «#». Текст, напечатанный в обход __url (show/ifEmpty останавливают цепочку),
//      считается статической частью — адрес всё равно проверяется целиком.
//
// Правила адреса (normalizeUrl): схемы http, https, mailto, tel; без схемы — https://; домен — буквы, цифры, дефис,
// не меньше двух частей, последняя (TLD) — буквы (2–63) или xn--…, длина имени 2–256; localhost и IP-адреса не
// подходят (нет TLD); имя пользователя или пароль в адресе — недопустимо; mailto — адрес с «@» и доменом по тем же
// правилам; tel — цифры, «+» в начале, пробелы, дефисы, скобки. Пробелы, кавычки, < > и не-ASCII после хоста
// кодируются (%XX).
//
// В обычном тексте :defaultURL(x) печатает значение, если оно допустимо, иначе x как есть (без проверки).

var crypto = require('crypto');
var splitChain = require('./set').splitChain;
var xmltree = require('./xmltree');

// ключ процесса: preprocess и apply выполняются в одном процессе; данные отчёта его не знают
var KEY = crypto.randomBytes(6).toString('hex');
var OPEN = '' + KEY;
var CLOSE = '' + KEY;
var T_OPEN = '' + KEY;
var T_FALLBACK = '';
var T_CLOSE = '';
var ADDRESS_REGEX = new RegExp(OPEN + '([\\s\\S]*?)' + CLOSE, 'g');
var TOKEN_REGEX = new RegExp(T_OPEN + '([^\\uE032\\uE033]*)(?:\\uE032([^\\uE033]*))?\\uE033', 'g');

// быстрая проверка файла до разбора: есть ли метка в адресе ссылки
var HINT = /\s(?:Target|xlink:href)\s*=\s*(?:"[^"]*(?:\{|%7B)|'[^']*(?:\{|%7B))/i;
// метки, которые не становятся частью адреса: удаление элемента, условные блоки, :set
var NOT_LINK_MARKER = /:\s*(?:__url|drop|keep|showBegin|showEnd|hideBegin|hideEnd|set)\b/;
var DEFAULT_URL = /^\s*defaultURL\s*(?:\(([\s\S]*)\))?\s*$/;

// ---------------------------------------------------------------------------------------------------------------
// Проверка адреса

/** Домен по справочнику §4: части из букв, цифр и дефиса, TLD — буквы или xn--…, длина 2–256 */
function validDomain (host) {
  var _host = host.replace(/\.$/, '');
  if (_host.length < 2 || _host.length > 256) {
    return false;
  }
  var _labels = _host.split('.');
  if (_labels.length < 2) {
    return false;
  }
  for (var i = 0; i < _labels.length; i++) {
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(_labels[i]) === false) {
      return false;
    }
  }
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(_labels[_labels.length - 1]);
}

/** Имя хоста в ASCII (IDN → punycode, как в URL) или null */
function asciiHost (host) {
  try {
    return new URL('http://' + host).hostname;
  }
  catch (e) {
    return null;
  }
}

function decode (str) {
  try {
    return decodeURIComponent(str);
  }
  catch (e) {
    return null;
  }
}

/** Закодировать (%XX) символы, недопустимые в адресе: пробелы, кавычки, < >, \ и не-ASCII; % не трогается */
function encodeUnsafe (str) {
  return str.replace(/[^\x21-\x7e]|["<>\\^`{|}]/gu, function (ch) {
    return encodeURIComponent(ch);
  });
}

function validMailto (rest) {
  var _addr = decode(rest.split('?')[0]);
  if (_addr === null || _addr === '') {
    return false;
  }
  return _addr.split(',').every(function (one) {
    var _match = /^[^@\s]+@([^@\s]+)$/.exec(one.trim());
    if (_match === null) {
      return false;
    }
    var _host = asciiHost(_match[1]);
    return _host !== null && validDomain(_host);
  });
}

function validTel (rest) {
  var _tel = decode(rest);
  return _tel !== null && /^\+?[\d\s()-]+$/.test(_tel) === true && /\d/.test(_tel) === true;
}

/**
 * Проверить адрес ссылки и привести к виду для документа
 * @param  {*}      value
 * @return {String|null} адрес (без схемы — с https://, небезопасные символы — %XX) или null, если адрес недопустим
 */
function normalizeUrl (value) {
  if (value === null || value === undefined) {
    return null;
  }
  var _str = String(value).trim().toWellFormed();
  // управляющие символы (перевод строки внутри «java\nscript:» и т. п.)
  if (_str === '' || /[\u0000-\u001f\u007f]/.test(_str) === true) {
    return null;
  }
  var _scheme = /^([a-z][a-z0-9+.-]*):/i.exec(_str);
  var _name = _scheme !== null ? _scheme[1].toLowerCase() : null;
  if (_name === 'mailto' || _name === 'tel') {
    var _encoded = encodeUnsafe(_str);
    var _ok = _name === 'mailto' ? validMailto(_encoded.slice(7)) : validTel(_encoded.slice(4));
    return _ok === true ? _encoded : null;
  }
  if (_name !== 'http' && _name !== 'https') {
    // другая схема (javascript:, data:, file:, ftp: …) недопустима; «host:порт» — адрес без схемы
    if (_name !== null && /^[^:/?#]+:\d+(?:[/?#]|$)/.test(_str) === false) {
      return null;
    }
    _str = (_str.slice(0, 2) === '//' ? 'https:' : 'https://') + _str;
  }
  // хост пишется как в значении (IDN — буквами), после хоста — только «/», «?» или «#»
  var _parts = /^(https?:\/\/)([^/?#\\]*)([/?#][\s\S]*)?$/i.exec(_str);
  if (_parts === null || _parts[2] === '') {
    return null;
  }
  var _url = _parts[1] + _parts[2] + encodeUnsafe(_parts[3] || '');
  var _parsed;
  try {
    _parsed = new URL(_url);
  }
  catch (e) {
    return null;
  }
  if (_parsed.username !== '' || _parsed.password !== '' || validDomain(_parsed.hostname) === false) {
    return null;
  }
  return _url;
}

function isValidUrl (value) {
  return normalizeUrl(value) !== null;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. preprocess

var XML_ENTITIES = { lt : '<', gt : '>', quot : '"', apos : '\'', amp : '&' };

/** Сущности XML раскрываются за один проход: «&#38;amp;» даёт «&amp;», а не «&» */
function unescapeXml (str) {
  return str.replace(/&(?:(lt|gt|quot|apos|amp)|#x([0-9a-f]+)|#(\d+));/gi, function (all, name, hex, dec) {
    if (name !== undefined) {
      var _char = XML_ENTITIES[name];
      return _char === undefined ? all : _char;
    }
    var _code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return _code > 0x10FFFF ? all : String.fromCodePoint(_code);
  });
}

function escapeXml (str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Метка, закодированная редактором («%7Bd.url%7D»), — обычная метка */
function decodeMarkers (value) {
  return value.replace(/%7B((?:(?!%7[BD])[^{}])*)%7D/gi, function (all, inner) {
    var _inner = decode(inner);
    if (_inner === null || /^\s*[dc](?=[\s.[:])/.test(_inner) === false || /["'<>&{}]/.test(_inner) === true) {
      return all;
    }
    return '{' + _inner + '}';
  });
}

/**
 * Метка в адресе: «:defaultURL(x)» → последний «:__url(x)», иначе дописывается «:__url». Сущности XML в тексте
 * метки раскрываются (метка не попадает в документ; литерал «'…&amp;…'» — это «&»), кавычки и < > — %XX.
 */
function markLinkMarker (inner) {
  var _inner = unescapeXml(inner).replace(/["<>]/g, function (ch) {
    return encodeURIComponent(ch);
  }).replace(/\s+$/, '');
  var _chain = splitChain(_inner);
  var _kept = [_chain[0]];
  var _fallback = null;
  for (var i = 1; i < _chain.length; i++) {
    var _match = DEFAULT_URL.exec(_chain[i]);
    if (_match === null) {
      _kept.push(_chain[i]);
    }
    else {
      _fallback = _match[1] !== undefined && _match[1].trim() !== '' ? _match[1] : '\'\'';
    }
  }
  return '{' + _kept.join(':') + ':__url' + (_fallback !== null ? '(' + _fallback + ')' : '') + '}';
}

/** Новый адрес с метками ссылки или null, если меток ссылки в нём нет */
function markAddress (value) {
  var _found = false;
  var _out = decodeMarkers(value).replace(/\{(\s*[dc](?=[\s.[:}])[^{}]*)\}/g, function (all, inner) {
    if (NOT_LINK_MARKER.test(inner) === true) {
      return all;
    }
    _found = true;
    return markLinkMarker(inner);
  });
  return _found === true ? OPEN + _out + CLOSE : null;
}

/** Позиции адресов ссылок файла { start, end } (значения атрибутов) */
function addressRanges (xml, root) {
  var _ranges = [];
  xmltree.descendants(root, ['Relationship', 'text:a', 'draw:a']).forEach(function (el) {
    var _name = 'xlink:href';
    if (el.name === 'Relationship') {
      if (/\/hyperlink$/.test(xmltree.attr(xml, el, 'Type') || '') === false) {
        return;
      }
      _name = 'Target';
    }
    var _range = xmltree.attrRange(xml, el, _name);
    if (_range !== null) {
      _ranges.push(_range);
    }
  });
  return _ranges;
}

/**
 * Подготовить метки в адресах ссылок файла шаблона (до сборки)
 * @param {Object} file  файл шаблона { name, data, isMarked } (data меняется)
 */
function preprocess (file) {
  if (file === null || file === undefined || typeof file.data !== 'string' || HINT.test(file.data) === false) {
    return;
  }
  var _xml = file.data;
  var _edits = [];
  addressRanges(_xml, xmltree.parse(_xml).root).forEach(function (range) {
    var _rep = markAddress(_xml.slice(range.start, range.end));
    if (_rep !== null) {
      _edits.push({ start : range.start, end : range.end, rep : _rep });
    }
  });
  if (_edits.length > 0) {
    file.data = xmltree.applyEdits(_xml, _edits);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. форматтеры

function encodeValue (value) {
  if (value === null || value === undefined) {
    return '';
  }
  return encodeURIComponent(String(value).toWellFormed());
}

/**
 * Служебный последний форматтер метки в адресе ссылки: жетон со значением (и запасным адресом :defaultURL)
 * @param  {*} d
 * @param  {*} [fallback]  аргумент :defaultURL (есть, только если он был в метке)
 */
function __url (d, fallback) {
  var _token = T_OPEN + encodeValue(d);
  if (arguments.length > 1) {
    _token += T_FALLBACK + encodeValue(fallback);
  }
  return _token + T_CLOSE;
}

/**
 * Адрес по умолчанию: значение, если это допустимый адрес, иначе аргумент. В адресе ссылки заменяет адрес
 * целиком и сам проверяется (недопустимый — «#»), см. preprocess/apply.
 * @param  {*} d
 * @param  {*} fallback  адрес по умолчанию
 */
function defaultURL (d, fallback) {
  return isValidUrl(d) === true ? d : fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. apply

/** Итоговый адрес по тексту между OPEN и CLOSE (статика экранирована для XML, значения — в жетонах) */
function resolve (inner) {
  var _statics = [];
  var _values = [];
  var _fallback = null;
  var _last = 0;
  var _match;
  TOKEN_REGEX.lastIndex = 0;
  while ((_match = TOKEN_REGEX.exec(inner)) !== null) {
    _statics.push(unescapeXml(inner.slice(_last, _match.index)));
    _values.push(decode(_match[1]) || '');
    if (_match[2] !== undefined) {
      _fallback = decode(_match[2]) || '';
    }
    _last = _match.index + _match[0].length;
  }
  _statics.push(unescapeXml(inner.slice(_last)));
  var _candidate;
  if (_values.length === 1 && _statics[0].trim() === '' && _statics[1].trim() === '') {
    _candidate = _values[0];
  }
  else {
    _candidate = _statics[0];
    for (var i = 0; i < _values.length; i++) {
      _candidate += encodeURIComponent(_values[i]) + _statics[i + 1];
    }
  }
  var _url = normalizeUrl(_candidate);
  var _empty = _values.length > 0 && _values.every(function (v) {
    return v.trim() === '';
  });
  if (_fallback !== null && (_url === null || _empty === true)) {
    return normalizeUrl(_fallback) || '#';
  }
  return _url || '#';
}

/**
 * Перед сборкой (buildXML): метке ссылки — исходный вид для ошибок (source: «:__url(x)» → «:defaultURL(x)»)
 * @param  {String}  xml      xml файла без меток
 * @param  {Array}   markers  метки сборки
 * @return {Boolean} есть ли в файле адреса ссылок (нужен apply)
 */
function prepare (xml, markers) {
  var _found = typeof xml === 'string' && xml.indexOf(OPEN) !== -1;
  for (var i = 0; i < markers.length; i++) {
    var _name = markers[i].source || markers[i].name;
    if (/:\s*__url\b/.test(_name) === true) {
      _found = true;
      markers[i].source = _name.replace(/:\s*__url(?:\(([\s\S]*)\))?\s*$/, function (all, args) {
        return args !== undefined ? ':defaultURL(' + args + ')' : '';
      });
    }
  }
  return _found;
}

/**
 * Проверить и напечатать адреса ссылок собранного файла (после сборки)
 * @param  {String} xml
 * @return {String}
 */
function apply (xml) {
  if (typeof xml !== 'string' || (xml.indexOf(OPEN) === -1 && xml.indexOf(T_OPEN) === -1)) {
    return xml;
  }
  var _out = xml.replace(ADDRESS_REGEX, function (all, inner) {
    return escapeXml(resolve(inner));
  });
  // __url вне адреса ссылки (служебный форматтер, вписанный в текст вручную): каждое значение проверяется отдельно
  _out = _out.replace(TOKEN_REGEX, function (all) {
    return escapeXml(resolve(all));
  });
  return _out.split(OPEN).join('').split(CLOSE).join('');
}

module.exports = {
  preprocess,
  prepare,
  apply,
  isValidUrl,
  normalizeUrl,
  formatters : { __url, defaultURL }
};
