// :html (2.5.0, спецификация §34.3–34.4): разбор HTML из данных в независимую от формата модель. Своя реализация
// (чистая комната) по открытой документации carbone.io; запись модели в DOCX — lib/html-docx.js, в ODT — lib/html-odt.js.
//
// Разбор — htmlparser2 (Parser, поток событий; decodeEntities, lowerCaseTags). Парсер сам закрывает незакрытые и
// перекрёстные теги («<b><i>x</b></i>»: «</b>» закрывает i и b, лишний «</i>» пропускается), так что открытия и
// закрытия приходят парами. Сущности декодирует он же: именованные, «&#169;», «&#x1F600;»; «&nbsp;» остаётся U+00A0.
//
// Модель (её читают Task 4–8, поля есть всегда — объекты сравнимы deepStrictEqual):
//   Inline = { type: 'text', text, marks: Marks } | { type: 'break' }
//          | { type: 'image', src, width: number|null, height: number|null } | { type: 'checkbox', checked }
//          | { type: 'link', href, children: Inline[] }            — внутри ссылки ссылок нет
//   Marks  = { bold, italic, underline, strike, sup, sub, mark, mono: boolean, color, background: 'RRGGBB'|null }
//            — у каждого текста свой полный объект; соседние тексты с одинаковым оформлением склеиваются;
//   Block  = { type: 'para', inlines } | { type: 'heading', level: 1..6, inlines } | { type: 'pre', lines: Inline[][] }
//          | { type: 'hr' } | { type: 'list', ordered, items: { blocks: Block[], checkbox: boolean|null }[] }
//          | { type: 'table', rows: { cells: { header, colspan, rowspan, blocks: Block[] }[] }[], caption: Inline[]|null }
//            — у каждого блока ещё quote (число, по умолчанию 0), breakBefore и breakAfter (false по умолчанию).
//
// Правила:
//   - пробелы как в браузере: подряд идущие пробельные символы (пробел, \t, \n, \r, \f; «&#9;» тоже) — один пробел,
//     в начале и в конце блока и вокруг br обрезаются; текст только из пробелов вне абзаца отбрасывается; U+00A0 не
//     схлопывается; пустые абзацы (и p без текста) не создаются; последний br абзаца отбрасывается, если в абзаце
//     есть что-то ещё («<p><br></p>» — абзац с одним переносом);
//   - текст вне блоков — абзац; блок внутри абзаца закрывает его, текст после — новый абзац;
//   - div, section, article, header, footer, main, nav, aside, figure, figcaption, address, body, html — границы
//     абзацев (сами блоков не дают); прочие неизвестные теги (span, font, …) — только текст; script, style, head,
//     title — вместе с содержимым;
//   - quote — число blockquote вокруг блока внутри ближайшего контейнера (корень, пункт списка, ячейка): блоки в
//     пункте списка или ячейке считают уровень от 0, сам список или таблица получают уровень своего места;
//   - pre: текст как есть (табуляция остаётся «\t»), строки — по «\n» и br; первый перенос сразу после <pre> и
//     пустая последняя строка отбрасываются; внутри pre работают только теги оформления, a и br — прочие теги дают
//     только текст; тексту pre ставится mono (как code);
//   - th: header true и жирный текст (bold в marks) — писателям не нужно делать его жирным отдельно;
//   - списки: текст прямо в ul/ol — свой пункт; ul/ol прямо в ul/ol — в блоки предыдущего пункта (если его нет —
//     новый пункт), текст после него до следующего li — туда же; флажок input type=checkbox до любого содержимого пункта —
//     item.checkbox (true/false), в остальных местах — Inline checkbox; пустой список отбрасывается;
//   - таблицы: thead/tbody/tfoot прозрачны; tr вне строки и td вне строки создают недостающие; строки без ячеек и
//     таблицы без строк отбрасываются (подпись такой таблицы — абзацем); colspan 1…1000, rowspan 1…65534, неверное
//     значение — 1; caption — Inline[] таблицы (писатель ставит её абзацем перед таблицей), блоки внутри — пробел;
//   - ссылки: a с href (как есть, без пробелов по краям; проверка — в писателе по §32.5) — Inline link; a без href —
//     текст; вложенная a — текст внешней ссылки; ссылка через границу блока продолжается в следующем абзаце;
//   - img: src как есть (без пробелов по краям; загрузка — в писателе), без src — пропуск; width/height — целые px
//     (атрибут «120» или «120px»), «50%» и прочее — null;
//   - style (только атрибут): color и background-color — на текст внутри элемента (в том числе p, td, li);
//     у mark свой background-color пропускается (заливка mark — mark: true); break-before: page и break-after: page —
//     у блочных элементов (p, h1–h6, pre, hr, ul, ol, table, blockquote и границ вроде div): «до» — у первого блока,
//     созданного после открытия, «после» — у последнего блока, созданного до закрытия; прочие свойства и неверные
//     значения пропускаются;
//   - ограничения: больше 1 МБ (UTF-8) или вложенность открытых тегов больше 32 (пустые теги вроде br считаются
//     на своём уровне) — ошибка шаблона.
//
// inlineOnly (параметр inline): плоский Inline[] — работают только a, b, strong, em, i, s, del, u; прочие теги
// отбрасываются (текст остаётся), br и границы блоков — пробел, pre — как обычный текст (переносы — пробелы);
// изображения и флажки пропускаются.

var htmlparser2 = require('htmlparser2');

var MAX_BYTES = 1024 * 1024;
var MAX_DEPTH = 32;
var MAX_COLSPAN = 1000;
var MAX_ROWSPAN = 65534;

