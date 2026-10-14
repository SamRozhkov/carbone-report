// Графики ECharts (:chart, 2.6.0) — своя реализация (чистая комната) по открытой документации carbone.io
// (раздел Charts, «ECharts 5») и спецификации carbone-reports §35.1–35.2.
//
// Значение метки — { type?, width?, height?, theme?, option } или голое описание ECharts с series (удобно для SQL);
// строка разбирается как JSON. parse проверяет значение и лимиты, render рисует ECharts 5 в режиме SSR (SVG) и
// переводит SVG в PNG (resvg-js, масштаб 2; сторона больше 2000 px — масштаб 1) шрифтом Noto Sans из assets/fonts — шрифты сервера не используются.
// Ошибки — Error с текстом без метки: lib/media.js дописывает Source.
//
// Формат чисел конструктора (§35.4, решение R4 плана 2.6.0): в JSON нет функций, поэтому formatter/valueFormatter
// со строкой «cr:number:{"decimals":…,"thousands":…,"suffix":…}» заменяется функцией. Та же логика —
// packages/shared/src/charts.ts (formatChartNumber, chartNumberFormatter); примеры в тестах обеих сторон совпадают.

var path = require('path');
var htmlparser2 = require('htmlparser2');

var FONT_FAMILY = 'Noto Sans';
var FONT_FILES = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'].map(function (name) {
  return path.join(__dirname, '..', 'assets', 'fonts', name);
});
// любое семейство из описания (serif, Arial, …) рисуется Noto Sans: других шрифтов в базе resvg нет
var FONT_OPTIONS = {
  loadSystemFonts   : false,
  fontFiles         : FONT_FILES,
  defaultFontFamily : FONT_FAMILY,
  sansSerifFamily   : FONT_FAMILY,
  serifFamily       : FONT_FAMILY,
  monospaceFamily   : FONT_FAMILY,
  cursiveFamily     : FONT_FAMILY,
  fantasyFamily     : FONT_FAMILY
};
var TYPES = ['echarts@v5', 'echarts@v5a'];
var DEFAULT_TYPE = 'echarts@v5';
var SCALE = 2; // PNG в 2 раза больше логического размера: чёткость при печати
var LARGE_SIDE = 2000; // сторона больше — масштаб 1: растр 8000×8000 слишком тяжёл
// картинки — только data URI PNG, JPEG, GIF: иначе resvg читает файлы сервера (путь, file://, /dev/zero)
var DATA_IMAGE = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+\/]+=*)$/;
// тип в data URI должен совпадать с содержимым: иначе resvg мог бы распознать внутри, например, SVG
var IMAGE_SIGNATURES = {
  png  : [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  jpeg : [Buffer.from([0xFF, 0xD8, 0xFF])],
  gif  : [Buffer.from('GIF87a'), Buffer.from('GIF89a')]
};
var IMAGE_PREFIX = /^\s*image:\/\//i;
// SVG от ECharts SSR (5.6.0) перед resvg: разбор, проверка, своя запись. ECharts не экранирует кавычки и < > в
// значениях атрибутов (цвет, шрифт, адрес картинки), поэтому строка SSR не передаётся в resvg как есть
var SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'image', 'defs',
  'clipPath', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'filter', 'feDropShadow', 'title'
]);
var SVG_DROPPED = new Set(['style']); // ECharts пишет в <style> только :hover — на картинке не виден
var SVG_ROOT_XMLNS = { 'xmlns' : 'http://www.w3.org/2000/svg', 'xmlns:xlink' : 'http://www.w3.org/1999/xlink' };
var ATTR_NAME = /^[A-Za-z_][\w.:-]*$/;
var LOCAL_URL = /url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi;
var DEFAULT_SIZE = { width : 600, height : 400 }; // без width/height и без рамки (R3)
var NUMBER_PREFIX = 'cr:number:';
var NBSP = ' ';
var MAX_DEPTH = 64; // глубже маркеры формата не ищутся, значения передаются как есть

// лимиты §35.2; ms меняют только тесты
var LIMITS = { bytes : 1024 * 1024, points : 10000, series : 20, ms : 5000, minSize : 100, maxSize : 4000 };

