// Агрегаторы Carbone EE (aggSum … cumCountD, count()) — своя реализация (чистая комната) по открытой документации
// (docs/superpowers/notes/2026-10-10-ee-aggregators-drop-sort.md §1, спецификация §31.1).
//
// Агрегат зависит от всего набора, а обычный форматтер видит одно значение, поэтому метка с агрегатором
// разбирается до сборки документа:
//   1. проход элементов — синтетическая сборка (как у :set, lib/set.js) пути метки, где «[]» и «[фильтр]» стали
//      циклом «[i]», с форматтерами до агрегатора и внутренним __aggItem: он запоминает значение, ключ partition-by
//      и индексы циклов, а печатает жетон — по жетонам в результате видно, какие строки вывелись и в каком порядке;
//   2. проход строк (только для «[]») — синтетическая сборка пути до первой «[]»: строки вывода (элемент внешнего
//      цикла или одна строка вне цикла) в порядке вывода;
//   3. расчёт по цепочке агрегаторов; метка документа переписывается в «{путь строки:__aggOut(n):форматтеры после}»,
//      __aggOut отдаёт готовое значение по индексам циклов строки.
// Шаблон без агрегаторов не затрагивается.

var set = require('./set');

var AGG = ['aggSum', 'aggAvg', 'aggMin', 'aggMax', 'aggCount', 'aggCountD', 'aggStr', 'aggStrD'];
var CUM = ['cumSum', 'cumCount', 'cumCountD'];

// жетон порядка вывода: символы из области частного использования (builder вырезает только управляющие)
var TOKEN_OPEN = '';
var TOKEN_CLOSE = '';
var TOKEN_REGEX = /(\d+)/g;

function isAggregator (name) {
  return AGG.indexOf(name) !== -1 || CUM.indexOf(name) !== -1;
}

/**
 * Имя и аргументы форматтера: «aggStr(' | ',.brand)» → { name: 'aggStr', args: ["' | '", '.brand'] }
 * Запятые внутри кавычек аргумент не делят.
 */
function parseFormatter (str) {
  var _open = str.indexOf('(');
  if (_open === -1) {
    return { name : str.trim(), args : [] };
  }
  var _name = str.slice(0, _open).trim();
  var _inside = str.slice(_open + 1, str.lastIndexOf(')'));
  var _args = _inside.trim() === '' ? [] : splitArgs(_inside);
  return { name : _name, args : _args };
}

/**
 * Разделить по запятым вне кавычек
 */
function splitArgs (str) {
  var _args = [];
  var _current = '';
  var _quote = false;
  for (var i = 0; i < str.length; i++) {
    var _char = str[i];
    if (_char === '\'') {
      _quote = !_quote;
    }
    if (_char === ',' && _quote === false) {
      _args.push(_current.trim());
      _current = '';
      continue;
    }
    _current += _char;
  }
  _args.push(_current.trim());
  return _args;
}

function unquote (arg) {
  var _match = /^'([\s\S]*)'$/.exec(arg);
  return _match !== null ? _match[1] : arg;
}

/**
 * Скобки пути верхнего уровня: [{ start, end, items, iter, filters }]
 * iter — слова итератора (i, sort, …), filters — условия (sort>1), plusOne — есть «+1» (строка-разделитель).
 */
function parseBrackets (path) {
  var _res = [];
  var _depth = 0;
  var _quote = false;
  var _start = -1;
  for (var i = 0; i < path.length; i++) {
    var _char = path[i];
    if (_char === '\'') {
      _quote = !_quote;
    }
    else if (_quote === false && _char === '[') {
      if (_depth === 0) {
        _start = i;
      }
      _depth++;
    }
    else if (_quote === false && _char === ']') {
      _depth--;
      if (_depth === 0) {
        _res.push(classifyBracket(_start, i, path.slice(_start + 1, i)));
      }
    }
  }
  return _res;
}

