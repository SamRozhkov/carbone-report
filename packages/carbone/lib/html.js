// :html (2.5.0, спецификация §34.3): HTML из данных в DOCX, ODT и HTML-шаблонах — своя реализация (чистая комната)
// по открытой документации carbone.io. Механизм — как у изображений 2.4.0 (lib/media.js):
//   1. prepare — в buildXML перед сборкой: проверка формата и литеральных параметров, «html(…)» → «html(…, <k>)»,
//      «defaultURL(x)» в той же метке → служебный «__htmlUrl(x, <k>)» (решение R4), где k ведёт к метке (для ошибок)
//      в реестре рендера options.__html.sources;
//   2. форматтер html кладёт значение и параметры в реестр options.__html.items и печатает жетон «h<ключ>i<n>» из
//      области частного использования (ключ — случайный на рендер: жетон из данных отчёта не совпадёт с ним);
//   3. finish — после сборки всех файлов (renderBuffer, до диаграмм и изображений): жетоны файлов верхнего уровня
//      заменяются разметкой — DOCX: lib/html-docx.js, ODT: lib/html-odt.js (Task 7; до него — текст модели),
//      HTML-шаблон: значение как есть. Жетон без значения убирается. До записи загружаются изображения img всех
//      жетонов (уникальные src, не больше 4 одновременно, media.loadImage — те же форматы, лимиты и белый список, что
//      у картинок-заглушек; общий счётчик 50 МБ — options.__media.total). R5: превышение лимитов — ошибка шаблона,
//      прочие ошибки (неверный data URI, SVG, хост вне списка, сбой сети) — картинка пропускается, предупреждение в
//      options.warnings.
// Старые renderXML/render() шаг finish не выполняют: :html работает только через renderBuffer.

var crypto = require('crypto');
var splitChain = require('./set').splitChain;
var xmltree = require('./xmltree');
var model = require('./html-model');
var htmlDocx = require('./html-docx');
var htmlDocxParts = require('./html-docx-parts');
var media = require('./media');
var mediaFormats = require('./media-formats');

// жетон: символы частного использования, отличные от агрегаторов (U+E000/U+E001), drop/keep (U+E010/U+E011),
// color (U+E012/U+E013), изображений (U+E020/U+E021) и ссылок (U+E030…U+E034)
var OPEN = '';
var CLOSE = '';
var TOKEN_REGEX = /h([0-9a-f]{12})i(\d+)/g;

// форматы, где работает :html; прочие — ошибка шаблона
var SUPPORTED = ['docx', 'odt', 'html', 'xhtml'];
// форматы, где img из HTML вставляется изображением (ODT — Task 7)
var IMAGE_FORMATS = ['docx'];

var MSG = {
  outside : 'html ставится в текст абзаца.',
  tooBig  : 'html: значение больше 1 МБ.'
};

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
// 1. prepare

