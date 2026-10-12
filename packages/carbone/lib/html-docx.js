// :html (2.5.0, спецификация §34.3–34.4): запись модели HTML (lib/html-model.js) в WordprocessingML. Своя реализация
// (чистая комната) по открытой документации carbone.io.
//
// Жетон метки стоит в w:t (внутри w:r абзаца w:p), иначе — ошибка шаблона (R6). Абзацы с жетонами переписываются
// целиком, по одному жетону за раз (абзац после жетона разбирается заново):
//   - блочный режим: абзац метки делится на «до», блоки HTML и «после»; пустые части (нет w:r с содержимым кроме
//     w:rPr) не создаются; каждый блок — абзацы с копией w:pPr метки (R7: w:sectPr — только в последнем созданном
//     абзаце) и w:r с w:rPr метки плюс разметка HTML (свойство метки побеждает); после блока — пустой абзац
//     (кроме nospace); разрыв страницы до блока — w:br в начале первого абзаца, после — отдельным абзацем;
//   - inline: w:t метки делится на две части, w:r разметки встают между ними в том же абзаце;
//   - пустое значение или HTML без содержимого — жетон убирается, абзац остаётся как у обычной метки.
// Абзацы во вложенных абзацах (надпись внутри абзаца) обрабатываются раньше внешних — проходами по файлу.
//
// Блоки (§34.4): заголовок — стиль Heading1…6 или <headingtheme>1…6 (создаётся в styles.xml при отсутствии), внутри
// пункта списка — абзац пункта с оформлением заголовка (w:b, w:sz); список — свой w:num на каждый список (часть
// numbering.xml общая для отчёта, lib/html-docx-parts.js), пункт — w:p с w:numPr и прямым отступом уровня (720 twips
// на уровень, висячий 360), прочие блоки пункта — абзацы с тем же отступом без номера, пункт с флажком — без w:numPr,
// флажок первым; blockquote — w:ind слева 600 twips на уровень (к отступу метки) либо w:pStyle quotetheme; pre — строки
// через w:br; hr — пустой абзац с нижней линией; флажок — w:sdt с w14:checkbox (w14 объявляется на корне части).
// R7: заголовки, пункты и блоки внутри пунктов берут из w:pPr метки только w:jc, w:bidi, w:ind, w:spacing.
//
// Расширение (Task 6): BLOCKS — запись блока по типу (blockXml), inlineXml — запись Inline по типу; ctx абзаца:
//   { job, item, options, images, pPr, sectPr, rPr, pageBreak, numbering, styles, indent, depth, lead, quoteStyle }
//   — см. paragraphCtx; абзацы блоков — writePara (свойства по R7, цитата, отступ контейнера, номер пункта).

var xmltree = require('./xmltree');
var model = require('./html-model');
var parts = require('./html-docx-parts');

var MSG_OUTSIDE = 'html ставится в текст абзаца.';

// порядок дочерних элементов по схеме (ECMA-376 CT_RPr, CT_PPr); элементы не из списка стоят после известных
var W_RPR = ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo', 'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps',
  'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid',
  'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u',
  'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
  'w:specVanish', 'w:oMath'];
var W_PPR = ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
  'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
  'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd', 'w:snapToGrid',
  'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection',
  'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange'];

var COURIER = '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
var PAGE_BREAK = '<w:r><w:br w:type="page"/></w:r>';
// заливка текста: подсветка (mark) и фон (background-color) — одно свойство; у метки есть любое — HTML не красит
var BACKGROUND = ['w:highlight', 'w:shd'];
// блоки, после которых ставится пустой абзац (кроме nospace)
var SPACED = { para : true, heading : true, pre : true, list : true, table : true };
// R7: свойства абзаца метки, которые берут заголовки, пункты списков и блоки внутри них
var R7 = ['w:jc', 'w:bidi', 'w:ind', 'w:spacing'];
// отступ уровня blockquote (40px), twips
var QUOTE_INDENT = 600;
// блоки, которые сами пишут первый абзац пункта (с номером или флажком); перед прочими — пустой абзац пункта
var LEAD_BLOCKS = { para : true, heading : true, pre : true };
var HR_PPR = [
  { name : 'w:pBdr', xml : '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>' },
  { name : 'w:spacing', xml : '<w:spacing w:before="120" w:after="120"/>' }
];
var W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
// символы, недопустимые в XML 1.0, и одиночные суррогаты
var INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function templateError (message, source) {
  return new Error(message + ' Source: "' + source + '"');
}