function classifyBracket (start, end, inside) {
  var _items = inside.trim() === '' ? [] : splitArgs(inside);
  var _iter = [];
  var _filters = [];
  var _plusOne = false;
  for (var i = 0; i < _items.length; i++) {
    var _item = _items[i].trim();
    // условие фильтра содержит оператор сравнения; иначе это слово итератора (i, sort, sub.size, i+1)
    if (/[<>=!]/.test(_item.replace(/'[^']*'/g, '')) === true) {
      _filters.push(_item);
    }
    else if (_item !== '') {
      if (/(\+1|\+\+)$/.test(_item) === true) {
        _plusOne = true;
      }
      _iter.push(_item);
    }
  }
  return { start : start, end : end, iter : _iter, filters : _filters, plusOne : _plusOne };
}

function templateError (message, source) {
  return new Error(message + ' Source: "' + source + '"');
}

/**
 * Синтетический XML прохода: метка и закрывающие «[…+1]» для каждого цикла пути (изнутри наружу)
 * @param  {String} path    путь без _root., все скобки — циклы
 * @param  {String} chain   форматтеры через «:» (с ведущим «:») или ''
 */
function syntheticXml (path, chain) {
  var _esc = function (str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var _p = function (marker) {
    return '<w:p><w:r><w:t>{' + _esc(marker) + '}</w:t></w:r></w:p>';
  };
  // цикл без «i» ([brand]) сворачивает строки с одинаковым ключом; в проходе нужен каждый элемент — добавляем «i»
  var _path = '';
  var _from = 0;
  parseBrackets(path).forEach(function (bracket) {
    var _inside = path.slice(bracket.start + 1, bracket.end);
    if (bracket.iter.indexOf('i') === -1) {
      _inside = bracket.iter.concat(['i'], bracket.filters).join(',');
    }
    _path += path.slice(_from, bracket.start) + '[' + _inside + ']';
    _from = bracket.end + 1;
  });
  path = _path + path.slice(_from);
  var _xml = _p(path + chain);
  var _brackets = parseBrackets(path);
  for (var k = _brackets.length - 1; k >= 0; k--) {
    var _words = _brackets[k].iter.map(function (word) {
      return word + '+1';
    });
    _xml += _p(path.slice(0, _brackets[k].start) + '[' + _words.join(',') + ']');
  }
  return _xml;
}

/**
 * Разобрать метку. null — в метке нет агрегатора.
 * @param  {String} name  имя метки после parser.preprocessMarkers ('_root.d.cars[sort>1].qty:mul(.sort):aggSum')
 * @param  {Number} id    номер задания
 */
function prepare (name, id) {
  var _chain = set.splitChain(name);
  var _first = -1;
  for (var i = 1; i < _chain.length; i++) {
    if (isAggregator(parseFormatter(_chain[i]).name) === true) {
      _first = i;
      break;
    }
  }
  if (_first === -1) {
    return null;
  }
  var _source = '{' + name.replace(/^_root\./, '') + '}';
  var _path = _chain[0].replace(/^_root\./, '');
  var _brackets = parseBrackets(_path);
  // метка строки-разделителя [i+1] не выводится — агрегатор в ней не нужен
  if (_brackets.some(function (b) { return b.plusOne === true; }) === true) {
    return { id : id, separator : true, outName : _chain[0], source : _source };
  }
  var _last = _first;
  while (_last + 1 < _chain.length && isAggregator(parseFormatter(_chain[_last + 1]).name) === true) {
    _last++;
  }
  for (var r = _last + 1; r < _chain.length; r++) {
    if (isAggregator(parseFormatter(_chain[r]).name) === true) {
      throw templateError('Агрегаторы в цепочке форматтеров должны идти подряд.', _source);
    }
  }
  var _pre = _chain.slice(1, _first);
  var _post = _chain.slice(_last + 1);
  var _aggs = _chain.slice(_first, _last + 1).map(function (str) {
    var _f = parseFormatter(str);
    var _isStr = (_f.name === 'aggStr' || _f.name === 'aggStrD');
    var _sep = ', ';
    var _partition = _isStr ? _f.args[1] : _f.args[0];
    if (_isStr && _f.args[0] !== undefined && _f.args[0] !== '') {
      _sep = unquote(_f.args[0]);
    }
    if (_partition !== undefined && _partition !== '') {
      if (/^\.+[^.]/.test(_partition) === false) {
        throw templateError('Аргумент группировки ' + _f.name + ' — путь с точкой, например ' + _f.name + (_isStr ? '(\', \', .brand)' : '(.brand)') + '.', _source);
      }
    }
    else {
      _partition = undefined;
    }
    return { name : _f.name, sep : _sep, partition : _partition, cumulative : CUM.indexOf(_f.name) !== -1 };
  });
  // значение во вложенном объекте после «[]» (d[].sub.qty) — как в документации, не поддерживается;
  // в цикле «[i]» путь обычный (d[i].sub.qty), его разбирает сборка
  if (_brackets.length > 0 && _brackets[_brackets.length - 1].iter.length === 0) {
    var _tail = _path.slice(_brackets[_brackets.length - 1].end + 1);
    if (/^\.[^.]+\./.test(_tail) === true) {
      var _prefix = _path.slice(0, _brackets[_brackets.length - 1].end + 1);
      throw templateError('Агрегатор ' + _aggs[0].name + ' не читает значение во вложенном объекте (' + _tail.slice(1) + '): используйте {'
        + _prefix + ':print(.' + _tail.slice(1) + '):' + _aggs[0].name + '}.', _source);
    }
  }
  // «[]» и «[фильтр]» — весь набор (группа); «[i]», «[i, фильтр]», «[sort, i]» — строки цикла
  var _firstAll = -1;
  for (var b = 0; b < _brackets.length; b++) {
    if (_brackets[b].iter.length === 0) {
      if (_firstAll === -1) {
        _firstAll = b;
      }
    }
    else if (_firstAll !== -1) {
      throw templateError('После «[]» в пути агрегатора не может идти цикл «[i]».', _source);
    }
  }
  var _job = {
    id         : id,
    source     : _source,
    pre        : _pre,
    aggs       : _aggs,
    grouped    : _firstAll !== -1,
    // число циклов «[i]» строки вывода
    outerLoops : _firstAll === -1 ? _brackets.length : _firstAll
  };
  if (_job.grouped === true) {
    if (_aggs[0].cumulative === true) {
      throw templateError(_aggs[0].name + ' считает по строкам цикла: используйте [i], например {'
        + _path.slice(0, _brackets[_firstAll].start) + '[i]' + _path.slice(_brackets[_firstAll].end + 1) + ':' + _aggs[0].name + '}.', _source);
    }
    if (_aggs[0].partition !== undefined) {
      throw templateError('Группировка ' + _aggs[0].name + '(' + _aggs[0].partition + ') работает только внутри цикла [i], например {'
        + _path.slice(0, _brackets[_firstAll].start) + '[i]' + _path.slice(_brackets[_firstAll].end + 1) + ':' + _aggs[0].name + '(' + _aggs[0].partition + ')}.', _source);
    }
    // путь элементов: «[]» → «[i]», «[sort>1]» → «[i,sort>1]»
    var _itemPath = '';
    var _from = 0;
    for (var g = _firstAll; g < _brackets.length; g++) {
      _itemPath += _path.slice(_from, _brackets[g].start) + '[' + ['i'].concat(_brackets[g].filters).join(',') + ']';
      _from = _brackets[g].end + 1;
    }
    _job.itemPath = _itemPath + _path.slice(_from);
    _job.rowPath = _path.slice(0, _brackets[_firstAll].start);
    _job.outName = '_root.' + _job.rowPath;
  }
  else {
    _job.itemPath = _path;
    _job.rowPath = _path;
    _job.outName = _chain[0];
  }
  _job.outName += ':__aggOut(' + id + ')' + _post.map(function (f) { return ':' + f; }).join('');
  return _job;
}

/**
 * Ключ строки — индексы циклов (context.parentsIndex без уровней-объектов), последние count — внешние циклы
 */
function loopKey (parentsIndex, count) {
  var _defined = (parentsIndex || []).filter(function (index) {
    return index !== undefined && index !== null;
  });
  return _defined.slice(_defined.length - count).join(',');
}

function isNumeric (value) {
  if (value === null || value === undefined || value === '' || value instanceof Object) {
    return false;
  }
  return Number.isFinite(Number(value));
}

/**
 * Значение для aggStr/aggStrD/aggCountD/cumCountD: не null, не undefined, не '' и не объект/массив
 */
function isPlainValue (value) {
  return value !== null && value !== undefined && value !== '' && !(value instanceof Object);
}

/**
 * Итог набора значений (агрегаторы agg*)
 */
function aggregate (agg, values) {
  var _nums = [];
  var _distinct = [];
  var _strs = [];
  for (var i = 0; i < values.length; i++) {
    var _v = values[i];
    if (isNumeric(_v) === true) {
      _nums.push(Number(_v));
    }
    if (isPlainValue(_v) === true && _distinct.indexOf(_v) === -1) {
      _distinct.push(_v);
    }
    if (isPlainValue(_v) === true) {
      _strs.push(_v);
    }
  }
  var _sum = 0;
  for (var n = 0; n < _nums.length; n++) {
    _sum += _nums[n];
  }
  switch (agg.name) {
    case 'aggSum':
      return _sum;
    case 'aggAvg':
      return _nums.length > 0 ? _sum / _nums.length : '';
    case 'aggMin':
      return _nums.length > 0 ? Math.min.apply(null, _nums) : '';
    case 'aggMax':
      return _nums.length > 0 ? Math.max.apply(null, _nums) : '';
    case 'aggCount':
      return values.length;
    case 'aggCountD':
      return _distinct.length;
    case 'aggStr':
      return _strs.map(String).join(agg.sep);
    case 'aggStrD':
      // порядок — по последнему вхождению значения, как в примере документации
      // (Lexus, Faraday, Venturi, Faraday, Aptera, Venturi → Lexus, Faraday, Aptera, Venturi)
      return _strs.filter(function (v, index) {
        return _strs.lastIndexOf(v) === index;
      }).map(String).join(agg.sep);
    default:
      return '';
  }
}

/**
 * Один шаг цепочки агрегаторов над строками вывода (в порядке вывода)
 * @param  {Object} agg
 * @param  {Array}  rows  [{ values: [значения набора строки] | value, parts: [ключи partition-by по шагам] }]
 * @param  {Number} step  номер агрегатора в цепочке
 */
function applyStep (agg, rows, step, valuesOf) {
  var _groups = new Map();
  var _groupOf = function (row) {
    var _key = row.parts[step];
    if (_groups.has(_key) === false) {
      _groups.set(_key, { values : [], sum : 0, count : 0, distinct : [] });
    }
    return _groups.get(_key);
  };
  var _results = [];
  if (agg.cumulative === false) {
    for (var i = 0; i < rows.length; i++) {
      var _g = _groupOf(rows[i]);
      _g.values = _g.values.concat(valuesOf(rows[i]));
    }
    for (var j = 0; j < rows.length; j++) {
      var _group = _groupOf(rows[j]);
      if (_group.result === undefined) {
        _group.result = aggregate(agg, _group.values);
      }
      _results.push(_group.result);
    }
    return _results;
  }
  for (var r = 0; r < rows.length; r++) {
    var _state = _groupOf(rows[r]);
    var _vals = valuesOf(rows[r]);
    for (var v = 0; v < _vals.length; v++) {
      var _value = _vals[v];
      _state.count++;
      if (isNumeric(_value) === true) {
        _state.sum += Number(_value);
      }
      if (isPlainValue(_value) === true && _state.distinct.indexOf(_value) === -1) {
        _state.distinct.push(_value);
      }
    }
    if (agg.name === 'cumSum') {
      _results.push(_state.sum);
    }
    else if (agg.name === 'cumCount') {
      _results.push(_state.count);
    }
    else {
      _results.push(_state.distinct.length);
    }
  }
  return _results;
}

/**
 * Реестр форматтеров с внутренним форматтером: копия (перечисляемые — и унаследованные, как у реестра прохода :set),
 * внутренний — неперечисляемый, чтобы не попасть в подсказку «Do you mean …» для неизвестного форматтера
 */
function withFormatter (base, name, fn) {
  var _res = {};
  var _base = base || {};
  for (var _key in _base) {
    _res[_key] = _base[_key];
  }
  Object.getOwnPropertyNames(_base).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(_res, key) === false) {
      Object.defineProperty(_res, key, { enumerable : false, value : _base[key] });
    }
  });
  Object.defineProperty(_res, name, { enumerable : false, value : fn });
  return _res;
}

