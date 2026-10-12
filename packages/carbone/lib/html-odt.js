// :html (2.5.0, спецификация §34.3–34.4): запись модели HTML (lib/html-model.js) в OpenDocument Text. Своя реализация
// (чистая комната) по открытой документации carbone.io и ODF 1.2.
//
// Жетон метки стоит в тексте абзаца text:p/text:h (возможно, внутри text:span, text:a, text:meta), иначе — ошибка
// шаблона (R6). Абзацы с жетонами переписываются целиком, по одному жетону за раз (общие проходы — lib/html-xml.js):
//   - блочный режим: абзац метки делится на «до», блоки HTML и «после» (копии абзаца метки); пустые части (только
//     пробелы, span и закладки) не создаются, их закладки переходят в соседний созданный абзац; блок — text:p со
//     стилем абзаца метки, текст — во внешних text:span метки (R8); после блока — пустой text:p (кроме nospace);
//   - inline: разметка встаёт на место жетона, внутри text:span метки;
//   - пустое значение или HTML без содержимого — жетон убирается, абзац остаётся как у обычной метки; продолжение
//     абзаца после блоков, оставшееся пустым, отбрасывается.
//
// Оформление (R8): HTML — внутренний text:span с автоматическим стилем CRh<n> (style:family="text"), из которого
// исключены свойства, уже заданные оформлением метки (стили text:span вокруг метки с родителями, текст
// автоматического стиля абзаца метки). Свойства абзаца блока (отступ цитаты, линия hr, разрывы страницы) —
// автоматический стиль CRhp<n> с родителем — стилем абзаца метки. Стиль страницы, номер страницы и разрыв до из
// стиля абзаца метки остаются только у первого созданного абзаца, разрыв после — у последнего (resolvePage).
// Автоматические стили и style:font-face Courier New — в той же части (content.xml или styles.xml для колонтитулов),
// стили заголовков — в office:styles styles.xml (lib/html-odt-styles.js).
//
// Блоки (§34.4): заголовок — text:h text:outline-level со стилем Heading_20_N или <headingtheme>N (создаётся: жирный,
// 20/16/14/13/12/11pt); blockquote — fo:margin-left 1.058cm (40px) на уровень к отступу стиля метки либо стиль
// quotetheme (нет в styles.xml — отступ); pre — строки через text:line-break; hr — пустой абзац с нижней линией;
// разрывы — fo:break-before/after в стиле абзаца. Пробелы: повторы и пробел в начале абзаца или строки — text:s;
// табуляция — text:tab; флажок — ☒/☐.
//
// BLOCKS — запись блока по типу (blockXml), INLINES — Inline по типу; ctx абзаца — paragraphCtx; абзацы блоков —
// writePara (стиль абзаца, цитата, разрывы, span метки). Списки, таблицы, ссылки, изображения — Task 8.

var xmltree = require('./xmltree');
var model = require('./html-model');
var common = require('./html-xml');
var odfStyles = require('./html-odt-styles');

var escapeText = common.escapeText;
var templateError = common.templateError;

// абзацы; элементы между абзацем и текстом метки; закладки (переходят из пустой части); не содержимое
var PARAGRAPHS = ['text:p', 'text:h'];
var TRANSPARENT = ['text:span', 'text:a', 'text:meta'];
var MARKERS = ['text:bookmark', 'text:bookmark-start', 'text:bookmark-end', 'text:reference-mark',
  'text:reference-mark-start', 'text:reference-mark-end'];
var IGNORED = ['text:soft-page-break'];

// блоки, после которых ставится пустой абзац (кроме nospace)
var SPACED = { para : true, heading : true, pre : true, list : true, table : true };
// отступ уровня blockquote (40px), см; hr: нижняя линия и отступы 0,5em
var QUOTE_INDENT = 1.058;
var HR_PROPS = [['fo:border-bottom', '0.5pt solid #000000'], ['fo:margin-top', '0.21cm'], ['fo:margin-bottom', '0.21cm']];
var LINE_BREAK = '<text:line-break/>';