var MSG = {
  notJson   : 'описание графика — не JSON',
  notObject : 'описание графика — объект { type, option } или описание ECharts с series',
  size      : 'width и height графика — от 100 до 4000 пикселей',
  theme     : 'theme графика — null, \'dark\' или объект темы ECharts',
  tooBig    : 'описание графика больше 1 МБ',
  series    : 'в графике больше 20 рядов',
  points    : 'в графике больше 10 000 точек',
  slow      : 'график рисуется дольше 5 с',
  image     : 'график: картинки в описании — только data:image/png|jpeg|gif;base64',
  svg       : 'график: недопустимое содержимое SVG'
};

function badType (type) {
  return 'неизвестный тип графика «' + type + '» (echarts@v5 или echarts@v5a)';
}

// ECharts и resvg-js загружаются при первом графике: шаблоны без :chart за них не платят
var _echarts = null;
var _Resvg = null;

function echartsLib () {
  if (_echarts === null) {
    _echarts = require('echarts');
  }
  return _echarts;
}

function ResvgClass () {
  if (_Resvg === null) {
    _Resvg = require('@resvg/resvg-js').Resvg;
  }
  return _Resvg;
}

function isObject (value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false;
}

function reason (error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
}

/** width/height из значения: null — не задан; число 100–4000 (дробное округляется) */
function sizeValue (value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || Number.isFinite(value) === false || value < LIMITS.minSize || value > LIMITS.maxSize) {
    throw new Error(MSG.size);
  }
  return Math.round(value);
}

function themeValue (value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === 'dark' || isObject(value) === true) {
    return value;
  }
  throw new Error(MSG.theme);
}

function seriesOf (option) {
  if (Array.isArray(option.series) === true) {
    return option.series;
  }
  return isObject(option.series) === true ? [option.series] : [];
}

/** Точки: длины series[].data и строки dataset.source (R9) */
function countPoints (option, series) {
  var _points = 0;
  series.forEach(function (item) {
    if (isObject(item) === true && Array.isArray(item.data) === true) {
      _points += item.data.length;
    }
  });
  var _datasets = Array.isArray(option.dataset) === true ? option.dataset : (isObject(option.dataset) === true ? [option.dataset] : []);
  _datasets.forEach(function (dataset) {
    if (isObject(dataset) === false) {
      return;
    }
    if (Array.isArray(dataset.source) === true) {
      _points += dataset.source.length;
    }
    else if (isObject(dataset.source) === true) {
      Object.keys(dataset.source).forEach(function (key) {
        if (Array.isArray(dataset.source[key]) === true) {
          _points += dataset.source[key].length;
        }
      });
    }
  });
  return _points;
}

/**
 * Значение метки :chart → описание графика или null (пусто — заглушка удаляется)
 * @param  {Mixed} value  объект или строка JSON
 * @return {Object|null}  { type, width, height, theme, option }
 */
function parse (value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  var _value = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > LIMITS.bytes) {
      throw new Error(MSG.tooBig);
    }
    try {
      _value = JSON.parse(value);
    }
    catch (e) {
      throw new Error(MSG.notJson);
    }
  }
  if (isObject(_value) === false) {
    throw new Error(MSG.notObject);
  }
  var _chart;
  if (_value.type !== undefined || _value.option !== undefined) {
    _chart = {
      type   : _value.type === undefined || _value.type === null ? DEFAULT_TYPE : _value.type,
      width  : sizeValue(_value.width),
      height : sizeValue(_value.height),
      theme  : themeValue(_value.theme),
      option : _value.option
    };
  }
  else if (_value.series !== undefined) {
    // голое описание ECharts: так его удобно собрать в SQL (json_build_object)
    _chart = { type : DEFAULT_TYPE, width : null, height : null, theme : null, option : _value };
  }
  else {
    throw new Error(MSG.notObject);
  }
  if (TYPES.indexOf(_chart.type) === -1) {
    throw new Error(badType(String(_chart.type)));
  }
  if (isObject(_chart.option) === false) {
    throw new Error(MSG.notObject);
  }
  var _json;
  try {
    _json = JSON.stringify(_value);
  }
  catch (e) {
    throw new Error(MSG.notJson);
  }
  if (Buffer.byteLength(_json, 'utf8') > LIMITS.bytes) {
    throw new Error(MSG.tooBig);
  }
  var _series = seriesOf(_chart.option);
  if (_series.length > LIMITS.series) {
    throw new Error(MSG.series);
  }
  if (countPoints(_chart.option, _series) > LIMITS.points) {
    throw new Error(MSG.points);
  }
  checkImages(_chart.option);
  checkImages(_chart.theme);
  return _chart;
}