/**
 * Синтетическая сборка: собирает записи формата __agg и возвращает их в порядке вывода
 * (записи, чьи строки не вывелись — фильтр цикла, — отбрасываются)
 */
function collect (path, chain, partitions, data, options, buildXML, callback) {
  var _records = [];
  var _formatters = withFormatter(options.formatters, '__aggCollect', function (value) {
    var _parts = Array.prototype.slice.call(arguments, 1);
    _records.push({ value : value, parts : _parts, parentsIndex : (this.parentsIndex || []).slice() });
    return TOKEN_OPEN + (_records.length - 1) + TOKEN_CLOSE;
  });
  var _args = partitions.length > 0 ? '(' + partitions.join(',') + ')' : '';
  var _chain = chain.map(function (f) {
    return ':' + f;
  }).join('') + ':__aggCollect' + _args;
  var _options = Object.assign({}, options, { formatters : _formatters, isDebugActive : false });
  buildXML(syntheticXml(path, _chain), data, _options, function (err, xml) {
    if (err) {
      return callback(err);
    }
    var _ordered = [];
    var _seen = {};
    var _match;
    TOKEN_REGEX.lastIndex = 0;
    while ((_match = TOKEN_REGEX.exec(xml)) !== null) {
      if (_seen[_match[1]] !== true) {
        _seen[_match[1]] = true;
        _ordered.push(_records[Number(_match[1])]);
      }
    }
    callback(null, _ordered);
  });
}

