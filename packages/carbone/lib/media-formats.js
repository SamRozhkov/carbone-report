// Правила форматов для изображений из данных (lib/media.js): где картинка-заглушка и её замещающий текст, как
// поменять ссылку на файл и размеры, куда записать связь (OOXML: .rels и [Content_Types].xml; OpenDocument:
// META-INF/manifest.xml). Порядок работы и загрузка данных — в media.js.

var path = require('path');
var xmltree = require('./xmltree');

var closest = xmltree.closest;
var descendants = xmltree.descendants;
var startTag = xmltree.startTag;
var attr = xmltree.attr;
var setAttr = xmltree.setAttr;
var putAttr = xmltree.putAttr;

// тип изображения (по заголовку файла) → расширение и MIME
var TYPES = {
  png  : { ext : 'png', mime : 'image/png' },
  jpeg : { ext : 'jpeg', mime : 'image/jpeg' },
  gif  : { ext : 'gif', mime : 'image/gif' }
};

var EMU_PER_PX = 9525; // 96 dpi
var EMU_PER_PT = 12700;
var MM_PER_PX = 25.4 / 96;
var IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
var RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
var HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

function isTop (file) {
  return file.parent === '' || file.parent === undefined;
}

function topFile (template, name) {
  var _file = template.files.find(function (f) {
    return f.name === name && isTop(f);
  });
  if (_file !== undefined && Buffer.isBuffer(_file.data) === true) {
    _file.data = _file.data.toString('utf8');
  }
  return _file;
}

/**
 * Добавить файл верхнего уровня архива. Перед файлами вложенных архивов (xl/embeddings/*.xlsx и т. п.):
 * zipFiles (lib/file.js) собирает их по группам с конца списка, файл верхнего уровня после них стал бы
 * отдельным архивом с пустым именем
 */
function addFile (template, file) {
  var _index = template.files.findIndex(function (f) {
    return isTop(f) === false;
  });
  if (_index === -1) {
    template.files.push(file);
  }
  else {
    template.files.splice(_index, 0, file);
  }
  return file;
}

/** Размер изображения в рамке по режиму imageFit (в единицах рамки, без округления); без рамки — px × perPx */
function fitSize (frame, image, fit, perPx) {
  if (frame === null) {
    return { cx : image.width * perPx, cy : image.height * perPx };
  }
  if (fit === 'fill') {
    return { cx : frame.cx, cy : frame.cy };
  }
  var _scale = frame.cx / image.width;
  if (fit === 'contain') {
    _scale = Math.min(_scale, frame.cy / image.height);
  }
  return { cx : image.width * _scale, cy : image.height * _scale };
}

/** Размер в EMU по рамке { cx, cy } в EMU (или null) */
function fitEmu (frame, image, fit) {
  var _size = fitSize(frame, image, fit, EMU_PER_PX);
  return { cx : Math.round(_size.cx), cy : Math.round(_size.cy) };
}

/** Рамка { cx, cy } из атрибутов cx/cy элемента (EMU) или null */
function emuFrame (xml, el) {
  if (el === undefined || el === null) {
    return null;
  }
  var _cx = parseInt(attr(xml, el, 'cx'), 10);
  var _cy = parseInt(attr(xml, el, 'cy'), 10);
  return _cx > 0 && _cy > 0 ? { cx : _cx, cy : _cy } : null;
}

function setEmu (size) {
  return function (tag) {
    return setAttr(setAttr(tag, 'cx', String(size.cx)), 'cy', String(size.cy));
  };
}

/** a:ext внутри a:xfrm (размер фигуры), не a:ext расширений a:extLst */
function xfrmExts (container) {
  return descendants(container, ['a:ext']).filter(function (x) {
    return x.parent !== null && x.parent.name === 'a:xfrm';
  });
}

/**
 * Ссылка a:blip r:embed на новую связь; расширение a:blip с SVG-версией картинки (asvg:svgBlip) удаляется —
 * иначе Office показал бы старую картинку
 */