function escapeText (text) {
  return text.replace(INVALID_XML, function (all) {
    // у одиночного младшего суррогата сохраняется предыдущий символ
    return all.length === 2 ? all[0] : '';
  }).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------------------------------
// Свойства: дочерние элементы [{ name, xml }]

/** Дочерние элементы el как [{ name, xml }] (кроме names, если задан) */
function kids (xml, el, except) {
  if (el === null) {
    return [];
  }
  return el.children.filter(function (child) {
    return except === undefined || except.indexOf(child.name) === -1;
  }).map(function (child) {
    return { name : child.name, xml : xml.slice(child.start, child.end) };
  });
}

function childNamed (el, name) {
  for (var i = 0; i < el.children.length; i++) {
    if (el.children[i].name === name) {
      return el.children[i];
    }
  }
  return null;
}

function has (list, name) {
  return list.some(function (kid) {
    return kid.name === name;
  });
}

/** Список свойств с kid вместо одноимённого */
function setKid (list, kid) {
  return list.filter(function (k) {
    return k.name !== kid.name;
  }).concat([kid]);
}

function removeAttr (tag, name) {
  return tag.replace(new RegExp('\\s' + name.replace(/[:]/g, '\\$&') + '\\s*=\\s*(?:"[^"]*"|\'[^\']*\')'), '');
}

/**
 * w:ind со сдвигом левого отступа на extra twips (к отступу метки) и висячим отступом hanging (или без изменения
 * первой строки при null)
 */
function withIndent (list, extra, hanging) {
  var _old = list.filter(function (kid) {
    return kid.name === 'w:ind';
  });
  var _tag = _old.length > 0 ? /^<w:ind\b[^>]*>/.exec(_old[0].xml)[0].replace(/\s*\/?>$/, '/>') : '<w:ind/>';
  var _side = /\sw:left\s*=/.test(_tag) === false && /\sw:start\s*=/.test(_tag) === true ? 'w:start' : 'w:left';
  var _match = new RegExp('\\s' + _side + '\\s*=\\s*["\']\\s*(-?\\d+)').exec(_tag);
  var _base = _match !== null ? parseInt(_match[1], 10) : 0;
  // отступ в символах (w:leftChars) у Word важнее twips — снимается
  _tag = xmltree.putAttr(removeAttr(_tag, _side + 'Chars'), _side, String(_base + extra));
  if (hanging !== null) {
    ['w:firstLine', 'w:firstLineChars', 'w:hangingChars'].forEach(function (name) {
      _tag = removeAttr(_tag, name);
    });
    _tag = xmltree.putAttr(_tag, 'w:hanging', String(hanging));
  }
  return setKid(list, { name : 'w:ind', xml : _tag });
}

/** Элемент свойств по схеме (стабильно: известные — по order, неизвестные — после, в исходном порядке) */
function propsXml (name, list, order) {
  if (list.length === 0) {
    return '';
  }
  var _rank = function (kid) {
    var _i = order.indexOf(kid.name);
    return _i === -1 ? order.length : _i;
  };
  return '<' + name + '>' + list.slice().sort(function (a, b) {
    return _rank(a) - _rank(b);
  }).map(function (kid) {
    return kid.xml;
  }).join('') + '</' + name + '>';
}

function rPrXml (list) {
  return propsXml('w:rPr', list, W_RPR);
}

function pPrXml (list) {
  return propsXml('w:pPr', list, W_PPR);
}

/** w:rPr метки + разметка HTML: элемент, который уже есть у метки, не добавляется (§34.3 «приоритет у метки») */
function mergeRPr (base, marks) {
  var _add = [];
  if (marks.mono === true) {
    _add.push({ name : 'w:rFonts', xml : COURIER });
  }
  if (marks.bold === true) {
    _add.push({ name : 'w:b', xml : '<w:b/>' });
  }
  if (marks.italic === true) {
    _add.push({ name : 'w:i', xml : '<w:i/>' });
  }
  if (marks.strike === true) {
    _add.push({ name : 'w:strike', xml : '<w:strike/>' });
  }
  if (marks.color !== null) {
    _add.push({ name : 'w:color', xml : '<w:color w:val="' + marks.color + '"/>' });
  }
  if (marks.underline === true) {
    _add.push({ name : 'w:u', xml : '<w:u w:val="single"/>' });
  }
  if (BACKGROUND.some(function (name) { return has(base, name); }) === false) {
    // mark важнее background-color предков
    if (marks.mark === true) {
      _add.push({ name : 'w:highlight', xml : '<w:highlight w:val="yellow"/>' });
    }
    else if (marks.background !== null) {
      _add.push({ name : 'w:shd', xml : '<w:shd w:val="clear" w:fill="' + marks.background + '"/>' });
    }
  }
  if (marks.sup === true || marks.sub === true) {
    _add.push({ name : 'w:vertAlign', xml : '<w:vertAlign w:val="' + (marks.sup === true ? 'superscript' : 'subscript') + '"/>' });
  }
  return base.concat(_add.filter(function (kid) {
    return has(base, kid.name) === false;
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Inline

/** Текст: w:t с сохранением пробелов, табуляция — w:tab */
function textXml (text) {
  return text.split('\t').map(function (piece) {
    return piece === '' ? '' : '<w:t xml:space="preserve">' + escapeText(piece) + '</w:t>';
  }).join('<w:tab/>');
}

var INLINES = {
  text : function (inline, rPr) {
    var _content = textXml(inline.text);
    return _content === '' ? '' : '<w:r>' + rPrXml(mergeRPr(rPr, inline.marks)) + _content + '</w:r>';
  },
  break : function (inline, rPr) {
    return '<w:r>' + rPrXml(rPr) + '<w:br/></w:r>';
  },
  // ссылка — Task 6 (w:hyperlink); до него — текст ссылки
  link : function (inline, rPr, ctx) {
    return inlinesXml(inline.children, rPr, ctx);
  },
  checkbox : function (inline, rPr, ctx) {
    return checkboxXml(inline.checked === true, rPr, ctx);
  },
  // изображение — Task 6
  image : function () {
    return '';
  }
};

/** Флажок Word (кликабельный): w:sdt с w14:checkbox и символом ☒/☐; часть получит объявление w14 */
function checkboxXml (checked, rPr, ctx) {
  ctx.job.w14 = true;
  var _rPr = rPrXml(rPr);
  return '<w:sdt><w:sdtPr>' + _rPr + '<w14:checkbox><w14:checked w14:val="' + (checked === true ? '1' : '0') + '"/>'
    + '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/>'
    + '</w14:checkbox></w:sdtPr><w:sdtContent><w:r>' + _rPr + textXml(checked === true ? '☒' : '☐') + '</w:r></w:sdtContent></w:sdt>';
}

/**
 * Inline модели → w:r
 * @param  {Object} inline  Inline модели
 * @param  {Array}  rPr     свойства текста метки [{ name, xml }]
 * @param  {Object} ctx     контекст абзаца
 * @return {String}
 */
function inlineXml (inline, rPr, ctx) {
  var _write = INLINES[inline.type];
  return _write === undefined ? '' : _write(inline, rPr, ctx);
}

function inlinesXml (inlines, rPr, ctx) {
  return inlines.map(function (inline) {
    return inlineXml(inline, rPr, ctx);
  }).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Блоки

/** Абзац: w:pPr по схеме; ожидающий разрыв страницы (ctx.pageBreak) — первым w:r */
function paraXml (pPr, runs, ctx) {
  var _runs = runs;
  if (ctx.pageBreak === true) {
    _runs = PAGE_BREAK + _runs;
    ctx.pageBreak = false;
  }
  var _pPr = pPrXml(pPr);
  return _pPr === '' && _runs === '' ? '<w:p/>' : '<w:p>' + _pPr + _runs + '</w:p>';
}

/**
 * Свойства абзаца блока: w:pPr метки (целиком — у абзацев, pre и hr вне списков; по R7 — у заголовков и внутри
 * пунктов), стиль, отступ цитаты и контейнера (ctx.indent), номер пункта (ctx.lead — первому абзацу пункта)
 * @param  {Object}      block  блок модели (quote)
 * @param  {Object}      ctx
 * @param  {String|null} style  свой стиль блока (заголовок) или null
 * @return {Object}             { pPr : [{ name, xml }], lead : { numPr, runs } | null }
 */
function blockPPr (block, ctx, style) {
  var _list = ctx.depth > 0 || style !== null ? ctx.pPr.filter(function (kid) {
    return R7.indexOf(kid.name) !== -1;
  }) : ctx.pPr;
  var _style = style;
  var _extra = ctx.indent;
  var _quote = block.quote > 0 ? block.quote : 0;
  if (_quote > 0 && ctx.options.quotetheme !== null && style === null) {
    _style = ctx.styles.ensure(ctx.options.quotetheme, 'quote');
  }
  else if (_quote > 0) {
    _extra += QUOTE_INDENT * _quote;
  }
  else if (style === null && ctx.quoteStyle !== null) {
    _style = ctx.quoteStyle;
  }
  if (_style !== null) {
    _list = setKid(_list, { name : 'w:pStyle', xml : '<w:pStyle w:val="' + escapeText(_style) + '"/>' });
  }
  var _lead = ctx.lead;
  ctx.lead = null;
  if (_lead !== null && _lead.numPr !== null) {
    _list = setKid(_list, { name : 'w:numPr', xml : _lead.numPr });
  }
  var _hanging = _lead !== null && _lead.numPr !== null ? parts.HANGING : null;
  if (_extra !== 0 || _hanging !== null) {
    _list = withIndent(_list, _extra, _hanging);
  }
  return { pPr : _list, lead : _lead };
}

/**
 * Абзац блока (свойства — blockPPr; первому абзацу пункта — номер или флажок)
 * @param  {Array} [more]  дополнительные свойства абзаца [{ name, xml }] (заменяют одноимённые)
 */
function writePara (block, runs, ctx, style, more) {
  var _props = blockPPr(block, ctx, style);
  var _pPr = _props.pPr;
  (more || []).forEach(function (kid) {
    _pPr = setKid(_pPr, kid);
  });
  if (ctx.pageBreak === true && has(_pPr, 'w:numPr') === true) {
    // разрыв перед пунктом с номером — свойством абзаца, иначе номер остался бы на прежней странице
    _pPr = setKid(_pPr, { name : 'w:pageBreakBefore', xml : '<w:pageBreakBefore/>' });
    ctx.pageBreak = false;
  }
  return paraXml(_pPr, (_props.lead !== null ? _props.lead.runs : '') + runs, ctx);
}

/** Пустой абзац после блока и абзац разрыва страницы: w:pPr метки без нумерации (в пункте — отступ пункта) */
function spacerXml (runs, ctx) {
  if (ctx.depth > 0) {
    return writePara({ quote : 0 }, runs, ctx, null);
  }
  return paraXml(ctx.pPr.filter(function (kid) {
    return kid.name !== 'w:numPr';
  }), runs, ctx);
}

/** Блоки, которые до Task 6 выводятся абзацами с их текстом */
function nestedXml (blocks, ctx) {
  return blocks.map(function (block) {
    return blockXml(block, ctx);
  }).join('');
}

/** Пункт списка: первый абзац — с номером (numPr) или флажком, прочие блоки — с отступом пункта */
function itemXml (item, numPr, ctx) {
  var _runs = '';
  if (item.checkbox !== null) {
    _runs = checkboxXml(item.checkbox, ctx.rPr, ctx) + '<w:r>' + rPrXml(ctx.rPr) + textXml(' ') + '</w:r>';
  }
  ctx.lead = { numPr : numPr, runs : _runs };
  var _out = '';
  if (item.blocks.length === 0 || LEAD_BLOCKS[item.blocks[0].type] !== true) {
    _out += writePara({ quote : 0 }, '', ctx, null);
  }
  return _out + blocksXml(item.blocks, ctx);
}

var BLOCKS = {
  para : function (block, ctx) {
    return writePara(block, inlinesXml(block.inlines, ctx.rPr, ctx), ctx, null);
  },
  // заголовок: стиль Heading1…6 (или <headingtheme>1…6); в пункте списка — оформление заголовка в абзаце пункта
  heading : function (block, ctx) {
    if (ctx.depth > 0) {
      var _rPr = ctx.rPr.concat([
        { name : 'w:b', xml : '<w:b/>' },
        { name : 'w:sz', xml : '<w:sz w:val="' + parts.HEADING_SIZES[block.level - 1] + '"/>' }
      ].filter(function (kid) {
        return has(ctx.rPr, kid.name) === false;
      }));
      return writePara(block, inlinesXml(block.inlines, _rPr, ctx), ctx, null);
    }
    var _prefix = ctx.options.headingtheme !== null ? ctx.options.headingtheme : 'Heading';
    var _style = ctx.styles.ensure(_prefix + block.level, 'heading', block.level);
    return writePara(block, inlinesXml(block.inlines, ctx.rPr, ctx), ctx, _style);
  },
  // pre: строки — через w:br (оформление Courier New уже в marks)
  pre : function (block, ctx) {
    var _break = INLINES.break(null, ctx.rPr);
    return writePara(block, block.lines.map(function (line) {
      return inlinesXml(line, ctx.rPr, ctx);
    }).join(_break), ctx, null);
  },
  // hr: пустой абзац с нижней линией и отступами 0,5em сверху и снизу
  hr : function (block, ctx) {
    return writePara(block, '', ctx, null, HR_PPR);
  },
  // список: свой w:num (номера не сквозные между списками и ячейками), уровень — глубина вложенности списков
  list : function (block, ctx) {
    var _saved = { indent : ctx.indent, depth : ctx.depth, quoteStyle : ctx.quoteStyle };
    var _themed = block.quote > 0 && ctx.options.quotetheme !== null;
    var _level = Math.min(_saved.depth, parts.LEVELS - 1);
    var _numId = null;
    var _out = '';
    block.items.forEach(function (item) {
      var _numPr = null;
      if (item.checkbox === null) {
        if (_numId === null) {
          _numId = ctx.numbering.add(block.ordered === true, _level);
        }
        _numPr = '<w:numPr><w:ilvl w:val="' + _level + '"/><w:numId w:val="' + _numId + '"/></w:numPr>';
      }
      // quote блоков пункта считается от 0 — отступ цитаты списка входит в отступ пункта
      ctx.indent = _saved.indent + (_themed === true ? 0 : QUOTE_INDENT * block.quote) + parts.LEVEL_INDENT;
      ctx.depth = _saved.depth + 1;
      ctx.quoteStyle = _themed === true ? ctx.styles.ensure(ctx.options.quotetheme, 'quote') : null;
      _out += itemXml(item, _numPr, ctx);
      ctx.indent = _saved.indent;
      ctx.depth = _saved.depth;
      ctx.quoteStyle = _saved.quoteStyle;
    });
    return _out;
  },
  // таблицы — Task 6
  table : function (block, ctx) {
    var _caption = block.caption !== null ? paraXml(ctx.pPr, inlinesXml(block.caption, ctx.rPr, ctx), ctx) : '';
    return _caption + block.rows.map(function (row) {
      return row.cells.map(function (cell) {
        return nestedXml(cell.blocks, ctx);
      }).join('');
    }).join('');
  }
};

/**
 * Блок модели → WordprocessingML (без пустого абзаца после блока)
 * @param  {Object} block  Block модели
 * @param  {Object} ctx    контекст абзаца
 * @return {String}
 */
function blockXml (block, ctx) {
  var _write = BLOCKS[block.type];
  return _write === undefined ? '' : _write(block, ctx);
}

/**
 * Блоки HTML на месте абзаца метки (и внутри пункта списка): разрывы страницы; пустой абзац после блока — только
 * на месте метки (ctx.depth 0)
 */
function blocksXml (blocks, ctx) {
  var _out = '';
  blocks.forEach(function (block) {
    // разрыв, ожидающий от списка, переходит к первому блоку пункта
    ctx.pageBreak = ctx.pageBreak === true || block.breakBefore === true;
    var _block = blockXml(block, ctx);
    if (ctx.pageBreak === true) {
      // блок не создал абзаца — разрыв отдельным абзацем перед ним
      _block = spacerXml('', ctx) + _block;
    }
    _out += _block;
    if (ctx.depth === 0 && ctx.options.nospace !== true && SPACED[block.type] === true) {
      _out += spacerXml('', ctx);
    }
    if (block.breakAfter === true) {
      _out += spacerXml(PAGE_BREAK, ctx);
    }
  });
  return _out;
}

/** w:sectPr метки — в последний абзац созданного XML (R7); если последним стоит не абзац — отдельным абзацем */
function appendSectPr (xml, sectPr) {
  if (sectPr === null) {
    return xml;
  }
  var _top = xmltree.parse(xml).root.children;
  var _last = _top.length > 0 ? _top[_top.length - 1] : null;
  if (_last === null || _last.name !== 'w:p') {
    return xml + '<w:p><w:pPr>' + sectPr + '</w:pPr></w:p>';
  }
  var _pPr = childNamed(_last, 'w:pPr');
  var _list = kids(xml, _pPr).concat([{ name : 'w:sectPr', xml : sectPr }]);
  var _start = _pPr !== null ? _pPr.start : _last.openEnd;
  var _end = _pPr !== null ? _pPr.end : _last.openEnd;
  if (_last.openEnd === _last.end) {
    // <w:p/>
    return xml.slice(0, _last.start) + '<w:p>' + pPrXml(_list) + '</w:p>' + xml.slice(_last.end);
  }
  return xml.slice(0, _start) + pPrXml(_list) + xml.slice(_end);
}

// ---------------------------------------------------------------------------------------------------------------
// Абзац метки

/**
 * Контекст абзаца для записи блоков: свойства абзаца и текста метки
 * @return {Object} { job, item, options, images, pPr, sectPr, rPr, pageBreak, numbering, styles, indent, depth, lead,
 *                   quoteStyle }
 *   pPr — дочерние w:pPr метки без w:sectPr; sectPr — XML w:sectPr метки или null; rPr — дочерние w:rPr w:r метки
 */
function paragraphCtx (xml, p, wr, item, job) {
  var _pPr = childNamed(p, 'w:pPr');
  var _sect = _pPr !== null ? childNamed(_pPr, 'w:sectPr') : null;
  return {
    job        : job,
    item       : item,
    options    : item.options,
    images     : job.images,
    pPr        : kids(xml, _pPr, ['w:sectPr']),
    sectPr     : _sect !== null ? xml.slice(_sect.start, _sect.end) : null,
    rPr        : kids(xml, childNamed(wr, 'w:rPr')),
    pageBreak  : false,
    // общие части отчёта (numbering.xml, styles.xml)
    numbering  : job.parts.numbering,
    styles     : job.parts.styles,
    // контейнер (пункт списка): прямой отступ слева, глубина списков, номер/флажок первого абзаца, стиль цитаты
    indent     : 0,
    depth      : 0,
    lead       : null,
    quoteStyle : null
  };
}

/** Открывающий тег предка при продолжении после разреза: у w:r — с его w:rPr, у w:t — с сохранением пробелов */
function reopenTag (xml, el) {
  var _tag = xmltree.startTag(xml, el);
  if (el.name === 'w:t') {
    return xmltree.putAttr(_tag, 'xml:space', 'preserve');
  }
  if (el.name === 'w:r') {
    var _rPr = childNamed(el, 'w:rPr');
    return _tag + (_rPr !== null ? xml.slice(_rPr.start, _rPr.end) : '');
  }
  return _tag;
}

/**
 * Разрез содержимого абзаца на месте жетона до уровня upTo (предок w:r): { head, tail } — XML до жетона с
 * закрытыми предками и XML после жетона с открытыми заново. w:t без текста до (после) жетона не повторяется:
 * разрез проходит по границе w:r.
 */
function cut (xml, token, upTo) {
  var _wt = token.el;
  var _wr = _wt.parent;
  var _others = _wr.children.filter(function (child) {
    return child.name !== 'w:rPr';
  });
  var _headAtRun = xml.slice(_wt.openEnd, token.pos) === '' && _others[0] === _wt;
  var _tailAtRun = xml.slice(token.pos + token.len, _wt.closeStart) === '' && _others[_others.length - 1] === _wt;
  // предки от w:t до upTo (не включая)
  var _chain = [];
  for (var _el = _wt; _el !== upTo; _el = _el.parent) {
    _chain.push(_el);
  }
  var _head;
  var _closeFrom;
  if (_headAtRun === true) {
    _head = xml.slice(0, _wr.start);
    _closeFrom = 2;
  }
  else {
    _head = xml.slice(0, _wt.start) + reopenTag(xml, _wt) + xml.slice(_wt.openEnd, token.pos);
    _closeFrom = 0;
  }
  for (var i = _closeFrom; i < _chain.length; i++) {
    _head += '</' + _chain[i].name + '>';
  }
  var _tail = '';
  var _openTo = _tailAtRun === true ? 2 : 0;
  for (var j = _chain.length - 1; j >= _openTo; j--) {
    _tail += reopenTag(xml, _chain[j]);
  }
  _tail += _tailAtRun === true ? xml.slice(_wr.end) : xml.slice(token.pos + token.len);
  return { head : _head, tail : _tail };
}

/** Часть абзаца пустая: нет w:r с содержимым кроме w:rPr (пустой w:t — не содержимое) */
function emptyPart (xml) {
  return xmltree.descendants(xmltree.parse(xml).root, ['w:r']).every(function (run) {
    return run.children.every(function (child) {
      return child.name === 'w:rPr' || child.name === 'w:lastRenderedPageBreak' || (child.name === 'w:t' && child.closeStart === child.openEnd);
    });
  });
}

/**
 * Разделить абзац (XML начинается с w:p) на месте жетона: «до» и «после» — XML абзацев или null (пустая часть).
 * У «до» w:pPr без w:sectPr, у «после» — w:pPr метки целиком.
 */
function splitParagraph (xml, p, token) {
  var _pPr = childNamed(p, 'w:pPr');
  var _contentStart = _pPr !== null ? _pPr.end : p.openEnd;
  var _parts = cut(xml, token, p);
  var _before = _parts.head.slice(_contentStart);
  var _after = _parts.tail.slice(0, _parts.tail.length - (xml.length - p.closeStart));
  var _open = xmltree.startTag(xml, p);
  var _pPrFull = _pPr !== null ? xml.slice(_pPr.start, _pPr.end) : '';
  var _pPrHead = _pPr !== null ? pPrXml(kids(xml, _pPr, ['w:sectPr'])) : '';
  return {
    before : emptyPart(_before) === true ? null : _open + _pPrHead + _before + '</w:p>',
    after  : emptyPart(_after) === true ? null : _open + _pPrFull + _after + '</w:p>'
  };
}

/** Жетоны этого рендера в XML */
function parseTokens (xml, job) {
  return xmltree.parse(xml, job.tokenRegex, function (match) {
    var _id = parseInt(match[2], 10);
    return match[1] === job.registry.nonce && job.registry.items[_id] !== undefined ? { id : _id } : null;
  });
}

/** Абзац жетона (R6: жетон — в w:t, прямом потомке w:r внутри w:p) */
function paragraphOf (token, job) {
  var _el = token.el;
  var _p = _el.name === 'w:t' && _el.parent !== null && _el.parent.name === 'w:r' ? xmltree.closest(_el, ['w:p']) : null;
  if (_p === null) {
    throw templateError(MSG_OUTSIDE, job.registry.items[token.id].source);
  }
  return _p;
}

/**
 * Переписать абзац с жетонами (XML ровно одного w:p; вложенных абзацев с жетонами в нём уже нет)
 * @return {String} XML абзацев на его месте
 */
function writeParagraph (pXml, job) {
  var _out = '';
  var _xml = pXml;
  for (;;) {
    var _parsed = parseTokens(_xml, job);
    if (_parsed.tokens.length === 0) {
      return _out + _xml;
    }
    var _token = _parsed.tokens[0];
    var _p = paragraphOf(_token, job);
    var _item = job.registry.items[_token.id];
    var _strip = _xml.slice(0, _token.pos) + _xml.slice(_token.pos + _token.len);
    if (_item.value === '') {
      _xml = _strip;
      continue;
    }
    var _ctx = paragraphCtx(_xml, _p, _token.el.parent, _item, job);
    if (_item.options.inline === true) {
      var _runs = inlinesXml(model.inlineOnly(_item.value, _item.source), _ctx.rPr, _ctx);
      if (_runs === '') {
        _xml = _strip;
        continue;
      }
      var _parts = cut(_xml, _token, _token.el.parent.parent);
      _xml = _parts.head + _runs + _parts.tail;
      continue;
    }
    var _blocks = model.parse(_item.value, _item.source);
    var _body = blocksXml(_blocks, _ctx);
    if (_body === '') {
      _xml = _strip;
      continue;
    }
    var _split = splitParagraph(_xml, _p, _token);
    _out += (_split.before !== null ? _split.before : '');
    if (_split.after === null) {
      return _out + appendSectPr(_body, _ctx.sectPr);
    }
    _out += _body;
    _xml = _split.after;
  }
}

/**
 * Объявить пространство имён w14 на корне части (если флажки записаны и его там нет). Правки абзацев не задевают
 * открывающий тег корня — его позиция в новом XML та же, что в исходном (job.root)
 */
function declareW14 (xml, job) {
  var _top = job.root.children.length > 0 ? job.root.children[0] : null;
  if (job.w14 !== true || _top === null) {
    return xml;
  }
  var _tag = xml.slice(_top.start, _top.openEnd);
  if (/\sxmlns:w14\s*=/.test(_tag) === true) {
    return xml;
  }
  return xml.slice(0, _top.start) + xmltree.putAttr(_tag, 'xmlns:w14', W14_NS) + xml.slice(_top.openEnd);
}

/**
 * Записать HTML на месте жетонов части DOCX
 * @param  {Object} job  { template, file, xml, root, tokens, registry, options, images, tokenRegex, parts }
 *                       parts — общие части отчёта (html-docx-parts.create), сохраняет вызывающий
 * @return {String}      новый XML части
 */
function write (job) {
  return declareW14(writeParagraphs(job), job);
}

function writeParagraphs (job) {
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
    // внешний абзац — в следующий проход, после вложенных: абзацы с вложенными отмечаются подъёмом по предкам
    // (линейно по числу абзацев и глубине)
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

module.exports = {
  write,
  writePara,
  blockXml,
  inlineXml,
  BLOCKS,
  INLINES
};