/**
 * Посчитать задание: Map(ключ строки → значение)
 */
function compute (job, data, options, buildXML, callback) {
  var _aggs = job.aggs;
  // ключи partition-by: в проходе элементов — у первого агрегатора (и у всех, если строка = элемент)
  var _partArgs = function (from) {
    var _args = [];
    var _map = [];
    for (var a = from; a < _aggs.length; a++) {
      if (_aggs[a].partition !== undefined) {
        _map[a] = _args.length;
        _args.push(_aggs[a].partition);
      }
    }
    return { args : _args, map : _map };
  };
  var _partsOf = function (record, map) {
    var _parts = [];
    for (var a = 0; a < _aggs.length; a++) {
      _parts.push(map[a] !== undefined ? record.parts[map[a]] : undefined);
    }
    return _parts;
  };
  var _finish = function (rows, valuesOf) {
    var _values = rows;
    for (var s = 0; s < _aggs.length; s++) {
      var _res;
      if (s === 0 && job.grouped === true) {
        // «[]»: итог набора своей строки (элемента внешнего цикла или единственной строки вне цикла)
        _res = rows.map(function (row) {
          return aggregate(_aggs[0], row.values);
        });
      }
      else {
        _res = applyStep(_aggs[s], rows, s, s === 0 ? valuesOf : function (row) {
          return [row.result];
        });
      }
      for (var r = 0; r < rows.length; r++) {
        rows[r].result = _res[r];
      }
    }
    var _byKey = new Map();
    for (var k = 0; k < _values.length; k++) {
      _byKey.set(_values[k].key, _values[k].result);
    }
    callback(null, _byKey);
  };
  if (job.grouped === false) {
    var _all = _partArgs(0);
    return collect(job.itemPath, job.pre, _all.args, data, options, buildXML, function (err, records) {
      if (err) {
        return callback(err);
      }
      var _rows = records.map(function (rec) {
        return { key : loopKey(rec.parentsIndex, job.outerLoops), value : rec.value, parts : _partsOf(rec, _all.map) };
      });
      _finish(_rows, function (row) {
        return [row.value];
      });
    });
  }
  collect(job.itemPath, job.pre, [], data, options, buildXML, function (err, items) {
    if (err) {
      return callback(err);
    }
    var _rest = _partArgs(1);
    collect(job.rowPath, [], _rest.args, data, options, buildXML, function (err2, records) {
      if (err2) {
        return callback(err2);
      }
      var _byOuter = new Map();
      for (var i = 0; i < items.length; i++) {
        var _outer = loopKey(items[i].parentsIndex, job.outerLoops);
        if (_byOuter.has(_outer) === false) {
          _byOuter.set(_outer, []);
        }
        _byOuter.get(_outer).push(items[i].value);
      }
      var _rows = records.map(function (rec) {
        var _key = loopKey(rec.parentsIndex, job.outerLoops);
        return { key : _key, values : _byOuter.get(_key) || [], parts : _partsOf(rec, _rest.map) };
      });
      _finish(_rows, function (row) {
        return row.values;
      });
    });
  });
}