var MSG = {
  tooBig  : 'html: значение больше 1 МБ.',
  tooDeep : 'html: вложенность тегов больше 32.'
};

var templateError = require('./html-xml').templateError;

// ---------------------------------------------------------------------------------------------------------------
// Параметры форматтера

var OPTION_FLAGS = ['inline', 'nospace'];
var OPTION_THEMES = ['headingtheme', 'tabletheme', 'quotetheme'];

function unquote (value) {
  var _match = /^'([\s\S]*)'$/.exec(value);
  return _match !== null ? _match[1].trim() : value;
}

/**
 * Параметры :html — «inline», «nospace», «headingtheme:<префикс>», «tabletheme:<стиль>», «quotetheme:<стиль>»
 * @param  {String[]} args   аргументы форматтера (каждый может содержать несколько параметров через запятую)
 * @param  {String}   source метка (для ошибки)
 * @return {Object}          { inline, nospace, headingtheme, tabletheme, quotetheme }
 */
function parseOptions (args, source) {
  var _options = { inline : false, nospace : false, headingtheme : null, tabletheme : null, quotetheme : null };
  (args || []).forEach(function (arg) {
    String(arg).split(',').forEach(function (part) {
      var _part = part.trim();
      if (_part === '') {
        return;
      }
      var _colon = _part.indexOf(':');
      var _name = (_colon === -1 ? _part : _part.slice(0, _colon)).trim().toLowerCase();
      if (OPTION_FLAGS.indexOf(_name) !== -1 && _colon === -1) {
        _options[_name] = true;
        return;
      }
      if (OPTION_THEMES.indexOf(_name) !== -1) {
        var _value = _colon === -1 ? '' : unquote(_part.slice(_colon + 1).trim());
        if (_value === '') {
          throw templateError('html: у параметра «' + _name + '» нет значения.', source);
        }
        _options[_name] = _value;
        return;
      }
      throw templateError('html: неизвестный параметр «' + _part + '».', source);
    });
  });
  return _options;
}

// ---------------------------------------------------------------------------------------------------------------
// Цвета CSS

// 148 именованных цветов CSS (CSS Color Module Level 4)
var NAMED_COLORS = {
  aliceblue : 'F0F8FF', antiquewhite : 'FAEBD7', aqua : '00FFFF', aquamarine : '7FFFD4', azure : 'F0FFFF',
  beige : 'F5F5DC', bisque : 'FFE4C4', black : '000000', blanchedalmond : 'FFEBCD', blue : '0000FF',
  blueviolet : '8A2BE2', brown : 'A52A2A', burlywood : 'DEB887', cadetblue : '5F9EA0', chartreuse : '7FFF00',
  chocolate : 'D2691E', coral : 'FF7F50', cornflowerblue : '6495ED', cornsilk : 'FFF8DC', crimson : 'DC143C',
  cyan : '00FFFF', darkblue : '00008B', darkcyan : '008B8B', darkgoldenrod : 'B8860B', darkgray : 'A9A9A9',
  darkgreen : '006400', darkgrey : 'A9A9A9', darkkhaki : 'BDB76B', darkmagenta : '8B008B', darkolivegreen : '556B2F',
  darkorange : 'FF8C00', darkorchid : '9932CC', darkred : '8B0000', darksalmon : 'E9967A', darkseagreen : '8FBC8F',
  darkslateblue : '483D8B', darkslategray : '2F4F4F', darkslategrey : '2F4F4F', darkturquoise : '00CED1',
  darkviolet : '9400D3', deeppink : 'FF1493', deepskyblue : '00BFFF', dimgray : '696969', dimgrey : '696969',
  dodgerblue : '1E90FF', firebrick : 'B22222', floralwhite : 'FFFAF0', forestgreen : '228B22', fuchsia : 'FF00FF',
  gainsboro : 'DCDCDC', ghostwhite : 'F8F8FF', gold : 'FFD700', goldenrod : 'DAA520', gray : '808080',
  green : '008000', greenyellow : 'ADFF2F', grey : '808080', honeydew : 'F0FFF0', hotpink : 'FF69B4',
  indianred : 'CD5C5C', indigo : '4B0082', ivory : 'FFFFF0', khaki : 'F0E68C', lavender : 'E6E6FA',
  lavenderblush : 'FFF0F5', lawngreen : '7CFC00', lemonchiffon : 'FFFACD', lightblue : 'ADD8E6',
  lightcoral : 'F08080', lightcyan : 'E0FFFF', lightgoldenrodyellow : 'FAFAD2', lightgray : 'D3D3D3',
  lightgreen : '90EE90', lightgrey : 'D3D3D3', lightpink : 'FFB6C1', lightsalmon : 'FFA07A',
  lightseagreen : '20B2AA', lightskyblue : '87CEFA', lightslategray : '778899', lightslategrey : '778899',
  lightsteelblue : 'B0C4DE', lightyellow : 'FFFFE0', lime : '00FF00', limegreen : '32CD32', linen : 'FAF0E6',
  magenta : 'FF00FF', maroon : '800000', mediumaquamarine : '66CDAA', mediumblue : '0000CD',
  mediumorchid : 'BA55D3', mediumpurple : '9370DB', mediumseagreen : '3CB371', mediumslateblue : '7B68EE',
  mediumspringgreen : '00FA9A', mediumturquoise : '48D1CC', mediumvioletred : 'C71585', midnightblue : '191970',
  mintcream : 'F5FFFA', mistyrose : 'FFE4E1', moccasin : 'FFE4B5', navajowhite : 'FFDEAD', navy : '000080',
  oldlace : 'FDF5E6', olive : '808000', olivedrab : '6B8E23', orange : 'FFA500', orangered : 'FF4500',
  orchid : 'DA70D6', palegoldenrod : 'EEE8AA', palegreen : '98FB98', paleturquoise : 'AFEEEE',
  palevioletred : 'DB7093', papayawhip : 'FFEFD5', peachpuff : 'FFDAB9', peru : 'CD853F', pink : 'FFC0CB',
  plum : 'DDA0DD', powderblue : 'B0E0E6', purple : '800080', rebeccapurple : '663399', red : 'FF0000',
  rosybrown : 'BC8F8F', royalblue : '4169E1', saddlebrown : '8B4513', salmon : 'FA8072', sandybrown : 'F4A460',
  seagreen : '2E8B57', seashell : 'FFF5EE', sienna : 'A0522D', silver : 'C0C0C0', skyblue : '87CEEB',
  slateblue : '6A5ACD', slategray : '708090', slategrey : '708090', snow : 'FFFAFA', springgreen : '00FF7F',
  steelblue : '4682B4', tan : 'D2B48C', teal : '008080', thistle : 'D8BFD8', tomato : 'FF6347',
  turquoise : '40E0D0', violet : 'EE82EE', wheat : 'F5DEB3', white : 'FFFFFF', whitesmoke : 'F5F5F5',
  yellow : 'FFFF00', yellowgreen : '9ACD32'
};