/**
 * Число по формату конструктора: decimals (округление; null — как есть), thousands (тысячи через U+00A0),
 * suffix (через U+00A0); десятичный разделитель — запятая. Экспоненциальная запись (1e+21) — как есть
 */
function formatNumber (value, format) {
  var _fixed = format.decimals === null || format.decimals === undefined ? String(value) : value.toFixed(format.decimals);
  var _match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(_fixed);
  var _text = _fixed;
  if (_match !== null) {
    var _int = format.thousands === true ? _match[2].replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : _match[2];
    _text = _match[1] + _int + (_match[3] !== undefined ? ',' + _match[3] : '');
  }
  return typeof format.suffix === 'string' && format.suffix !== '' ? _text + NBSP + format.suffix : _text;
}

/**
 * Функция для formatter/valueFormatter из маркера «cr:number:{…}» или null (не маркер, неверный формат).
 * Принимает число (ось, подсказка) или параметры подписи ECharts ({ value, name, seriesType }).
 */
function numberFormatter (ref) {
  if (typeof ref !== 'string' || ref.indexOf(NUMBER_PREFIX) !== 0) {
    return null;
  }
  var _raw;
  try {
    _raw = JSON.parse(ref.slice(NUMBER_PREFIX.length));
  }
  catch (e) {
    return null;
  }
  if (isObject(_raw) === false) {
    return null;
  }
  var _decimals = _raw.decimals === undefined ? null : _raw.decimals;
  if (_decimals !== null && (Number.isInteger(_decimals) === false || _decimals < 0 || _decimals > 6)) {
    return null;
  }
  if (_raw.thousands !== undefined && typeof _raw.thousands !== 'boolean') {
    return null;
  }
  if (_raw.suffix !== undefined && (typeof _raw.suffix !== 'string' || _raw.suffix.length > 10)) {
    return null;
  }
  var _format = { decimals : _decimals, thousands : _raw.thousands === true, suffix : _raw.suffix === undefined ? '' : _raw.suffix };
  return function (x) {
    if (typeof x === 'number') {
      return formatNumber(x, _format);
    }
    if (isObject(x) === true) {
      var _value = Array.isArray(x.value) === true ? x.value[x.value.length - 1] : x.value;
      var _text = typeof _value === 'number' ? formatNumber(_value, _format) : (_value === null || _value === undefined ? '' : String(_value));
      return x.seriesType === 'pie' ? String(x.name === null || x.name === undefined ? '' : x.name) + ': ' + _text : _text;
    }
    return x === null || x === undefined ? '' : String(x);
  };
}

/** Копия описания: маркеры формата → функции, ключ __proto__ отброшен; данные отчёта не меняются */
function revive (value, depth) {
  if (Array.isArray(value) === true) {
    return depth >= MAX_DEPTH ? value : value.map(function (item) {
      return revive(item, depth + 1);
    });
  }
  if (isObject(value) === false || depth >= MAX_DEPTH) {
    return value;
  }
  var _out = {};
  Object.keys(value).forEach(function (key) {
    if (key === '__proto__') {
      return;
    }
    var _fn = key === 'formatter' || key === 'valueFormatter' ? numberFormatter(value[key]) : null;
    _out[key] = _fn !== null ? _fn : revive(value[key], depth + 1);
  });
  return _out;
}

/**
 * Описание для setOption: без анимации, белый фон (если его не задают описание или тема), Noto Sans по умолчанию
 * @param  {Object} chart  результат parse
 * @return {Object}
 */
function buildOption (chart) {
  var _option = revive(chart.option, 0);
  _option.animation = false;
  var _themeBackground = chart.theme === 'dark' || (isObject(chart.theme) === true && chart.theme.backgroundColor !== undefined);
  if (_option.backgroundColor === undefined && _themeBackground === false) {
    _option.backgroundColor = '#ffffff';
  }
  var _textStyle = isObject(_option.textStyle) === true ? _option.textStyle : {};
  if (_textStyle.fontFamily === undefined) {
    _option.textStyle = Object.assign({}, _textStyle, { fontFamily : FONT_FAMILY });
  }
  return _option;
}