// разметка HTML → свойства текста: keys — свойства, при которых у метки разметка не применяется (§34.3)
var TEXT_PROPS = [
  { keys : ['style:font-name', 'fo:font-family'], props : function (m) {
    return m.mono === true ? [['style:font-name', odfStyles.COURIER]] : [];
  } },
  { keys : ['fo:font-weight'], props : function (m) {
    return m.bold === true ? [['fo:font-weight', 'bold']] : [];
  } },
  { keys : ['fo:font-style'], props : function (m) {
    return m.italic === true ? [['fo:font-style', 'italic']] : [];
  } },
  { keys : ['style:text-underline-style'], props : function (m) {
    return m.underline === true ? [['style:text-underline-style', 'solid'], ['style:text-underline-width', 'auto'], ['style:text-underline-color', 'font-color']] : [];
  } },
  { keys : ['style:text-line-through-style'], props : function (m) {
    return m.strike === true ? [['style:text-line-through-style', 'solid']] : [];
  } },
  { keys : ['style:text-position'], props : function (m) {
    return m.sup === true || m.sub === true ? [['style:text-position', (m.sup === true ? 'super' : 'sub') + ' 58%']] : [];
  } },
  { keys : ['fo:color'], props : function (m) {
    return m.color !== null ? [['fo:color', '#' + m.color.toLowerCase()]] : [];
  } },
  // mark важнее background-color предков
  { keys : ['fo:background-color'], props : function (m) {
    if (m.mark === true) {
      return [['fo:background-color', '#ffff00']];
    }
    return m.background !== null ? [['fo:background-color', '#' + m.background.toLowerCase()]] : [];
  } }
];

// ---------------------------------------------------------------------------------------------------------------
// Inline

/**
 * Текст: повторы пробелов и пробел в начале абзаца (строки) или после пробела — text:s, табуляция — text:tab.
 * ctx.space — предыдущий символ абзаца пробел или начало (пробел ODF там схлопнул бы)
 */
function textXml (text, ctx) {
  var _out = '';
  var _re = / +|\t|[^ \t]+/g;
  var _match;
  while ((_match = _re.exec(text)) !== null) {
    var _piece = _match[0];
    if (_piece === '\t') {
      _out += '<text:tab/>';
      ctx.space = false;
    }
    else if (_piece[0] === ' ') {
      var _count = _piece.length;
      if (ctx.space === false) {
        _out += ' ';
        _count--;
      }
      if (_count > 0) {
        _out += _count === 1 ? '<text:s/>' : '<text:s text:c="' + _count + '"/>';
      }
      ctx.space = true;
    }
    else {
      _out += escapeText(_piece);
      ctx.space = false;
    }
  }
  return _out;
}

/** Свойства текста по разметке HTML без свойств, заданных оформлением метки (ctx.exclude) */
function textProps (marks, ctx) {
  var _props = [];
  TEXT_PROPS.forEach(function (rule) {
    if (rule.keys.some(function (key) { return ctx.exclude.has(key); }) === false) {
      _props = _props.concat(rule.props(marks));
    }
  });
  return _props;
}

var INLINES = {
  text : function (inline, ctx) {
    var _content = textXml(inline.text, ctx);
    var _props = _content !== '' ? textProps(inline.marks, ctx) : [];
    if (_props.length === 0) {
      return _content;
    }
    if (_props[0][0] === 'style:font-name') {
      ctx.odfStyles.font();
    }
    return '<text:span text:style-name="' + ctx.odfStyles.text(_props) + '">' + _content + '</text:span>';
  },
  break : function (inline, ctx) {
    ctx.space = true;
    return LINE_BREAK;
  },
  // ссылки — Task 8 (пока текст)
  link : function (inline, ctx) {
    return inlinesXml(inline.children, ctx);
  },
  checkbox : function (inline, ctx) {
    ctx.space = false;
    return inline.checked === true ? '☒' : '☐';
  }
};

/**
 * Inline модели → разметка абзаца ODT
 * @param  {Object} inline  Inline модели
 * @param  {Object} ctx     контекст абзаца
 * @return {String}
 */
function inlineXml (inline, ctx) {
  var _write = INLINES[inline.type];
  return _write === undefined ? '' : _write(inline, ctx);
}