/** Метка для ошибок: как в шаблоне — без номера k и с defaultURL вместо служебного __htmlUrl */
function sourceOf (marker) {
  var _name = (marker.source || marker.name).replace(/^_root\./, '');
  return '{' + _name + '}';
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

/** Аргументы в скобках части цепочки «name(a, b)» (строка без скобок, '' — без аргументов) */
function argsOf (part) {
  var _str = part.trim();
  var _open = _str.indexOf('(');
  return _open === -1 ? '' : _str.slice(_open + 1, _str.lastIndexOf(')')).trim();
}

function formatName (extension) {
  return typeof extension === 'string' && extension !== '' ? extension.toUpperCase() : 'этом формате';
}

/**
 * Проверить и переписать метки с :html перед сборкой (buildXML)
 * @param  {Array}  markers  метки сборки (name меняется; исходный текст — в source)
 * @param  {Object} options  опции рендера (extension; options.__html — реестр; без него — старый render(), метки
 *                           только проверяются)
 */
function prepare (markers, options) {
  var _options = options !== null && options !== undefined ? options : {};
  var _registry = _options.__html;
  var _ext = typeof _options.extension === 'string' ? _options.extension.toLowerCase() : '';
  for (var i = 0; i < markers.length; i++) {
    var _marker = markers[i];
    if (/:\s*html\b/.test(_marker.name) === false) {
      continue;
    }
    var _chain = splitChain(_marker.name);
    var _names = _chain.map(function (part) {
      return part.trim().split('(')[0].trim();
    });
    if (_names.indexOf('html', 1) === -1) {
      continue;
    }
    var _source = sourceOf(_marker);
    if (_ext !== '' && SUPPORTED.indexOf(_ext) === -1) {
      throw templateError('html не поддерживается в ' + formatName(_options.extension) + '.', _source);
    }
    // форматтер после html испортил бы жетон; defaultURL (R4) — допустим
    for (var a = _names.indexOf('html', 1) + 1; a < _names.length; a++) {
      if (_names[a] !== 'defaultURL' && _names[a] !== '__htmlUrl') {
        throw templateError('html должен быть последним форматтером.', _source);
      }
    }
    // литералы проверяются сразу (и в метке, которая при сборке не выполнится); пути (.x, d.x, c.x) — при сборке
    for (var j = 1; j < _chain.length; j++) {
      if (_names[j] === 'html') {
        model.parseOptions(splitArgs(argsOf(_chain[j])).filter(function (arg) {
          return /^\s*'/.test(arg) === true || /^\s*(?:\.|[dc]\.)/.test(arg) === false;
        }).map(unquote), _source);
      }
    }
    if (_registry === undefined || _registry === null) {
      continue;
    }
    var _k = _registry.sources.length;
    _registry.sources.push(_source);
    for (var n = 1; n < _chain.length; n++) {
      var _args = argsOf(_chain[n]);
      if (_names[n] === 'html') {
        _chain[n] = 'html(' + (_args !== '' ? _args + ', ' : '') + _k + ')';
      }
      else if (_names[n] === 'defaultURL') {
        // R4: запасной адрес ссылок внутри HTML; значение метки не меняется
        _chain[n] = '__htmlUrl(' + (_args !== '' ? _args : '\'\'') + ', ' + _k + ')';
      }
    }
    _marker.source = _source.slice(1, -1);
    _marker.name = _chain.join(':');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. форматтеры

/**
 * HTML из данных вставляется разметкой документа (DOCX, ODT) или как есть (HTML-шаблон). Параметры через запятую:
 * inline, nospace, headingtheme:<префикс>, tabletheme:<стиль>, quotetheme:<стиль>.
 *
 * @version 2.5.0
 * @param {Mixed}  d
 * @param {String} options  параметры; последний аргумент — внутренний номер метки (дописывается до сборки)
 */
function html (d) {
  var _registry = this.__html;
  var _url = this.__htmlUrl;
  this.__htmlUrl = null;
  if (_registry === undefined || _registry === null || arguments.length < 2) {
    return d;
  }
  var _args = Array.prototype.slice.call(arguments, 1);
  var _k = String(_args.pop());
  var _source = _registry.sources[_k];
  if (/^\d+$/.test(_k) === false || _source === undefined) {
    return d;
  }
  var _options = model.parseOptions(_args.map(function (arg) {
    return arg === null || arg === undefined ? '' : String(arg);
  }), _source);
  if (d === null || d === undefined || d === '') {
    return '';
  }
  var _value = String(d);
  if (Buffer.byteLength(_value, 'utf8') > model.MAX_BYTES) {
    throw templateError(MSG.tooBig, _source);
  }
  _registry.items.push({
    value      : _value,
    options    : _options,
    source     : _source,
    defaultUrl : _url !== undefined && _url !== null && _url.k === _k ? _url.url : null
  });
  return OPEN + 'h' + _registry.nonce + 'i' + (_registry.items.length - 1) + CLOSE;
}

/**
 * Служебный (R4): defaultURL в метке с :html — запасной адрес для ссылок внутри HTML; значение не меняется
 *
 * @private
 * @param {Mixed}  d
 * @param {String} url  запасной адрес
 * @param {String} k    внутренний номер метки
 */
function __htmlUrl (d, url, k) {
  this.__htmlUrl = { k : String(k), url : url === null || url === undefined ? '' : String(url) };
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. finish

/** Текст блоков модели (ODT до Task 7): блоки через пробел */
function plainText (blocks) {
  var _parts = [];
  var _inlines = function (list) {
    return list.map(function (inline) {
      if (inline.type === 'text') {
        return inline.text;
      }
      if (inline.type === 'link') {
        return _inlines(inline.children);
      }
      return inline.type === 'break' ? ' ' : '';
    }).join('');
  };
  var _walk = function (block) {
    if (block.type === 'para' || block.type === 'heading') {
      _parts.push(_inlines(block.inlines));
    }
    else if (block.type === 'pre') {
      _parts.push(block.lines.map(_inlines).join(' '));
    }
    else if (block.type === 'list') {
      block.items.forEach(function (item) {
        item.blocks.forEach(_walk);
      });
    }
    else if (block.type === 'table') {
      if (block.caption !== null) {
        _parts.push(_inlines(block.caption));
      }
      block.rows.forEach(function (row) {
        row.cells.forEach(function (cell) {
          cell.blocks.forEach(_walk);
        });
      });
    }
  };
  blocks.forEach(_walk);
  return _parts.join(' ');
}

function escapeXml (str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** ODT до Task 7: жетон → текст модели */
function writeOdtText (job) {
  return job.xml.replace(TOKEN_REGEX, function (all, nonce, id) {
    var _item = nonce === job.registry.nonce ? job.registry.items[id] : undefined;
    if (_item === undefined) {
      return all;
    }
    return escapeXml(_item.options.inline === true
      ? plainText([{ type : 'para', inlines : model.inlineOnly(_item.value, _item.source) }])
      : plainText(model.parse(_item.value, _item.source)));
  });
}

/**
 * Изображения img из HTML (R5): уникальные src, не больше media.CONCURRENCY загрузок одновременно
 * @param  {Map}    sources  src → метка (первая, где он встретился) — для ошибок и предупреждений
 * @param  {Object} options  опции рендера (imageUrlAllowlist, imageUrlTimeoutMs, warnings, __media)
 * @return {Promise<Map>}    src → { buffer, type, width, height } или null (картинка пропускается)
 */
function loadImages (sources, options) {
  var _srcs = Array.from(sources.keys());
  return media.loadAll(_srcs, media.CONCURRENCY, function (src, i, signal) {
    var _item = { value : src, kind : 'image', source : sources.get(src), strictLimits : true };
    return media.loadImage(_item, options, signal).then(function (image) {
      // общий лимит отчёта (вместе с картинками-заглушками media.finish)
      media.countTotal(options, image, _item.source);
      return image;
    }, function (error) {
      if (error !== null && typeof error === 'object' && error.limit === true) {
        throw error;
      }
      if (Array.isArray(options.warnings) === true) {
        var _message = String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error);
        options.warnings.push('изображение не вставлено: ' + _message.replace(/ Source: "[\s\S]*"$/, '') + ' Метка: ' + _item.source);
      }
      return null;
    });
  }).then(function (images) {
    var _map = new Map();
    _srcs.forEach(function (src, i) {
      _map.set(src, images[i]);
    });
    return _map;
  });
}

/** Связи части, которые создаются при первом обращении (без ссылок и изображений .rels части не трогается) */
function lazyLinks (fmt, template, partName) {
  var _links = null;
  var _get = function () {
    if (_links === null) {
      _links = fmt.links(template, partName);
    }
    return _links;
  };
  return {
    ref : function (mediaPath) {
      return _get().ref(mediaPath);
    },
    link : function (url) {
      return _get().link(url);
    },
    save : function () {
      if (_links !== null) {
        _links.save();
      }
    }
  };
}

/**
 * Заменить жетоны :html после сборки всех файлов (renderBuffer, после walkFiles, до диаграмм и изображений)
 * @param  {Object} template  собранный шаблон { files, extension, reportName }
 * @param  {Object} options   опции рендера (реестр options.__html)
 * @return {Promise<void>}
 */
function finish (template, options) {
  var _registry = options !== null && options !== undefined ? options.__html : undefined;
  if (_registry === undefined || _registry === null || _registry.items.length === 0 || template === null || Array.isArray(template.files) === false) {
    return Promise.resolve();
  }
  return Promise.resolve().then(function () {
    var _ext = String(template.extension || options.extension || '').toLowerCase();
    var _own = function (match) {
      var _id = parseInt(match[2], 10);
      return match[1] === _registry.nonce && _registry.items[_id] !== undefined ? { id : _id } : null;
    };
    // R6: имя отчёта — не текст абзаца
    if (typeof template.reportName === 'string' && template.reportName.indexOf(OPEN) !== -1) {
      var _inName = xmltree.parse(template.reportName, TOKEN_REGEX, _own).tokens;
      if (_inName.length > 0) {
        throw templateError(MSG.outside, _registry.items[_inName[0].id].source);
      }
    }
    var _jobs = [];
    // копия списка: части пакета могут добавлять файлы по ходу
    template.files.slice().forEach(function (file) {
      if ((file.parent !== '' && file.parent !== undefined) || typeof file.data !== 'string' || file.data.indexOf(OPEN) === -1) {
        return;
      }
      if (_ext === 'html' || _ext === 'xhtml') {
        file.data = file.data.replace(TOKEN_REGEX, function (all, nonce, id) {
          return nonce === _registry.nonce && _registry.items[id] !== undefined ? _registry.items[id].value : all;
        });
        return;
      }
      var _parsed = xmltree.parse(file.data, TOKEN_REGEX, _own);
      if (_parsed.tokens.length === 0) {
        return;
      }
      _jobs.push({
        template   : template,
        file       : file,
        xml        : file.data,
        root       : _parsed.root,
        tokens     : _parsed.tokens,
        registry   : _registry,
        options    : options,
        images     : null,
        links      : null,
        media      : null,
        tokenRegex : TOKEN_REGEX,
        parts      : null
      });
    });
    if (_jobs.length === 0) {
      return;
    }
    // img всех жетонов: модель разбирается здесь один раз (model.content запоминает её в записи реестра)
    var _sources = new Map();
    if (IMAGE_FORMATS.indexOf(_ext) !== -1) {
      _jobs.forEach(function (job) {
        job.tokens.forEach(function (token) {
          var _item = _registry.items[token.id];
          if (_item.value === '') {
            return;
          }
          model.eachImage(model.content(_item), function (src) {
            if (_sources.has(src) === false) {
              _sources.set(src, _item.source);
            }
          });
        });
      });
    }
    return loadImages(_sources, options).then(function (images) {
      var _fmt = mediaFormats.formatOf(_ext);
      // numbering.xml и styles.xml — общие для тела и колонтитулов, записываются после всех частей; media-файлы —
      // общие для отчёта
      var _parts = _ext === 'docx' ? htmlDocxParts.create(template) : null;
      var _store = _fmt !== null ? mediaFormats.storeMedia(template, _fmt) : null;
      _jobs.forEach(function (job) {
        job.images = images;
        job.parts = _parts;
        job.media = _store;
        job.links = _fmt !== null ? lazyLinks(_fmt, template, job.file.name) : null;
        job.file.data = _ext === 'docx' ? htmlDocx.write(job) : writeOdtText(job);
        if (job.links !== null) {
          job.links.save();
        }
      });
      if (_store !== null) {
        _store.register();
      }
      if (_parts !== null) {
        _parts.save();
      }
    });
  });
}

module.exports = {
  createRegistry,
  prepare,
  finish,
  formatters : { html, __htmlUrl },
  TOKEN_REGEX,
  MSG
};