/** Сторона рамки в px, зажатая в 100–4000; не число (NaN, нет поля, ±Infinity) — сторона по умолчанию (R3) */
function clampSize (px, fallback) {
  if (typeof px !== 'number' || isFinite(px) === false) {
    return fallback;
  }
  return Math.min(LIMITS.maxSize, Math.max(LIMITS.minSize, Math.round(px)));
}

/** Логический размер: width/height значения, иначе рамка заглушки (зажата в 100–4000), иначе 600×400 (R3) */
function sizeOf (chart, frame) {
  var _frame = frame !== null && frame !== undefined ? {
    width  : clampSize(frame.width, DEFAULT_SIZE.width),
    height : clampSize(frame.height, DEFAULT_SIZE.height)
  } : DEFAULT_SIZE;
  return {
    width  : chart.width !== null ? chart.width : _frame.width,
    height : chart.height !== null ? chart.height : _frame.height
  };
}

/** data URI картинки PNG, JPEG или GIF, у которой начало содержимого совпадает с заявленным типом */
function isSafeDataImage (value) {
  var _match = typeof value === 'string' ? DATA_IMAGE.exec(value) : null;
  if (_match === null) {
    return false;
  }
  var _head = Buffer.from(_match[2].slice(0, 16), 'base64');
  return IMAGE_SIGNATURES[_match[1]].some(function (signature) {
    return _head.subarray(0, signature.length).equals(signature);
  });
}

/** Картинка в описании: data URI или «image://» + data URI */
function isSafeImage (value) {
  return typeof value === 'string' && isSafeDataImage(value.indexOf('image://') === 0 ? value.slice(8) : value);
}

/**
 * Картинки в описании и теме: строки «image://…» и значения ключей image — только data URI PNG, JPEG, GIF,
 * иначе ошибка (не исправление). Обход без рекурсии: группы graphic вкладываются на любую глубину
 */
function checkImages (root) {
  var _stack = [root];
  var _seen = new Set();
  while (_stack.length > 0) {
    var _value = _stack.pop();
    if (_value === null || typeof _value !== 'object' || _seen.has(_value) === true) {
      if (typeof _value === 'string' && IMAGE_PREFIX.test(_value) === true && isSafeImage(_value) === false) {
        throw new Error(MSG.image);
      }
      continue;
    }
    _seen.add(_value);
    var _keys = Object.keys(_value);
    for (var i = 0; i < _keys.length; i++) {
      var _item = _value[_keys[i]];
      if (_keys[i] === 'image' && Array.isArray(_value) === false && isSafeImage(_item) === false) {
        throw new Error(MSG.image);
      }
      _stack.push(_item);
    }
  }
}

var XML_ESCAPES = { '&' : '&amp;', '<' : '&lt;', '>' : '&gt;', '"' : '&quot;' };

function escapeXml (text) {
  return /[&<>"]/.test(text) === false ? text : text.replace(/[&<>"]/g, function (c) {
    return XML_ESCAPES[c];
  });
}