var aggregateModule = {

  isAggregator : isAggregator,

  /**
   * Посчитать метки с агрегаторами и переписать их
   * @param  {Array}    markers   [{pos, name}] после parser.preprocessMarkers и set.extract
   * @param  {Mixed}    data
   * @param  {Object}   options   опции рендера
   * @param  {Function} buildXML  builder.buildXML
   * @param  {Function} callback(err, markers, formatters) — formatters === null, если агрегаторов нет
   */
  run : function (markers, data, options, buildXML, callback) {
    var _jobs = [];
    var _markers = [];
    try {
      for (var i = 0; i < markers.length; i++) {
        var _job = prepare(markers[i].name, _jobs.length);
        if (_job === null) {
          _markers.push(markers[i]);
          continue;
        }
        _markers.push({ pos : markers[i].pos, name : _job.outName, source : markers[i].name });
        if (_job.separator !== true) {
          _jobs.push(_job);
        }
      }
    }
    catch (e) {
      return callback(e, null, null);
    }
    if (_markers.every(function (marker, index) { return marker === markers[index]; }) === true) {
      return callback(null, markers, null);
    }
    var _results = [];
    // одинаковые метки (тот же путь, форматтеры до агрегатора и цепочка) считаются один раз
    var _cache = new Map();
    var _signature = function (job) {
      return JSON.stringify([job.itemPath, job.rowPath, job.pre, job.aggs, job.grouped, job.outerLoops]);
    };
    var _next = function (index) {
      if (index >= _jobs.length) {
        var _formatters = withFormatter(options.formatters, '__aggOut', function (value, jobId) {
          var _job = _jobs[Number(jobId)];
          var _result = _results[Number(jobId)].get(loopKey(this.parentsIndex, _job.outerLoops));
          return _result === undefined ? '' : _result;
        });
        return callback(null, _markers, _formatters);
      }
      var _cached = _cache.get(_signature(_jobs[index]));
      if (_cached !== undefined) {
        _results.push(_cached);
        return _next(index + 1);
      }
      compute(_jobs[index], data, options, buildXML, function (err, byKey) {
        if (err) {
          // ошибка синтетической сборки — с подписью исходной метки, без служебных форматтеров
          err.message = String(err.message).replace(/ Source: "[\s\S]*"$/, '') + ' Source: "' + _jobs[index].source + '"';
          return callback(err, null, null);
        }
        _cache.set(_signature(_jobs[index]), byKey);
        _results.push(byKey);
        _next(index + 1);
      });
    };
    _next(0);
  }
};

module.exports = aggregateModule;