// регулярные выражения без соседних повторов, которые могут съесть одни и те же символы (линейное время на
// данных отчёта: длинные числа и пробелы)
var NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?';
var FUNC_REGEX = /^(rgba?|hsla?)\(([^()]*)\)$/;
var NUMBER_UNIT_REGEX = new RegExp('^(' + NUMBER + ')(%|deg|grad|rad|turn)?$');

function hex2 (value) {
  var _byte = Math.round(Math.min(255, Math.max(0, value)));
  return (_byte < 16 ? '0' : '') + _byte.toString(16).toUpperCase();
}

// аргументы rgb()/hsl(): «a b c», «a b c / alpha», «a, b, c», «a, b, c, alpha» → [{ value, unit }] (alpha отброшена)
function funcArgs (body) {
  var _parts;
  if (body.indexOf(',') !== -1) {
    _parts = body.split(',').map(function (part) {
      return part.trim();
    });
    if (_parts.length === 4) {
      _parts.pop();
    }
  }
  else {
    var _slash = body.split('/');
    if (_slash.length > 2) {
      return null;
    }
    _parts = _slash[0].trim().split(/\s+/);
  }
  if (_parts.length !== 3) {
    return null;
  }
  var _args = [];
  for (var i = 0; i < 3; i++) {
    var _match = NUMBER_UNIT_REGEX.exec(_parts[i]);
    if (_match === null) {
      return null;
    }
    var _number = parseFloat(_match[1]);
    if (!Number.isFinite(_number)) {
      return null; // 1e999
    }
    _args.push({ value : _number, unit : _match[2] || '' });
  }
  return _args;
}

function rgbColor (args) {
  var _channels = [];
  for (var i = 0; i < 3; i++) {
    if (args[i].unit === '%') {
      _channels.push(args[i].value * 255 / 100);
    }
    else if (args[i].unit === '') {
      _channels.push(args[i].value);
    }
    else {
      return null;
    }
  }
  return _channels.map(hex2).join('');
}

var HUE_UNITS = { '' : 1, deg : 1, grad : 0.9, rad : 180 / Math.PI, turn : 360 };

function hslColor (args) {
  if (args[0].unit === '%' || args[1].unit !== '%' && args[1].unit !== '' || args[2].unit !== '%' && args[2].unit !== '') {
    return null;
  }
  var _hue = ((args[0].value * HUE_UNITS[args[0].unit]) % 360 + 360) % 360;
  var _saturation = Math.min(100, Math.max(0, args[1].value)) / 100;
  var _lightness = Math.min(100, Math.max(0, args[2].value)) / 100;
  var _chroma = (1 - Math.abs(2 * _lightness - 1)) * _saturation;
  var _x = _chroma * (1 - Math.abs((_hue / 60) % 2 - 1));
  var _m = _lightness - _chroma / 2;
  var _rgb = [[_chroma, _x, 0], [_x, _chroma, 0], [0, _chroma, _x], [0, _x, _chroma], [_x, 0, _chroma], [_chroma, 0, _x]][Math.floor(_hue / 60) % 6];
  return _rgb.map(function (channel) {
    return hex2((channel + _m) * 255);
  }).join('');
}

/**
 * Цвет CSS → «RRGGBB» (верхний регистр) или null: #abc, #aabbcc, rgb()/rgba(), hsl()/hsla() (пробелы или запятые,
 * прозрачность отбрасывается), 148 именованных цветов
 * @param  {*} value значение свойства
 * @return {String|null}
 */
function cssColor (value) {
  if (typeof value !== 'string') {
    return null;
  }
  var _value = value.trim().toLowerCase();
  var _match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(_value);
  if (_match !== null) {
    var _hex = _match[1];
    if (_hex.length === 3) {
      _hex = _hex[0] + _hex[0] + _hex[1] + _hex[1] + _hex[2] + _hex[2];
    }
    return _hex.toUpperCase();
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, _value)) {
    return NAMED_COLORS[_value];
  }
  _match = FUNC_REGEX.exec(_value);
  if (_match === null) {
    return null;
  }
  var _args = funcArgs(_match[2].trim());
  if (_args === null) {
    return null;
  }
  return _match[1][0] === 'r' ? rgbColor(_args) : hslColor(_args);
}