/** Атрибуты элемента: имя, xmlns только у корня, href — data URI картинки, нет xml:* (кроме xml:space) и src, url() — только url(#id), без «\» */
function svgAttributes (node, isRoot) {
  var _out = '';
  Object.keys(node.attribs).forEach(function (name) {
    var _value = node.attribs[name];
    if (ATTR_NAME.test(name) === false || _value.indexOf('\\') !== -1) {
      throw new Error(MSG.svg);
    }
    if (name === 'xmlns' || name.indexOf('xmlns:') === 0) {
      if (isRoot === false || SVG_ROOT_XMLNS[name] !== _value) {
        throw new Error(MSG.svg);
      }
    }
    var _local = name.slice(name.lastIndexOf(':') + 1).toLowerCase();
    // xml:base меняет базу адресов, src — второй путь к ресурсу; xml:space ECharts пишет в <text>
    if ((name.toLowerCase().indexOf('xml:') === 0 && name !== 'xml:space') || _local === 'src') {
      throw new Error(MSG.svg);
    }
    if (_local === 'href' && isSafeDataImage(_value) === false) {
      throw new Error(MSG.image);
    }
    if (/url/i.test(_value) === true && /url\s*\(/i.test(_value.replace(LOCAL_URL, '')) === true) {
      throw new Error(MSG.svg);
    }
    _out += ' ' + name + '="' + escapeXml(_value) + '"';
  });
  return _out;
}

/** Узел дерева → SVG: только разрешённые элементы и текст; прочее (комментарии, CDATA, инструкции) — ошибка */
function svgNode (node, isRoot) {
  if (node.type === 'text') {
    return escapeXml(node.data);
  }
  if (node.type !== 'tag' && node.type !== 'style' && node.type !== 'script') {
    throw new Error(MSG.svg);
  }
  if (SVG_DROPPED.has(node.name) === true && isRoot === false) {
    return '';
  }
  if (SVG_ELEMENTS.has(node.name) === false || (isRoot === true) !== (node.name === 'svg')) {
    throw new Error(MSG.svg);
  }
  var _children = svgChildren(node);
  var _open = '<' + node.name + svgAttributes(node, isRoot);
  return _children === '' ? _open + '/>' : _open + '>' + _children + '</' + node.name + '>';
}

function svgChildren (node) {
  var _out = '';
  for (var i = 0; i < node.children.length; i++) {
    _out += svgNode(node.children[i], false);
  }
  return _out;
}

/**
 * SVG ECharts для resvg: разбор (htmlparser2, XML), проверка элементов и атрибутов, запись из проверенного дерева —
 * resvg получает ровно то, что проверено. Картинки — только data URI PNG, JPEG, GIF
 */
function safeSvg (svg) {
  var _doc = htmlparser2.parseDocument(svg, { xmlMode : true, decodeEntities : true });
  var _roots = _doc.children.filter(function (node) {
    return node.type !== 'text' || node.data.trim() !== '';
  });
  if (_roots.length !== 1) {
    throw new Error(MSG.svg);
  }
  return svgNode(_roots[0], true);
}

function scaleOf (size) {
  return Math.max(size.width, size.height) > LARGE_SIDE ? 1 : SCALE;
}

function checkTime (started) {
  if (Date.now() - started > LIMITS.ms) {
    throw new Error(MSG.slow);
  }
}

/**
 * PNG графика: ECharts 5 SSR (SVG, без анимации) → resvg-js (масштаб 2, сторона больше 2000 px — 1; только Noto Sans;
 * картинки — только data URI; SVG разобран, проверен и записан заново — safeSvg)
 * @param  {Object}      chart  результат parse (не null)
 * @param  {Object|null} frame  рамка заглушки { width, height } в px при 96 dpi
 * @return {Object} { buffer, width, height } — размеры PNG в px
 */
function render (chart, frame) {
  var _size = sizeOf(chart, frame);
  var _started = Date.now();
  var _instance = null;
  var _svg;
  try {
    _instance = echartsLib().init(null, chart.theme, { renderer : 'svg', ssr : true, width : _size.width, height : _size.height });
    _instance.setOption(buildOption(chart));
    _svg = _instance.renderToSVGString();
  }
  catch (e) {
    throw new Error('график: ' + reason(e));
  }
  finally {
    // без dispose таймеры zrender держат поток рендера
    if (_instance !== null) {
      _instance.dispose();
    }
  }
  checkTime(_started);
  var _safe;
  try {
    _safe = safeSvg(_svg);
  }
  catch (e) {
    // свои ошибки — как есть; прочее (например, переполнение стека на глубокой вложенности) — общая ошибка SVG
    throw e instanceof Error && e.message.indexOf('график: ') === 0 ? e : new Error(MSG.svg);
  }
  var _scale = scaleOf(_size);
  var _png;
  try {
    var _Resvg = ResvgClass();
    _png = new _Resvg(_safe, { fitTo : { mode : 'zoom', value : _scale }, font : FONT_OPTIONS }).render().asPng();
  }
  catch (e) {
    throw new Error('график: ' + reason(e));
  }
  checkTime(_started);
  return { buffer : _png, width : _size.width * _scale, height : _size.height * _scale };
}

module.exports = {
  parse,
  render,
  buildOption,
  formatNumber,
  numberFormatter,
  LIMITS,
  NUMBER_PREFIX,
  FONT_FAMILY,
  FONT_FILES
};