function blipEdits (container, ref) {
  var _edits = [];
  descendants(container, ['a:blip']).forEach(function (el) {
    _edits.push({ el : el, tag : function (tag) {
      return putAttr(tag, 'r:embed', ref);
    } });
  });
  descendants(container, ['asvg:svgBlip']).forEach(function (el) {
    var _ext = closest(el, ['a:ext']);
    _edits.push({ el : _ext !== null ? _ext : el, remove : true });
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

/** Позиции замещающего текста (содержимое элементов names) у картинок */
function textAltRanges (names, container) {
  return function (xml, root) {
    return descendants(root, names).filter(function (el) {
      return el.openEnd < el.closeStart && xml.slice(el.openEnd, el.closeStart).indexOf('{') !== -1 && container(el) !== null;
    }).map(function (el) {
      return { start : el.openEnd, end : el.closeStart };
    });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DOCX

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
 * @return {Array} [{ el, tag : function (startTag) → startTag } | { el, remove : true }]
 */
function wordPlace (xml, container, image, ref, fit) {
  var _extents = descendants(container, ['wp:extent']);
  var _vmlShapes = descendants(container, ['v:imagedata']).map(function (x) {
    return x.parent;
  }).filter(function (x) {
    return x !== null && attr(xml, x, 'style') !== null;
  });
  var _frame = emuFrame(xml, _extents[0]);
  if (_frame === null && _vmlShapes.length > 0) {
    var _style = attr(xml, _vmlShapes[0], 'style');
    var _w = vmlSize(_style, 'width');
    var _h = vmlSize(_style, 'height');
    if (_w !== null && _h !== null) {
      _frame = { cx : _w, cy : _h };
    }
  }
  var _size = fitEmu(_frame, image, fit);
  var _edits = _extents.concat(xfrmExts(container)).map(function (el) {
    return { el : el, tag : setEmu(_size) };
  });
  _edits = _edits.concat(blipEdits(container, ref));
  descendants(container, ['v:imagedata']).forEach(function (el) {
    _edits.push({ el : el, tag : function (tag) {
      return putAttr(tag, 'r:id', ref);
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

// ---------------------------------------------------------------------------------------------------------------
// PPTX

function slideContainer (el) {
  return closest(el, ['p:pic']);
}

/** Картинка слайда: рамка и размер — a:xfrm/a:ext в p:spPr, ссылка — a:blip r:embed */
function slidePlace (xml, container, image, ref, fit) {
  var _exts = xfrmExts(container);
  var _size = fitEmu(emuFrame(xml, _exts[0]), image, fit);
  return _exts.map(function (el) {
    return { el : el, tag : setEmu(_size) };
  }).concat(blipEdits(container, ref));
}

// ---------------------------------------------------------------------------------------------------------------
// XLSX

var SHEET_ANCHORS = ['xdr:oneCellAnchor', 'xdr:twoCellAnchor', 'xdr:absoluteAnchor'];

/** Картинка листа: привязка с xdr:pic целиком (без неё привязка недопустима) или xdr:pic в группе */
function sheetContainer (el) {
  var _pic = closest(el, ['xdr:pic']);
  if (_pic === null) {
    return null;
  }
  return _pic.parent !== null && SHEET_ANCHORS.indexOf(_pic.parent.name) !== -1 ? _pic.parent : _pic;
}

/**
 * Картинка листа: размер меняется только у oneCellAnchor/absoluteAnchor (xdr:ext и a:xfrm/a:ext); у twoCellAnchor
 * размер задают ячейки from/to — он остаётся, меняется только ссылка a:blip r:embed
 */
function sheetPlace (xml, container, image, ref, fit) {
  var _edits = blipEdits(container, ref);
  if (container.name !== 'xdr:oneCellAnchor' && container.name !== 'xdr:absoluteAnchor') {
    return _edits;
  }
  var _ext = container.children.filter(function (x) {
    return x.name === 'xdr:ext';
  });
  var _size = fitEmu(emuFrame(xml, _ext[0]), image, fit);
  return _ext.concat(xfrmExts(container)).map(function (el) {
    return { el : el, tag : setEmu(_size) };
  }).concat(_edits);
}

// ---------------------------------------------------------------------------------------------------------------
// OpenDocument (ODT, ODS, ODP)

function isPictureFrame (frame) {
  return frame.children.some(function (x) {
    return x.name === 'draw:image';
  });
}

/** Рамка draw:frame, у которой draw:image — прямой потомок (не надпись с картинками внутри) */
function odfContainer (el) {
  var _frame = el.parent !== null && el.parent.name === 'draw:frame' && (el.name === 'svg:title' || el.name === 'svg:desc') ? el.parent : closest(el, ['draw:frame']);
  return _frame !== null && isPictureFrame(_frame) === true ? _frame : null;
}

// длины ODF в мм
var ODF_UNITS = { cm : 10, mm : 1, in : 25.4, pt : 25.4 / 72, pc : 25.4 / 6, px : MM_PER_PX };

function odfLength (value) {
  var _match = /^\s*([\d.]+)\s*(cm|mm|in|pt|pc|px)\s*$/.exec(value || '');
  if (_match === null || !(parseFloat(_match[1]) > 0)) {
    return null;
  }
  return { mm : parseFloat(_match[1]) * ODF_UNITS[_match[2]], unit : _match[2] };
}

function formatLength (mm, unit) {
  return String(Math.round(mm / ODF_UNITS[unit] * 10000) / 10000) + unit;
}

/**
 * Рамка ODF: svg:width/svg:height по imageFit в исходных единицах рамки (без размеров — в см по 96 dpi;
 * размер в неизвестных единицах не меняется), у draw:image — xlink:href на новый файл и тип
 */
function odfPlace (xml, frame, image, ref, fit) {
  var _wAttr = attr(xml, frame, 'svg:width');
  var _hAttr = attr(xml, frame, 'svg:height');
  var _w = odfLength(_wAttr);
  var _h = odfLength(_hAttr);
  var _edits = [];
  if ((_w !== null && _h !== null) || (_wAttr === null && _hAttr === null)) {
    var _size = fitSize(_w !== null ? { cx : _w.mm, cy : _h.mm } : null, image, fit, MM_PER_PX);
    _edits.push({ el : frame, tag : function (tag) {
      return putAttr(putAttr(tag, 'svg:width', formatLength(_size.cx, _w !== null ? _w.unit : 'cm')), 'svg:height', formatLength(_size.cy, _h !== null ? _h.unit : 'cm'));
    } });
  }
  var _mime = TYPES[image.type].mime;
  frame.children.forEach(function (el) {
    if (el.name !== 'draw:image') {
      return;
    }
    var _hasHref = attr(xml, el, 'xlink:href') !== null;
    _edits.push({ el : el, tag : function (tag) {
      var _tag = putAttr(tag, 'xlink:href', ref);
      if (_hasHref === false) {
        _tag = putAttr(putAttr(putAttr(_tag, 'xlink:type', 'simple'), 'xlink:show', 'embed'), 'xlink:actuate', 'onLoad');
      }
      ['draw:mime-type', 'loext:mime-type'].forEach(function (name) {
        if (attr(xml, el, name) !== null) {
          _tag = setAttr(_tag, name, _mime);
        }
      });
      return _tag;
    } });
    // картинка, встроенная в XML (base64), заменяется файлом
    el.children.forEach(function (child) {
      if (child.name === 'office:binary-data') {
        _edits.push({ el : child, remove : true });
      }
    });
  });
  return _edits;
}

// ---------------------------------------------------------------------------------------------------------------
// Связи и регистрация файлов

/** Путь файла связей части OOXML: word/document.xml → word/_rels/document.xml.rels */
function relsPath (name) {
  return path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels');
}

function escapeAttr (value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Путь media-файла относительно папки части (word/document.xml → media/x.png, ppt/slides/… → ../media/x.png) */
function relativeTo (partName, mediaPath) {
  return path.posix.relative(path.posix.dirname(partName), mediaPath);
}

/**
 * OOXML: связи части (существующий .rels или новый); ref(mediaPath) → Id связи-изображения (новой или уже
 * добавленной), link(url) → Id внешней связи-гиперссылки (TargetMode="External"; :html), save() дописывает новые
 * связи в порядке добавления
 */
function ooxmlLinks (template, partName) {
  var _name = relsPath(partName);
  var _file = topFile(template, _name);
  if (_file === undefined) {
    _file = addFile(template, { name : _name, data : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + RELS_NS + '"></Relationships>', isMarked : false, parent : '' });
  }
  var _ids = new Set();
  _file.data.replace(/\sId\s*=\s*(?:"([^"]*)"|'([^']*)')/g, function (all, double, single) {
    _ids.add(double !== undefined ? double : single);
    return all;
  });
  // ключ (вид + адрес) → { id, xml } новой связи
  var _added = new Map();
  var _counters = { img : 0, lnk : 0 };
  var _add = function (key, prefix, xml) {
    if (_added.has(key) === false) {
      var _id;
      do {
        _id = 'rIdCr' + (prefix === 'img' ? 'Img' : 'Lnk') + (++_counters[prefix]);
      } while (_ids.has(_id) === true);
      _ids.add(_id);
      _added.set(key, { id : _id, xml : xml(_id) });
    }
    return _added.get(key).id;
  };
  return {
    ref : function (mediaPath) {
      var _target = relativeTo(partName, mediaPath);
      return _add('i' + _target, 'img', function (id) {
        return '<Relationship Id="' + id + '" Type="' + IMAGE_REL + '" Target="' + escapeAttr(_target) + '"/>';
      });
    },
    link : function (url) {
      return _add('l' + url, 'lnk', function (id) {
        return '<Relationship Id="' + id + '" Type="' + HYPERLINK_REL + '" Target="' + escapeAttr(url) + '" TargetMode="External"/>';
      });
    },
    save : function () {
      if (_added.size === 0) {
        return;
      }
      var _xml = '';
      _added.forEach(function (rel) {
        _xml += rel.xml;
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

/** OOXML: Default Extension для типов новых media-файлов в [Content_Types].xml (если их ещё нет) */
function addContentTypes (template, media) {
  var _file = topFile(template, '[Content_Types].xml');
  if (_file === undefined) {
    return;
  }
  var _xml = '';
  var _seen = new Set();
  media.forEach(function (m) {
    var _type = TYPES[m.type];
    if (_seen.has(_type.ext) === true) {
      return;
    }
    _seen.add(_type.ext);
    if (new RegExp('<Default\\s[^>]*Extension\\s*=\\s*["\']' + _type.ext + '["\']', 'i').test(_file.data) === false) {
      _xml += '<Default Extension="' + _type.ext + '" ContentType="' + _type.mime + '"/>';
    }
  });
  var _close = _file.data.lastIndexOf('</Types>');
  if (_xml !== '' && _close !== -1) {
    _file.data = _file.data.slice(0, _close) + _xml + _file.data.slice(_close);
  }
}

/** OpenDocument: ссылка — путь файла относительно части, адрес гиперссылки — как есть; связей нет */
function odfLinks (template, partName) {
  return {
    ref : function (mediaPath) {
      return relativeTo(partName, mediaPath);
    },
    link : function (url) {
      return url;
    },
    save : function () {}
  };
}

/** OpenDocument: manifest:file-entry с типом для новых файлов в META-INF/manifest.xml */
function addManifest (template, media) {
  var _file = topFile(template, 'META-INF/manifest.xml');
  if (_file === undefined) {
    return;
  }
  var _xml = '';
  media.forEach(function (m) {
    if (_file.data.indexOf('manifest:full-path="' + m.name + '"') === -1) {
      _xml += '<manifest:file-entry manifest:full-path="' + escapeAttr(m.name) + '" manifest:media-type="' + TYPES[m.type].mime + '"/>';
    }
  });
  var _close = _file.data.lastIndexOf('</manifest:manifest>');
  if (_xml !== '' && _close !== -1) {
    _file.data = _file.data.slice(0, _close) + _xml + _file.data.slice(_close);
  }
}

/**
 * Уникальные id картинок части после циклов: элементы names (wp:docPr, p:cNvPr, xdr:cNvPr) внутри заменённых
 * картинок (kept) с уже встречавшимся id получают новые id выше максимума части. Повторы вне картинок не трогаются.
 * @return {Array} [{ el, tag }]
 */
function uniqueIds (xml, root, names, kept) {
  var _all = descendants(root, names);
  var _max = 0;
  _all.forEach(function (el) {
    var _id = parseInt(attr(xml, el, 'id'), 10);
    if (_id > _max) {
      _max = _id;
    }
  });
  var _inKept = function (el) {
    for (var _el = el; _el !== null; _el = _el.parent) {
      if (kept.has(_el) === true) {
        return true;
      }
    }
    return false;
  };
  var _seen = new Set();
  var _edits = [];
  _all.forEach(function (el) {
    var _id = attr(xml, el, 'id');
    if (_id === null) {
      return;
    }
    if (_seen.has(_id) === true && _inKept(el) === true) {
      var _new = String(++_max);
      _edits.push({ el : el, tag : function (tag) {
        return setAttr(tag, 'id', _new);
      } });
      return;
    }
    _seen.add(_id);
  });
  return _edits;
}

/**
 * Хранилище media-файлов отчёта (общее для частей одного шага: media.finish или html.finish)
 * @param  {Object} template  собранный шаблон { files }
 * @param  {Object} fmt       правила формата (formatOf)
 * @return {Object} { path(image) → путь нового media-файла (одно изображение — один файл), register() — регистрация
 *                  новых файлов в пакете ([Content_Types].xml или manifest.xml) }
 */
function storeMedia (template, fmt) {
  var _names = new Set(template.files.map(function (f) {
    return f.name;
  }));
  var _mediaOf = new Map(); // изображение → путь media-файла
  var _media = []; // новые файлы [{ name, type }]
  var _counter = 0;
  return {
    path : function (image) {
      if (_mediaOf.has(image) === false) {
        var _name;
        do {
          _name = fmt.mediaDir + 'cr-img-' + (++_counter) + '.' + TYPES[image.type].ext;
        } while (_names.has(_name) === true);
        _names.add(_name);
        _mediaOf.set(image, _name);
        _media.push({ name : _name, type : image.type });
        addFile(template, { name : _name, data : image.buffer, isMarked : false, parent : '' });
      }
      return _mediaOf.get(image);
    },
    register : function () {
      if (_media.length > 0) {
        fmt.register(template, _media);
      }
    }
  };
}

/**
 * Правила форматов по семействам (xmltree.family). Каждое:
 *   altHint              — быстрая проверка файла до разбора: есть ли метка в замещающем тексте;
 *   altRanges(xml, root) → [{ start, end }] — где метка становится меткой изображения (решение R2);
 *   container(el)        → контейнер картинки вокруг элемента с жетоном или null (он же удаляется при пустом значении);
 *   place(xml, container, image, ref, fit) → правки внутри контейнера: [{ el, tag(startTag) }] или [{ el, remove }];
 *   links(template, partName) → { ref(mediaPath) → ссылка для place, link(url) → ссылка гиперссылки, save() };
 *   register(template, media) — регистрация новых файлов [{ name, type }] в пакете;
 *   idTags               — элементы с id, уникальным в части (повторы после циклов перенумеровываются);
 *   mediaDir             — папка media-файлов в архиве.
 */
var OOXML_ALT_HINT = /\s(?:descr|title)\s*=\s*(?:"[^"]*\{|'[^']*\{)/;

var FORMATS = {
  w : {
    altHint   : /\s(?:descr|title|alt|o:title)\s*=\s*(?:"[^"]*\{|'[^']*\{)/,
    altRanges : attrAltRanges({
      'wp:docPr'    : ['descr', 'title'],
      'pic:cNvPr'   : ['descr', 'title'],
      'v:shape'     : ['alt', 'o:title'],
      'v:rect'      : ['alt', 'o:title'],
      'v:imagedata' : ['o:title']
    }, wordContainer),
    container : wordContainer,
    place     : wordPlace,
    links     : ooxmlLinks,
    register  : addContentTypes,
    idTags    : ['wp:docPr'],
    mediaDir  : 'word/media/'
  },
  p : {
    altHint   : OOXML_ALT_HINT,
    altRanges : attrAltRanges({ 'p:cNvPr' : ['descr', 'title'] }, slideContainer),
    container : slideContainer,
    place     : slidePlace,
    links     : ooxmlLinks,
    register  : addContentTypes,
    idTags    : ['p:cNvPr'],
    mediaDir  : 'ppt/media/'
  },
  x : {
    altHint   : OOXML_ALT_HINT,
    altRanges : attrAltRanges({ 'xdr:cNvPr' : ['descr', 'title'] }, sheetContainer),
    container : sheetContainer,
    place     : sheetPlace,
    links     : ooxmlLinks,
    register  : addContentTypes,
    idTags    : ['xdr:cNvPr'],
    mediaDir  : 'xl/media/'
  },
  odf : {
    altHint   : /<svg:(?:title|desc)\b[^>]*>[^<]*\{/,
    altRanges : textAltRanges(['svg:title', 'svg:desc'], odfContainer),
    container : odfContainer,
    place     : odfPlace,
    links     : odfLinks,
    register  : addManifest,
    idTags    : null,
    mediaDir  : 'Pictures/'
  }
};

// поддержанные расширения шаблона (family() относит к 'odf' и текстовые шаблоны)
var SUPPORTED = ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp'];

/** Правила формата шаблона или null (формат без изображений из данных) */
function formatOf (extension) {
  var _ext = typeof extension === 'string' ? extension.toLowerCase() : '';
  return SUPPORTED.indexOf(_ext) === -1 ? null : FORMATS[xmltree.family(_ext)];
}

module.exports = {
  formatOf,
  addFile,
  topFile,
  relsPath,
  RELS_NS,
  uniqueIds,
  storeMedia,
  fitSize,
  TYPES
};