// ---------------------------------------------------------------------------------------------------------------
// Атрибут style

/**
 * Свойства атрибута style, которые понимает модель
 * @return {Object} { color, background: 'RRGGBB'|undefined, breakBefore, breakAfter: boolean }
 */
function parseStyle (style) {
  var _result = { color : undefined, background : undefined, breakBefore : false, breakAfter : false };
  if (typeof style !== 'string') {
    return _result;
  }
  style.split(';').forEach(function (declaration) {
    var _colon = declaration.indexOf(':');
    if (_colon === -1) {
      return;
    }
    var _name = declaration.slice(0, _colon).trim().toLowerCase();
    var _value = declaration.slice(_colon + 1).trim().replace(/![ \t\n\r\f]*important$/i, '').trim();
    if (_name === 'color' || _name === 'background-color') {
      var _color = cssColor(_value);
      if (_color !== null) {
        _result[_name === 'color' ? 'color' : 'background'] = _color;
      }
    }
    else if ((_name === 'break-before' || _name === 'break-after') && _value.toLowerCase() === 'page') {
      _result[_name === 'break-before' ? 'breakBefore' : 'breakAfter'] = true;
    }
  });
  return _result;
}

// ---------------------------------------------------------------------------------------------------------------
// Строка Inline[]: склейка текста, пробелы, ссылки

var DEFAULT_MARKS = {
  bold : false, italic : false, underline : false, strike : false, sup : false, sub : false, mark : false, mono : false,
  color : null, background : null
};
var MARK_NAMES = Object.keys(DEFAULT_MARKS);

function sameMarks (a, b) {
  for (var i = 0; i < MARK_NAMES.length; i++) {
    if (a[MARK_NAMES[i]] !== b[MARK_NAMES[i]]) {
      return false;
    }
  }
  return true;
}

var WHITESPACE_REGEX = /[ \t\n\r\f]+/g;

/**
 * Накопитель Inline[] одного абзаца (строки pre, подписи таблицы, inlineOnly)
 * @param {Boolean} pre  без схлопывания и обрезки пробелов
 */
function InlineBuffer (pre) {
  this.pre = pre;
  this.inlines = [];
  this.link = null; // открытая ссылка: в неё идут новые Inline
  this.lastSpace = true; // в начале и после br и пробела пробел не нужен
  this.empty = true; // ничего, кроме пробелов, ещё не добавлено
}

InlineBuffer.prototype.target = function () {
  return this.link !== null ? this.link.children : this.inlines;
};

InlineBuffer.prototype.text = function (text, marks) {
  var _text = text;
  if (!this.pre) {
    _text = _text.replace(WHITESPACE_REGEX, ' ');
    if (this.lastSpace && _text[0] === ' ') {
      _text = _text.slice(1);
    }
  }
  if (_text === '') {
    return;
  }
  var _target = this.target();
  var _last = _target[_target.length - 1];
  if (_last !== undefined && _last.type === 'text' && sameMarks(_last.marks, marks)) {
    _last.text += _text;
  }
  else {
    _target.push({ type : 'text', text : _text, marks : Object.assign({}, marks) });
  }
  this.lastSpace = _text[_text.length - 1] === ' ';
  this.empty = false;
};

InlineBuffer.prototype.push = function (inline) {
  if (inline.type === 'break') {
    trimTail(this.inlines);
    this.lastSpace = true;
  }
  else {
    this.lastSpace = false;
  }
  this.target().push(inline);
  this.empty = false;
};

InlineBuffer.prototype.openLink = function (href) {
  this.link = { type : 'link', href : href, children : [] };
  this.inlines.push(this.link);
};

InlineBuffer.prototype.closeLink = function () {
  this.link = null;
};

/** Готовый Inline[]: без пробелов в конце, без пустых ссылок и без последнего br (если есть что-то ещё) */
InlineBuffer.prototype.finish = function () {
  this.link = null;
  if (this.pre) {
    return removeEmptyLinks(this.inlines);
  }
  trimTail(this.inlines);
  var _inlines = removeEmptyLinks(this.inlines);
  if (_inlines.length > 1 && _inlines[_inlines.length - 1].type === 'break') {
    _inlines.pop();
    trimTail(_inlines);
  }
  return _inlines;
};

function trimSpacesEnd (text) {
  var _end = text.length;
  while (_end > 0 && text[_end - 1] === ' ') {
    _end--;
  }
  return text.slice(0, _end);
}

// обрезать пробелы в конце (заходя в последнюю ссылку)
function trimTail (inlines) {
  while (inlines.length > 0) {
    var _last = inlines[inlines.length - 1];
    if (_last.type === 'text') {
      _last.text = trimSpacesEnd(_last.text);
      if (_last.text !== '') {
        return;
      }
    }
    else if (_last.type === 'link') {
      trimTail(_last.children);
      if (_last.children.length > 0) {
        return;
      }
    }
    else {
      return;
    }
    inlines.pop();
  }
}