function inlinesXml (inlines, ctx) {
  return inlines.map(function (inline) {
    return inlineXml(inline, ctx);
  }).join('');
}

/** Содержимое нового абзаца (или строки pre): пробел в начале — text:s */
function lineXml (inlines, ctx) {
  ctx.space = true;
  return inlinesXml(inlines, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Блоки

/** Содержимое во внешних text:span метки (R8) */
function wrapSpans (inner, ctx) {
  if (inner === '') {
    return '';
  }
  var _out = inner;
  for (var i = ctx.spans.length - 1; i >= 0; i--) {
    _out = '<text:span text:style-name="' + ctx.spans[i] + '">' + _out + '</text:span>';
  }
  return _out;
}

/**
 * Абзац блока: стиль абзаца метки (или свой — заголовок), отступ цитаты (к отступу стиля и контейнера ctx.indent),
 * стиль quotetheme, ожидающие разрывы страницы (ctx.pageBreak — до, ctx.breakAfter — после)
 * @param  {Object} block  блок модели (quote)
 * @param  {String} inner  содержимое (без span метки)
 * @param  {Object} ctx
 * @param  {Object} [opts] { tag: 'text:p' | 'text:h', style: свой стиль (имя как в XML), level, props: [[атрибут, значение]] }
 * @return {String}
 */
function writePara (block, inner, ctx, opts) {
  var _o = opts || {};
  var _own = _o.style !== undefined;
  var _base = _own === true ? _o.style : ctx.pStyle;
  var _props = [];
  var _quote = block.quote > 0 ? block.quote : 0;
  if (_quote > 0 && ctx.quoteTheme !== null && _own === false) {
    _base = ctx.quoteTheme;
  }
  else if (_quote > 0 || ctx.indent !== 0) {
    _props.push(['fo:margin-left', odfStyles.formatCm(odfStyles.marginCm(ctx.odfStyles, _base) + ctx.indent + QUOTE_INDENT * _quote)]);
  }
  else if (_own === false && ctx.quoteStyle !== null) {
    _base = ctx.quoteStyle;
  }
  _props = _props.concat(_o.props || []);
  if (ctx.pageBreak === true) {
    _props.push(['fo:break-before', 'page']);
    ctx.pageBreak = false;
  }
  if (ctx.breakAfter === true) {
    _props.push(['fo:break-after', 'page']);
    ctx.breakAfter = false;
  }
  var _tag = _o.tag || 'text:p';
  var _open = '<' + _tag + styleAttr(ctx, _base, _props) + (_o.level !== undefined ? ' text:outline-level="' + _o.level + '"' : '');
  var _content = wrapSpans(inner, ctx);
  return _content === '' ? _open + '/>' : _open + '>' + _content + '</' + _tag + '>';
}

/** Пустой абзац после блока и абзац разрыва страницы: стиль абзаца метки (props — свои свойства абзаца) */
function spacerXml (ctx, props) {
  return '<text:p' + styleAttr(ctx, ctx.pStyle, props) + '/>';
}

// ---------------------------------------------------------------------------------------------------------------
// Свойства страницы абзаца метки (стиль страницы, номер страницы, разрывы — решение контроллера к R8): стиль страницы,
// номер и разрыв до — только у первого созданного абзаца, разрыв после — только у последнего. Пока абзацы пишутся,
// их стиль неизвестен: атрибут text:style-name — заполнитель запроса { base, props }, после записи всего абзаца
// метки (writeParagraph) заполнители заменяются стилями по месту абзаца (resolvePage)

// заполнитель: символы частного использования (отличны от жетона :html U+E040/U+E041) и ключ рендера
var PAGE_OPEN = '\uE042';
var PAGE_CLOSE = '\uE043';

/** Атрибут text:style-name абзаца со стилем base и свойствами props (или заполнитель, если у метки есть свойства страницы) */
function styleAttr (ctx, base, props) {
  if (ctx.page === null) {
    var _style = ctx.odfStyles.paragraph(base, props);
    return _style !== null ? ' text:style-name="' + _style + '"' : '';
  }
  ctx.page.requests.push({ base : base, props : props });
  return ' text:style-name="' + PAGE_OPEN + ctx.page.nonce + 'p' + (ctx.page.requests.length - 1) + PAGE_CLOSE + '"';
}

/** Стиль абзаца по запросу и месту: абзацы со стилем метки теряют свойства не своего места, прочие — получают своего */
function pageStyle (odfStyles, page, request, first, last) {
  var _info = page.info;
  var _props = request.props.slice();
  var _attrs = [];
  var _set = function (name, value) {
    if (_props.some(function (prop) { return prop[0] === name; }) === false) {
      _props.push([name, value]);
    }
  };
  if (request.base === page.base) {
    if (first === false && _info.master !== null) {
      _attrs.push(['style:master-page-name', '']);
      _set('style:page-number', null);
    }
    if (first === false && _info.before !== null) {
      _set('fo:break-before', 'auto');
    }
    if (last === false && _info.after !== null) {
      _set('fo:break-after', 'auto');
    }
  }
  else {
    if (first === true && _info.master !== null) {
      _attrs.push(['style:master-page-name', _info.master]);
      if (_info.pageNumber !== null) {
        _set('style:page-number', _info.pageNumber);
      }
    }
    if (first === true && _info.before !== null) {
      _set('fo:break-before', _info.before);
    }
    if (last === true && _info.after !== null) {
      _set('fo:break-after', _info.after);
    }
  }
  return odfStyles.paragraph(request.base, _props, _attrs);
}

/** Заполнители стилей XML абзацев метки → стили: первый — с началом страницы, последний — с разрывом после */
function resolvePage (xml, page, odfStyles) {
  if (page === null) {
    return xml;
  }
  var _regex = new RegExp(' text:style-name="' + PAGE_OPEN + page.nonce + 'p(\\d+)' + PAGE_CLOSE + '"', 'g');
  var _count = (xml.match(_regex) || []).length;
  var _i = 0;
  return xml.replace(_regex, function (all, k) {
    var _style = pageStyle(odfStyles, page, page.requests[k], _i === 0, _i === _count - 1);
    _i++;
    return _style !== null ? ' text:style-name="' + _style + '"' : '';
  });
}

var BLOCKS = {
  para : function (block, ctx) {
    return writePara(block, lineXml(block.inlines, ctx), ctx);
  },
  // заголовок: text:h со стилем Heading_20_N (или <headingtheme>N), стиль создаётся в styles.xml при отсутствии
  heading : function (block, ctx) {
    var _theme = ctx.options.headingtheme;
    var _name = _theme !== null ? escapeText(_theme + block.level) : 'Heading_20_' + block.level;
    var _style = ctx.parts.heading(_name, block.level, _theme !== null ? null : 'Heading ' + block.level);
    return writePara(block, lineXml(block.inlines, ctx), ctx, { tag : 'text:h', style : _style, level : block.level });
  },
  // pre: строки — через text:line-break (Courier New уже в marks)
  pre : function (block, ctx) {
    return writePara(block, block.lines.map(function (line) {
      return lineXml(line, ctx);
    }).join(LINE_BREAK), ctx);
  },
  // hr: пустой абзац с нижней линией и отступами 0,5em сверху и снизу
  hr : function (block, ctx) {
    return writePara(block, '', ctx, { props : HR_PROPS });
  }
};

/**
 * Блок модели → разметка ODT (без пустого абзаца после блока)
 * @param  {Object} block  Block модели
 * @param  {Object} ctx    контекст абзаца
 * @return {String}
 */
function blockXml (block, ctx) {
  var _write = BLOCKS[block.type];
  return _write === undefined ? '' : _write(block, ctx);
}

/**
 * Блоки HTML на месте абзаца метки: пустой абзац после блока — только на месте метки (ctx.depth 0); разрыв до блока —
 * в стиле его первого абзаца, после — в стиле пустого абзаца после блока, без него — последнего абзаца блока (блоки,
 * которые не взяли разрыв, получают отдельный пустой абзац)
 */
function blocksXml (blocks, ctx) {
  var _out = '';
  blocks.forEach(function (block) {
    var _spaced = ctx.depth === 0 && ctx.options.nospace !== true && SPACED[block.type] === true;
    ctx.pageBreak = ctx.pageBreak === true || block.breakBefore === true;
    ctx.breakAfter = block.breakAfter === true && _spaced === false;
    var _block = blockXml(block, ctx);
    if (ctx.pageBreak === true) {
      ctx.pageBreak = false;
      _block = spacerXml(ctx, [['fo:break-before', 'page']]) + _block;
    }
    if (_spaced === true) {
      _block += spacerXml(ctx, block.breakAfter === true ? [['fo:break-after', 'page']] : []);
    }
    else if (ctx.breakAfter === true) {
      _block += spacerXml(ctx, [['fo:break-after', 'page']]);
    }
    ctx.breakAfter = false;
    _out += _block;
  });
  return _out;
}

// ---------------------------------------------------------------------------------------------------------------
// Абзац метки

/**
 * Контекст абзаца для записи блоков
 * @return {Object} { job, item, options, images, links, media, odfStyles, parts, pStyle, spans, exclude, space,
 *                   pageBreak, breakAfter, depth, indent, quoteStyle }
 *   pStyle — text:style-name абзаца метки (как в XML) или null; spans — text:style-name text:span вокруг метки
 *   (снаружи внутрь); exclude — свойства текста, заданные оформлением метки (R8)
 */
function paragraphCtx (xml, p, token, item, job, page) {
  var _spans = [];
  for (var _el = token.el; _el !== p; _el = _el.parent) {
    var _name = _el.name === 'text:span' ? xmltree.attr(xml, _el, 'text:style-name') : null;
    if (_name !== null) {
      _spans.unshift(_name);
    }
  }
  // стиль абзаца метки — исходный (в копиях абзаца на его месте может стоять заполнитель)
  var _pStyle = page.pStyle;
  var _exclude = new Set();
  var _add = function (entry) {
    odfStyles.textPropNames(entry).forEach(function (name) {
      _exclude.add(name);
    });
  };
  _spans.forEach(function (name) {
    job.odfStyles.chain(name, 'text').forEach(_add);
  });
  var _pAuto = _pStyle !== null ? job.odfStyles.automatic(_pStyle, 'paragraph') : null;
  if (_pAuto !== null) {
    _add(_pAuto);
  }
  return {
    job        : job,
    item       : item,
    options    : item.options,
    images     : job.images,
    links      : job.links,
    media      : job.media,
    odfStyles  : job.odfStyles,
    parts      : job.parts,
    pStyle     : _pStyle,
    // свойства страницы абзаца метки (resolvePage) или null
    page       : page.page,
    // стиль quotetheme, если он есть в styles.xml (иначе — отступ)
    quoteTheme : quoteTheme(item.options.quotetheme, job),
    spans      : _spans,
    exclude    : _exclude,
    // предыдущий символ — пробел или начало абзаца (textXml)
    space      : true,
    pageBreak  : false,
    breakAfter : false,
    // контейнер (пункт списка, ячейка — Task 8): глубина (> 0 — без пустых абзацев), отступ слева (см), стиль цитаты
    depth      : 0,
    indent     : 0,
    quoteStyle : null
  };
}

/** Стиль quotetheme (имя как в XML), если он есть среди общих стилей styles.xml; иначе (или без параметра) — null */
function quoteTheme (theme, job) {
  if (theme === null || theme === undefined) {
    return null;
  }
  var _name = escapeText(theme);
  return job.parts !== null && job.parts.common(_name, 'paragraph') !== null ? _name : null;
}

/** Абзац жетона (R6: жетон — в тексте text:p/text:h, возможно внутри text:span, text:a, text:meta) */
function paragraphOf (token, job) {
  var _el = token.el;
  // жетон в атрибуте принадлежит самому элементу
  if (token.pos >= _el.openEnd) {
    while (_el !== null && TRANSPARENT.indexOf(_el.name) !== -1) {
      _el = _el.parent;
    }
    if (_el !== null && PARAGRAPHS.indexOf(_el.name) !== -1) {
      return _el;
    }
  }
  throw templateError(common.MSG_OUTSIDE, job.registry.items[token.id].source);
}

/** Часть абзаца (содержимое без тега абзаца): пустая — нет текста кроме пробелов и элементов кроме span и закладок */
function partInfo (content) {
  var _markers = '';
  var _empty = true;
  var _walk = function (el) {
    el.children.forEach(function (child) {
      if (MARKERS.indexOf(child.name) !== -1) {
        _markers += content.slice(child.start, child.end);
      }
      else if (TRANSPARENT.indexOf(child.name) !== -1) {
        _walk(child);
      }
      else if (IGNORED.indexOf(child.name) === -1) {
        _empty = false;
      }
    });
  };
  _walk(xmltree.parse(content).root);
  if (_empty === true && /[^ \t\r\n]/.test(content.replace(xmltree.TAG_REGEX, '')) === true) {
    _empty = false;
  }
  return { empty : _empty, markers : _markers };
}

/** Открывающий тег копии элемента: без xml:id (он уникален в документе) */
function reopenTag (xml, el) {
  return xmltree.startTag(xml, el).replace(/\sxml:id\s*=\s*(?:"[^"]*"|'[^']*')/, '');
}

/**
 * Разделить абзац на месте жетона: «до» и «после» — { xml, empty, markers }. Элементы между жетоном и абзацем
 * закрываются и открываются заново; ставшие пустыми с одной из сторон не повторяются
 */
function splitParagraph (xml, p, token) {
  var _chain = [];
  for (var _el = token.el; _el !== p; _el = _el.parent) {
    _chain.push(_el);
  }
  var _close = '</' + p.name + '>';
  var _head = token.pos;
  var _k = 0;
  while (_k < _chain.length && _head === _chain[_k].openEnd) {
    _head = _chain[_k].start;
    _k++;
  }
  var _before = xml.slice(p.openEnd, _head) + _chain.slice(_k).map(function (el) {
    return '</' + el.name + '>';
  }).join('');
  var _tail = token.pos + token.len;
  var _j = 0;
  while (_j < _chain.length && _tail === _chain[_j].closeStart) {
    _tail = _chain[_j].end;
    _j++;
  }
  var _after = _chain.slice(_j).reverse().map(function (el) {
    return reopenTag(xml, el);
  }).join('') + xml.slice(_tail, p.closeStart);
  var _partOf = function (open, content) {
    var _info = partInfo(content);
    _info.xml = open + content + _close;
    return _info;
  };
  return {
    before : _partOf(xmltree.startTag(xml, p), _before),
    after  : _partOf(reopenTag(xml, p), _after)
  };
}

var PARA_OPEN = /<text:(p|h)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/;
var PARA_END = /<\/text:(?:p|h)>|<text:(p|h)\b(?:[^>"']|"[^"]*"|'[^']*')*?\/>/g;

/** Закладки пустой части «до» — в начало первого абзаца xml */
function prependMarkers (xml, markers) {
  var _match = markers !== '' ? PARA_OPEN.exec(xml) : null;
  if (_match === null) {
    return xml;
  }
  var _end = _match.index + _match[0].length;
  var _open = _match[2] === '/' ? _match[0].replace(/\s*\/>$/, '>') : _match[0];
  return xml.slice(0, _match.index) + _open + markers + (_match[2] === '/' ? '</text:' + _match[1] + '>' : '') + xml.slice(_end);
}

/** Закладки пустой части «после» — в конец последнего абзаца xml */
function appendMarkers (xml, markers) {
  if (markers === '') {
    return xml;
  }
  var _last = null;
  var _match;
  PARA_END.lastIndex = 0;
  while ((_match = PARA_END.exec(xml)) !== null) {
    _last = _match;
  }
  if (_last === null) {
    return xml;
  }
  var _end = _last.index + _last[0].length;
  if (_last[1] === undefined) {
    return xml.slice(0, _last.index) + markers + xml.slice(_last.index);
  }
  return xml.slice(0, _last.index) + _last[0].replace(/\s*\/>$/, '>') + markers + '</text:' + _last[1] + '>' + xml.slice(_end);
}

/**
 * Переписать абзац с жетонами (XML ровно одного text:p/text:h; вложенных абзацев с жетонами в нём уже нет). Если у
 * стиля абзаца метки есть свойства страницы, стиль абзаца — заполнитель уже в исходном абзаце (копии «до» и «после»
 * получают его), стили по месту абзацев — после записи (resolvePage)
 * @return {String} XML абзацев на его месте
 */
function writeParagraph (pXml, job) {
  var _p = xmltree.parse(pXml).root.children[0];
  var _pStyle = xmltree.attr(pXml, _p, 'text:style-name');
  var _info = _pStyle !== null ? job.odfStyles.page(_pStyle) : null;
  var _mark = { pStyle : _pStyle, page : null };
  var _xml = pXml;
  if (_info !== null) {
    _mark.page = { info : _info, base : _pStyle, requests : [], nonce : job.registry.nonce };
    var _range = xmltree.attrRange(pXml, _p, 'text:style-name');
    var _attr = styleAttr({ page : _mark.page }, _pStyle, []);
    _xml = pXml.slice(0, _range.start) + _attr.slice(_attr.indexOf('"') + 1, -1) + pXml.slice(_range.end);
  }
  return resolvePage(writeParts(_xml, job, _mark), _mark.page, job.odfStyles);
}

/** Абзац метки по жетонам: «до», блоки, «после» (mark — { pStyle, page } исходного абзаца) */
function writeParts (pXml, job, mark) {
  var _out = '';
  var _xml = pXml;
  // абзац — продолжение после блоков: пустой не остаётся
  var _continued = false;
  for (;;) {
    var _parsed = common.parseTokens(_xml, job);
    if (_parsed.tokens.length === 0) {
      break;
    }
    var _token = _parsed.tokens[0];
    var _p = paragraphOf(_token, job);
    var _item = job.registry.items[_token.id];
    var _strip = _xml.slice(0, _token.pos) + _xml.slice(_token.pos + _token.len);
    if (_item.value === '') {
      _xml = _strip;
      continue;
    }
    var _ctx = paragraphCtx(_xml, _p, _token, _item, job, mark);
    if (_item.options.inline === true) {
      // перед жетоном пробел или тег — пробел в начале разметки как text:s
      var _prev = _xml[_token.pos - 1];
      _ctx.space = _prev === ' ' || _prev === '>';
      _xml = _xml.slice(0, _token.pos) + inlinesXml(model.content(_item), _ctx) + _xml.slice(_token.pos + _token.len);
      continue;
    }
    var _body = blocksXml(model.content(_item), _ctx);
    if (_body === '') {
      _xml = _strip;
      continue;
    }
    var _split = splitParagraph(_xml, _p, _token);
    _out += _split.before.empty === true ? prependMarkers(_body, _split.before.markers) : _split.before.xml + _body;
    _continued = true;
    if (_split.after.empty === true) {
      return appendMarkers(_out, _split.after.markers);
    }
    _xml = _split.after.xml;
  }
  if (_continued === true) {
    var _p2 = xmltree.parse(_xml).root.children[0];
    var _rest = partInfo(_xml.slice(_p2.openEnd, _p2.closeStart));
    if (_rest.empty === true) {
      return appendMarkers(_out, _rest.markers);
    }
  }
  return _out + _xml;
}

/**
 * Записать HTML на месте жетонов части ODT (content.xml или styles.xml)
 * @param  {Object} job  { template, file, xml, root, tokens, registry, options, images, links, media, tokenRegex,
 *                       parts } — parts — общие стили отчёта (html-odt-styles.parts), сохраняет вызывающий
 * @return {String}      новый XML части: автоматические стили и шрифт дописаны, пространства имён объявлены
 */
function write (job) {
  job.ns = {};
  job.odfStyles = odfStyles.create(job);
  var _xml = job.odfStyles.save(common.rewriteParagraphs(job, paragraphOf, writeParagraph));
  return common.declareNs(_xml, job.root, job.ns, odfStyles.NAMESPACES);
}

module.exports = {
  write,
  parts : odfStyles.parts,
  writePara,
  blockXml,
  inlineXml,
  BLOCKS,
  INLINES
};