function removeEmptyLinks (inlines) {
  return inlines.filter(function (inline) {
    return inline.type !== 'link' || inline.children.length > 0;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Теги

var SKIP_TAGS = { script : true, style : true, head : true, title : true };

// теги оформления текста → изменение Marks
var MARK_TAGS = {
  b : { bold : true }, strong : { bold : true }, i : { italic : true }, em : { italic : true },
  u : { underline : true }, s : { strike : true }, del : { strike : true }, sup : { sup : true }, sub : { sub : true },
  mark : { mark : true }, code : { mono : true }, kbd : { mono : true }, samp : { mono : true }
};

// в режиме inline работают только они
var INLINE_ONLY_MARKS = { b : true, strong : true, i : true, em : true, u : true, s : true, del : true };

// неизвестные блочные теги: только граница абзаца
var BOUNDARY_TAGS = {
  div : true, section : true, article : true, header : true, footer : true, main : true, nav : true, aside : true,
  figure : true, figcaption : true, address : true, body : true, html : true
};

var HEADING_TAGS = { h1 : 1, h2 : 2, h3 : 3, h4 : 4, h5 : 5, h6 : 6 };

// блочные теги для режима inline (граница — пробел)
var INLINE_SPACE_TAGS = Object.assign({
  p : true, pre : true, hr : true, blockquote : true, ul : true, ol : true, li : true, table : true, caption : true,
  tr : true, td : true, th : true, thead : true, tbody : true, tfoot : true, br : true
}, BOUNDARY_TAGS, HEADING_TAGS);

/** Разбор потоком событий htmlparser2 с проверкой размера и вложенности */
function runParser (html, source, handlers) {
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) {
    throw templateError(MSG.tooBig, source);
  }
  var _depth = 0;
  var _parser = new htmlparser2.Parser({
    onopentag : function (name, attribs) {
      _depth++;
      if (_depth > MAX_DEPTH) {
        throw templateError(MSG.tooDeep, source);
      }
      handlers.open(name, attribs);
    },
    onclosetag : function (name) {
      _depth--;
      handlers.close(name);
    },
    ontext : function (text) {
      handlers.text(text);
    }
  }, { decodeEntities : true, lowerCaseTags : true, lowerCaseAttributeNames : true });
  _parser.write(html);
  _parser.end();
}

function spanValue (value, max) {
  var _text = (value || '').trim();
  var _value = /^\d+$/.test(_text) ? parseInt(_text, 10) : 1;
  return _value >= 1 ? Math.min(_value, max) : 1;
}

function pixels (value) {
  var _match = /^(\d+(?:\.\d+)?)[ \t\n\r\f]*(?:px)?$/i.exec((value || '').trim());
  if (_match === null) {
    return null;
  }
  var _value = Math.round(parseFloat(_match[1]));
  return _value > 0 ? _value : null;
}

function blockOf (type, fields, quote) {
  return Object.assign({ type : type }, fields, { quote : quote, breakBefore : false, breakAfter : false });
}

// ---------------------------------------------------------------------------------------------------------------
// parse: Block[]
//
// Состояние — стек рамок (frames): «flow» — место для блоков (корень, пункт списка, ячейка; в нём открытый абзац
// para или pre и счётчик quote), «list», «table» (с текущей строкой) и «caption». Каждый элемент запоминает
// высоту стека при открытии и при закрытии снимает всё, что выше (так закрываются и неявные пункты и ячейки).

function Builder () {
  this.root = { kind : 'flow', blocks : [], quote : 0, para : null, pre : null, pending : false, item : null };
  this.frames = [this.root];
  this.elements = []; // открытые элементы: { marks, close }
  this.marks = DEFAULT_MARKS;
  this.links = []; // href открытой ссылки (вложенные a — только текст)
  this.skip = 0;
}

Builder.prototype.top = function () {
  return this.frames[this.frames.length - 1];
};

Builder.prototype.pushFlow = function (blocks, item) {
  var _flow = { kind : 'flow', blocks : blocks, quote : 0, para : null, pre : null, pending : false, item : item };
  this.frames.push(_flow);
  return _flow;
};

/** Рамка для содержимого: неявный пункт в списке, неявная строка и ячейка в таблице */
Builder.prototype.ensureFlow = function (nestedList) {
  var _top = this.top();
  if (_top.kind === 'list') {
    var _items = _top.block.items;
    if (nestedList && _items.length > 0) {
      // ul/ol прямо в списке (вставка из Google Docs) — во вложенные блоки предыдущего пункта
      var _item = _items[_items.length - 1];
      return this.pushFlow(_item.blocks, _item);
    }
    return this.openItem(_top);
  }
  if (_top.kind === 'table') {
    return this.openCell(_top, false, {});
  }
  return _top;
};

Builder.prototype.openItem = function (listFrame) {
  var _item = { blocks : [], checkbox : null };
  listFrame.block.items.push(_item);
  return this.pushFlow(_item.blocks, _item);
};

Builder.prototype.openRow = function (tableFrame) {
  tableFrame.row = { cells : [] };
  tableFrame.block.rows.push(tableFrame.row);
};

Builder.prototype.openCell = function (tableFrame, header, attribs) {
  if (tableFrame.row === null) {
    this.openRow(tableFrame);
  }
  var _cell = {
    header  : header,
    colspan : spanValue(attribs.colspan, MAX_COLSPAN),
    rowspan : spanValue(attribs.rowspan, MAX_ROWSPAN),
    blocks  : []
  };
  tableFrame.row.cells.push(_cell);
  return this.pushFlow(_cell.blocks, null);
};

Builder.prototype.popTo = function (length) {
  while (this.frames.length > length) {
    var _frame = this.frames.pop();
    if (_frame.kind === 'flow') {
      this.flush(_frame);
    }
    else if (_frame.kind === 'caption') {
      var _caption = _frame.buffer.finish();
      _frame.table.caption = _caption.length > 0 ? _caption : null;
    }
  }
};

Builder.prototype.addBlock = function (flow, block) {
  block.quote = flow.quote;
  block.breakBefore = flow.pending;
  flow.pending = false;
  flow.blocks.push(block);
};

/** Закрыть открытый абзац рамки (пустой не создаётся) */
Builder.prototype.flush = function (flow) {
  if (flow.para !== null) {
    var _para = flow.para;
    flow.para = null;
    var _inlines = _para.buffer.finish();
    if (_inlines.length > 0) {
      var _fields = _para.level === null ? { inlines : _inlines } : { level : _para.level, inlines : _inlines };
      this.addBlock(flow, blockOf(_para.level === null ? 'para' : 'heading', _fields, 0));
    }
  }
};

Builder.prototype.openPara = function (flow, level) {
  this.flush(flow);
  flow.para = { level : level, buffer : new InlineBuffer(false) };
  return flow.para;
};

/** Накопитель для текста и Inline: строка pre, подпись таблицы или абзац (создаётся при необходимости) */
Builder.prototype.buffer = function () {
  var _top = this.top();
  var _buffer;
  if (_top.kind === 'caption') {
    _buffer = _top.buffer;
  }
  else {
    var _flow = this.ensureFlow();
    if (_flow.pre !== null) {
      _flow.pre.fresh = false;
      _buffer = _flow.pre.line;
    }
    else {
      _buffer = (_flow.para || this.openPara(_flow, null)).buffer;
    }
  }
  var _href = this.links.length > 0 ? this.links[0] : null;
  if (_href !== null && _buffer.link === null) {
    _buffer.openLink(_href);
  }
  return _buffer;
};

Builder.prototype.text = function (text) {
  if (this.skip > 0) {
    return;
  }
  var _top = this.top();
  if (_top.kind === 'flow' && _top.pre !== null) {
    this.preText(_top.pre, text);
    return;
  }
  if (/^[ \t\n\r\f]*$/.test(text)) {
    // пробелы вне абзаца отбрасываются
    if (_top.kind === 'caption' || _top.kind === 'flow' && _top.para !== null) {
      this.buffer().text(text, this.marks);
    }
    return;
  }
  this.buffer().text(text, this.marks);
};

Builder.prototype.preText = function (pre, text) {
  var _text = text.replace(/\r\n?/g, '\n');
  if (pre.fresh) {
    if (_text === '') {
      return;
    }
    pre.fresh = false;
    if (_text[0] === '\n') {
      _text = _text.slice(1);
    }
  }
  var _lines = _text.split('\n');
  for (var i = 0; i < _lines.length; i++) {
    if (i > 0) {
      this.preNewLine(pre);
    }
    if (_lines[i] !== '') {
      this.buffer().text(_lines[i], this.marks);
    }
  }
};

Builder.prototype.preNewLine = function (pre) {
  pre.lines.push(pre.line.finish());
  pre.line = new InlineBuffer(true);
};

Builder.prototype.open = function (name, attribs) {
  var _element = { marks : this.marks, close : null };
  this.elements.push(_element);
  if (this.skip > 0 || SKIP_TAGS[name] === true) {
    this.skip++;
    _element.close = function () {
      this.skip--;
    };
    return;
  }
  var _style = parseStyle(attribs.style);
  this.applyMarks(name, _style);
  var _top = this.top();
  var _inPre = _top.kind === 'flow' && _top.pre !== null;
  // элементы строки
  if (name === 'a') {
    this.openLinkElement(_element, attribs);
    return;
  }
  if (name === 'br') {
    if (_inPre) {
      _top.pre.fresh = false;
      this.preNewLine(_top.pre);
    }
    else {
      this.buffer().push({ type : 'break' });
    }
    return;
  }
  if (name === 'img') {
    var _src = typeof attribs.src === 'string' ? attribs.src.trim() : '';
    if (_src !== '') {
      this.buffer().push({ type : 'image', src : _src, width : pixels(attribs.width), height : pixels(attribs.height) });
    }
    return;
  }
  if (name === 'input') {
    if (typeof attribs.type === 'string' && attribs.type.trim().toLowerCase() === 'checkbox') {
      this.checkbox(attribs.checked !== undefined);
    }
    return;
  }
  if (MARK_TAGS[name] !== undefined || _inPre) {
    return;
  }
  // подпись таблицы: блоки внутри — пробел
  if (_top.kind === 'caption') {
    if (INLINE_SPACE_TAGS[name] === true) {
      _top.buffer.text(' ', this.marks);
    }
    return;
  }
  // структура таблиц и списков
  if (name === 'li' && this.openListItem(_element)) {
    return;
  }
  if ((name === 'tr' || name === 'td' || name === 'th' || name === 'caption') && this.openTablePart(_element, name, attribs)) {
    return;
  }
  if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
    return;
  }
  var _level = HEADING_TAGS[name];
  var _block = name === 'p' || _level !== undefined || name === 'pre' || name === 'hr' || name === 'blockquote' ||
    name === 'ul' || name === 'ol' || name === 'table' || BOUNDARY_TAGS[name] === true ||
    name === 'li' || name === 'tr' || name === 'td' || name === 'th' || name === 'caption';
  if (!_block) {
    return; // неизвестный тег строки — только текст
  }
  this.openBlock(_element, name, _level, _style);
};

Builder.prototype.applyMarks = function (name, style) {
  var _change = MARK_TAGS[name];
  var _color = style.color;
  var _background = name === 'mark' ? undefined : style.background;
  if (_change === undefined && _color === undefined && _background === undefined && name !== 'th') {
    return;
  }
  var _marks = Object.assign({}, this.marks, _change);
  if (name === 'th') {
    _marks.bold = true;
  }
  if (_color !== undefined) {
    _marks.color = _color;
  }
  if (_background !== undefined) {
    _marks.background = _background;
  }
  this.marks = _marks;
};

Builder.prototype.openLinkElement = function (element, attribs) {
  if (typeof attribs.href !== 'string' || this.links.length > 0) {
    return; // без href или вложенная — только текст
  }
  // ссылка открывается в накопителе при первом Inline (buffer), в том числе в новом абзаце после границы блока
  this.links.push(attribs.href.trim());
  element.close = function () {
    this.links.pop();
    this.closeOpenLinks();
  };
};

// после </a> ссылка не продолжается ни в одном открытом накопителе
Builder.prototype.closeOpenLinks = function () {
  this.frames.forEach(function (frame) {
    if (frame.kind === 'caption') {
      frame.buffer.closeLink();
    }
    else if (frame.kind === 'flow') {
      if (frame.para !== null) {
        frame.para.buffer.closeLink();
      }
      if (frame.pre !== null) {
        frame.pre.line.closeLink();
      }
    }
  });
};

Builder.prototype.checkbox = function (checked) {
  var _top = this.top();
  if (_top.kind === 'flow' && _top.item !== null && _top.item.checkbox === null && _top.blocks.length === 0 &&
      _top.pre === null && (_top.para === null || _top.para.buffer.empty)) {
    _top.item.checkbox = checked;
    return;
  }
  this.buffer().push({ type : 'checkbox', checked : checked });
};

Builder.prototype.openListItem = function (element) {
  var _top = this.top();
  var _below = this.frames[this.frames.length - 2];
  if (_top.kind !== 'list') {
    if (!(_top.kind === 'flow' && _top.item !== null && _below.kind === 'list')) {
      return false; // li вне списка — граница абзаца
    }
    this.popTo(this.frames.length - 1); // незакрытый пункт внутри вложенного элемента
    _top = _below;
  }
  var _length = this.frames.length;
  this.openItem(_top);
  element.close = function () {
    this.popTo(_length);
  };
  return true;
};

Builder.prototype.openTablePart = function (element, name, attribs) {
  var _top = this.top();
  var _below = this.frames[this.frames.length - 2];
  if (_top.kind !== 'table') {
    if (!(_top.kind === 'flow' && _below !== undefined && _below.kind === 'table' && _below.row !== null &&
        _below.row.cells.length > 0 && _below.row.cells[_below.row.cells.length - 1].blocks === _top.blocks)) {
      return false; // вне таблицы — граница абзаца
    }
    this.popTo(this.frames.length - 1); // незакрытая ячейка
    _top = _below;
  }
  var _table = _top;
  var _length = this.frames.length;
  if (name === 'tr') {
    this.openRow(_table);
    element.close = function () {
      this.popTo(_length);
      _table.row = null;
    };
  }
  else if (name === 'caption') {
    this.frames.push({ kind : 'caption', buffer : new InlineBuffer(false), table : _table.block });
    element.close = function () {
      this.popTo(_length);
    };
  }
  else {
    this.openCell(_table, name === 'th', attribs);
    element.close = function () {
      this.popTo(_length);
    };
  }
  return true;
};

Builder.prototype.openBlock = function (element, name, level, style) {
  var _flow = this.ensureFlow(name === 'ul' || name === 'ol');
  this.flush(_flow);
  if (style.breakBefore) {
    _flow.pending = true;
  }
  var _length = this.frames.length;
  var _count = _flow.blocks.length;
  var _after = null;
  if (name === 'p' || level !== undefined) {
    var _para = this.openPara(_flow, level === undefined ? null : level);
    _after = function () {
      if (_flow.para === _para) {
        this.flush(_flow);
      }
    };
  }
  else if (name === 'pre') {
    var _pre = { block : blockOf('pre', { lines : [] }, 0), lines : [], line : new InlineBuffer(true), fresh : true };
    _flow.pre = _pre;
    this.marks = Object.assign({}, this.marks, { mono : true }); // восстанавливается при закрытии pre
    _after = function () {
      _flow.pre = null;
      _pre.lines.push(_pre.line.finish());
      if (_pre.lines.length > 1 && _pre.lines[_pre.lines.length - 1].length === 0) {
        _pre.lines.pop();
      }
      if (_pre.lines.length > 1 || _pre.lines[0].length > 0) {
        _pre.block.lines = _pre.lines;
        this.addBlock(_flow, _pre.block);
      }
    };
  }
  else if (name === 'hr') {
    this.addBlock(_flow, blockOf('hr', {}, 0));
  }
  else if (name === 'blockquote') {
    var _quote = _flow.quote;
    _flow.quote++;
    _after = function () {
      this.flush(_flow);
      _flow.quote = _quote;
    };
  }
  else if (name === 'ul' || name === 'ol') {
    var _list = blockOf('list', { ordered : name === 'ol', items : [] }, 0);
    this.addBlock(_flow, _list);
    this.frames.push({ kind : 'list', block : _list });
    _after = function () {
      if (_list.items.length === 0) {
        _flow.blocks.splice(_flow.blocks.indexOf(_list), 1);
      }
    };
  }
  else if (name === 'table') {
    var _table = blockOf('table', { rows : [], caption : null }, 0);
    this.addBlock(_flow, _table);
    this.frames.push({ kind : 'table', block : _table, row : null });
    _after = function () {
      _table.rows = _table.rows.filter(function (row) {
        return row.cells.length > 0;
      });
      if (_table.rows.length === 0) {
        var _index = _flow.blocks.indexOf(_table);
        if (_table.caption === null) {
          _flow.blocks.splice(_index, 1);
        }
        else {
          _flow.blocks[_index] = Object.assign(blockOf('para', { inlines : _table.caption }, 0), {
            quote : _table.quote, breakBefore : _table.breakBefore
          });
        }
      }
    };
  }
  else {
    // граница абзаца (div, section, li вне списка, …)
    _after = function () {
      this.flush(_flow);
    };
  }
  element.close = function () {
    if (this.frames.length > _length) {
      this.popTo(_length);
    }
    if (_after !== null) {
      _after.call(this);
    }
    if (style.breakAfter && _flow.blocks.length > _count) {
      _flow.blocks[_flow.blocks.length - 1].breakAfter = true;
    }
  };
};

Builder.prototype.close = function () {
  var _element = this.elements.pop();
  if (_element === undefined) {
    return;
  }
  if (_element.close !== null) {
    _element.close.call(this);
  }
  this.marks = _element.marks;
};

Builder.prototype.finish = function () {
  this.popTo(1);
  this.flush(this.root);
  return this.root.blocks;
};

/**
 * HTML → Block[]
 * @param  {String} html
 * @param  {String} source метка (для ошибок шаблона)
 * @return {Array}         Block[]
 */
function parse (html, source) {
  var _builder = new Builder();
  runParser(html === null || html === undefined ? '' : String(html), source, {
    open  : _builder.open.bind(_builder),
    close : _builder.close.bind(_builder),
    text  : _builder.text.bind(_builder)
  });
  return _builder.finish();
}

// ---------------------------------------------------------------------------------------------------------------
// inlineOnly: Inline[]

/**
 * HTML → плоский Inline[] для параметра inline (a, b, strong, em, i, s, del, u; прочее — текст)
 * @param  {String} html
 * @param  {String} source метка (для ошибок шаблона)
 * @return {Array}         Inline[]
 */
function inlineOnly (html, source) {
  var _buffer = new InlineBuffer(false);
  var _marks = DEFAULT_MARKS;
  var _stack = [];
  var _skip = 0;
  var _linkDepth = 0;
  runParser(html === null || html === undefined ? '' : String(html), source, {
    open : function (name, attribs) {
      _stack.push({ marks : _marks, skip : false, link : false });
      var _entry = _stack[_stack.length - 1];
      if (_skip > 0 || SKIP_TAGS[name] === true) {
        _skip++;
        _entry.skip = true;
        return;
      }
      if (INLINE_ONLY_MARKS[name] === true) {
        _marks = Object.assign({}, _marks, MARK_TAGS[name]);
      }
      else if (name === 'a' && typeof attribs.href === 'string' && _linkDepth === 0) {
        _linkDepth++;
        _entry.link = true;
        _buffer.openLink(attribs.href.trim());
      }
      else if (INLINE_SPACE_TAGS[name] === true) {
        _buffer.text(' ', _marks);
      }
    },
    close : function (name) {
      var _entry = _stack.pop();
      if (_entry.skip) {
        _skip--;
        return;
      }
      if (_entry.link) {
        _linkDepth--;
        _buffer.closeLink();
      }
      else if (INLINE_SPACE_TAGS[name] === true && name !== 'br') {
        _buffer.text(' ', _marks);
      }
      _marks = _entry.marks;
    },
    text : function (text) {
      if (_skip === 0) {
        _buffer.text(text, _marks);
      }
    }
  });
  return _buffer.finish();
}

/**
 * Модель значения записи реестра :html (разбирается один раз и запоминается в item.content): блоки parse или, при
 * параметре inline, Inline[] inlineOnly
 * @param  {Object} item  { value, options, source }
 * @return {Array}
 */
function content (item) {
  if (item.content === undefined) {
    item.content = item.options !== null && item.options !== undefined && item.options.inline === true
      ? inlineOnly(item.value, item.source) : parse(item.value, item.source);
  }
  return item.content;
}

/**
 * Адреса изображений модели (блоки или Inline[]) — в порядке документа
 * @param  {Array}   list  блоки или Inline[]
 * @param  {Function} fn   fn(src) для каждого img
 */
function eachImage (list, fn) {
  var _inlines = function (inlines) {
    for (var i = 0; i < inlines.length; i++) {
      if (inlines[i].type === 'image') {
        fn(inlines[i].src);
      }
      else if (inlines[i].type === 'link') {
        _inlines(inlines[i].children);
      }
    }
  };
  var _blocks = function (blocks) {
    for (var i = 0; i < blocks.length; i++) {
      var _block = blocks[i];
      if (_block.inlines !== undefined) {
        _inlines(_block.inlines);
      }
      else if (_block.type === 'pre') {
        _block.lines.forEach(_inlines);
      }
      else if (_block.type === 'list') {
        _block.items.forEach(function (item) {
          _blocks(item.blocks);
        });
      }
      else if (_block.type === 'table') {
        if (_block.caption !== null) {
          _inlines(_block.caption);
        }
        _block.rows.forEach(function (row) {
          row.cells.forEach(function (cell) {
            _blocks(cell.blocks);
          });
        });
      }
      else if (_block.type !== undefined && _block.type !== 'hr') {
        // Inline[] (режим inline)
        _inlines([_block]);
      }
    }
  };
  _blocks(list);
}

module.exports = {
  content      : content,
  eachImage    : eachImage,
  parseOptions : parseOptions,
  parse        : parse,
  inlineOnly   : inlineOnly,
  cssColor     : cssColor,
  NAMED_COLORS : NAMED_COLORS,
  MAX_BYTES    : MAX_BYTES,
  MAX_DEPTH    : MAX_DEPTH
};
