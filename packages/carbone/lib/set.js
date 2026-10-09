// Форматтер :set как в Carbone EE 5 (эталоны help/totals-set-*, matrix/*set*): записывает значение в complement (c.…).
// Реализация своя (чистая комната): метки с :set отделяются от документа и выполняются предварительным проходом
// до сборки файла — каждая прогоняется обычным builder.buildXML по синтетическому XML, так что циклы, фильтры и
// аргументы «.поле» / «c.путь» работают как в любой метке. Сами метки :set ничего не печатают.

var helper = require('./helper');

/**
 * Разбить имя метки на путь и цепочку форматтеров по «:» вне скобок и кавычек
 * @param  {String} name  '_root.d.cars[].qty:add(c.total):set(c.total)'
 * @return {Array}        ['_root.d.cars[].qty', 'add(c.total)', 'set(c.total)']
 */
function splitChain (name) {
  var _parts = [];
  var _current = '';
  var _depth = 0;
  var _quote = false;
  for (var i = 0; i < name.length; i++) {
    var _char = name[i];
    if (_char === '\'') {
      _quote = !_quote;
    }
    else if (_quote === false && (_char === '(' || _char === '[')) {
      _depth++;
    }
    else if (_quote === false && (_char === ')' || _char === ']')) {
      _depth--;
    }
    else if (_quote === false && _depth === 0 && _char === ':') {
      _parts.push(_current);
      _current = '';
      continue;
    }
    _current += _char;
  }
  _parts.push(_current);
  return _parts;
}

/**
 * Скобки пути метки: путь до скобки, слова итераторов и слова «+1» (i+1, sort+1)
 * @param  {String} path  '_root.d.a[i].b[i+1].x'
 * @return {Array}        [{prefix:'_root.d.a', words:['i'], plusOne:[]}, {prefix:'_root.d.a[i].b', words:[], plusOne:['i']}]
 */
function loopBrackets (path) {
  var _res = [];
  var _regex = /\[([^\]]*)\]/g;
  var _match;
  while ((_match = _regex.exec(path)) !== null) {
    var _words = [];
    var _plusOne = [];
    _match[1].split(',').forEach(function (item) {
      var _item = item.trim();
      var _plus = /^([\s\S]+?)\s*(\+1|\+\+)$/.exec(_item);
      if (_plus !== null) {
        _plusOne.push(_plus[1]);
      }
      else if (_item !== '') {
        _words.push(_item);
      }
    });
    _res.push({ prefix : path.slice(0, _match.index), words : _words, plusOne : _plusOne });
  }
  return _res;
}

/**
 * Разобрать цель «c.<seg>(.<seg>)*», seg = name | name[] | name[key=.field]
 * @param  {String} target  'c.g[id=.brand].rows[]'
 * @return {Array}          [{name:'g', key:'id', dots:1, field:'brand'}, {name:'rows', push:true}]
 */
function parseTarget (target) {
  var _str = target.trim();
  if (/^c\./.test(_str) === false) {
    throw new Error('The target of :set must start with "c.", got "' + _str + '"');
  }
  var _segments = [];
  var _regex = /\.([^.[\]]+)(\[([^\]]*)\])?/g;
  var _rest = _str.slice(1);
  var _match;
  var _consumed = 0;
  while ((_match = _regex.exec(_rest)) !== null) {
    if (_match.index !== _consumed) {
      break;
    }
    _consumed = _regex.lastIndex;
    var _segment = { name : _match[1] };
    if (_match[2] !== undefined) {
      var _inside = _match[3].trim();
      var _keyMatch = /^([^=\s]+)\s*=\s*(\.+)([^.\s][\s\S]*)$/.exec(_inside);
      if (_inside === '') {
        _segment.push = true;
      }
      else if (_keyMatch !== null) {
        _segment.key = _keyMatch[1];
        _segment.dots = _keyMatch[2].length;
        _segment.field = _keyMatch[3];
      }
      else {
        _consumed = -1;
        break;
      }
    }
    _segments.push(_segment);
  }
  if (_consumed !== _rest.length || _segments.length === 0) {
    throw new Error('Unsupported target of :set "' + _str + '". Use c.name, c.name[] or c.name[key=.field] segments');
  }
  return _segments;
}

/**
 * Подпись метки в сообщении об ошибке так, как её показывает EE (эталон matrix/tests2/group-via-set-subtotal-set):
 * «{d.cars[i].qty:add(c.g[id=.brand].sum):_setInit(c.g):_setObj(c):_setArr(g):_setObjInArr(id,.brand):_setVal(sum)}».
 * Записанной формой подтверждены сегменты name[key=.field] и последний name; остальные — по аналогии.
 */
function eeSource (iterSource, chain, segments) {
  var _set = ['_setInit(c.' + segments[0].name + ')', '_setObj(c)'];
  for (var i = 0; i < segments.length; i++) {
    var _seg = segments[i];
    var _isLast = (i === segments.length - 1);
    if (_seg.push === true) {
      _set.push('_setArr(' + _seg.name + ')');
    }
    else if (_seg.key !== undefined) {
      _set.push('_setArr(' + _seg.name + ')', '_setObjInArr(' + _seg.key + ',' + '.'.repeat(_seg.dots) + _seg.field + ')');
    }
    else {
      _set.push((_isLast ? '_setVal(' : '_setObj(') + _seg.name + ')');
    }
  }
  return '{' + [iterSource].concat(chain, _set).join(':') + '}';
}

/**
 * Копия контейнера со всеми свойствами (включая неизменяемое c.now)
 */
function copyContainer (obj) {
  if (obj instanceof Array) {
    return obj.slice();
  }
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(obj));
}

/**
 * Индекс ключей массива группировки: Map(String(значение ключа) → индекс элемента), строится один раз на массив
 * (WeakMap по самому массиву, на весь рендер) вместо линейного поиска на каждый элемент источника.
 */
function buildKeyIndex (state, array, key) {
  var _byKey = state.keyIndex.get(array);
  if (_byKey === undefined) {
    _byKey = new Map();
    state.keyIndex.set(array, _byKey);
  }
  var _index = new Map();
  for (var j = 0; j < array.length; j++) {
    if (array[j] instanceof Object && array[j][key] !== undefined && _index.has(String(array[j][key])) === false) {
      _index.set(String(array[j][key]), j);
    }
  }
  _byKey.set(key, _index);
  return _index;
}

function findKeyIndex (state, array, key, keyValue) {
  var _byKey = state.keyIndex.get(array);
  var _index = (_byKey !== undefined) ? _byKey.get(key) : undefined;
  if (_index === undefined) {
    _index = buildKeyIndex(state, array, key);
  }
  var _wanted = String(keyValue);
  var _found = _index.get(_wanted);
  if (_found !== undefined && !(array[_found] instanceof Object && String(array[_found][key]) === _wanted)) {
    // элемент заменили целиком (последний сегмент name[key=.f]) — перестраиваем индекс
    _found = buildKeyIndex(state, array, key).get(_wanted);
  }
  return _found === undefined ? -1 : _found;
}

function registerKey (state, array, key, keyValue, position) {
  var _byKey = state.keyIndex.get(array);
  var _index = (_byKey !== undefined) ? _byKey.get(key) : undefined;
  if (_index !== undefined && _index.has(String(keyValue)) === false) {
    _index.set(String(keyValue), position);
  }
}

/**
 * Записать значение по цели. Контейнеры, которые set ещё не создавал, копируются перед изменением:
 * complement и данные вызывающего не меняются.
 * @param  {Object} state     { root: complement, owned: WeakSet }
 * @param  {Array}  segments  parseTarget()
 * @param  {Mixed}  value
 * @param  {Array}  parents   context.parentsData (для ключей «.поле»)
 */
function assign (state, segments, value, parents) {
  var _owned = state.owned;
  var _own = function (parent, prop, emptyValue) {
    var _value = parent[prop];
    if (!(_value instanceof Object)) {
      _value = emptyValue();
    }
    else if (_owned.has(_value) === false) {
      _value = copyContainer(_value);
    }
    else {
      return _value;
    }
    _owned.add(_value);
    parent[prop] = _value;
    return _value;
  };
  var _current = state.root;
  for (var i = 0; i < segments.length; i++) {
    var _seg = segments[i];
    var _isLast = (i === segments.length - 1);
    if (_seg.push !== true && _seg.key === undefined) {
      if (_isLast === true) {
        _current[_seg.name] = value;
        return;
      }
      _current = _own(_current, _seg.name, function () { return {}; });
      continue;
    }
    var _array = _current[_seg.name];
    if (!(_array instanceof Array)) {
      _array = [];
      _owned.add(_array);
      _current[_seg.name] = _array;
    }
    else {
      _array = _own(_current, _seg.name, function () { return []; });
    }
    if (_seg.push === true) {
      if (_isLast === true) {
        _array.push(value);
        return;
      }
      var _item = {};
      _owned.add(_item);
      _array.push(_item);
      _current = _item;
      continue;
    }
    // name[key=.field]: найти элемент с таким ключом или добавить новый { key: значение }
    // ключи сравниваются как строки — так же, как поиск по ключу в аргументах (helper.getValueOfArgumentPath):
    // 1 и '1' — одна группа
    var _source = parents instanceof Array ? parents[_seg.dots - 1] : undefined;
    var _keyValue = (_source instanceof Object) ? helper.getValueOfPath(_source, _seg.field) : undefined;
    var _index = findKeyIndex(state, _array, _seg.key, _keyValue);
    if (_isLast === true) {
      if (_index === -1) {
        _array.push(value);
        // ключ добавленного элемента — в индекс, чтобы повторный ключ нашёл и заменил его, а не добавил дубль
        if (value instanceof Object && value[_seg.key] !== undefined) {
          registerKey(state, _array, _seg.key, value[_seg.key], _array.length - 1);
        }
      }
      else {
        _array[_index] = value;
      }
      return;
    }
    if (_index === -1) {
      var _newItem = {};
      _newItem[_seg.key] = _keyValue;
      _owned.add(_newItem);
      _array.push(_newItem);
      registerKey(state, _array, _seg.key, _keyValue, _array.length - 1);
      _current = _newItem;
    }
    else {
      _current = _own(_array, _index, function () { return {}; });
    }
  }
}

var set = {

  /**
   * Отделить метки, в цепочке которых есть :set
   * @param  {Array} markers  [{pos, name}] после parser.preprocessMarkers
   * @return {Object}         { markers: остальные, setMarkers: [{pos, name}] }
   */
  extract : function (markers) {
    var _rest = [];
    var _set = [];
    for (var i = 0; i < markers.length; i++) {
      var _chain = splitChain(markers[i].name);
      var _isSet = false;
      for (var j = 1; j < _chain.length; j++) {
        if (/^\s*set\s*\(/.test(_chain[j]) === true) {
          _isSet = true;
        }
      }
      if (_isSet === false) {
        _rest.push(markers[i]);
      }
      // метка :set на строке-разделителе [i+1] ничего не делает (строка [i+1] не выводится)
      else if (loopBrackets(_chain[0]).some(function (b) { return b.plusOne.length > 0; }) === false) {
        _set.push(markers[i]);
      }
    }
    // [i+1] без обычной метки [i] того же массива, когда [i] была только у меток :set
    // («| {d.cars[i].brand:set(c.b[])} |» + «| {d.cars[i+1].brand} |»): разделитель больше ничего не повторяет — убираем
    var _setBrackets = [];
    var _baseBrackets = [];
    for (var s = 0; s < markers.length; s++) {
      var _brackets = loopBrackets(splitChain(markers[s].name)[0]);
      var _isSetMarker = _rest.indexOf(markers[s]) === -1;
      for (var b = 0; b < _brackets.length; b++) {
        if (_brackets[b].plusOne.length === 0) {
          (_isSetMarker === true ? _setBrackets : _baseBrackets).push(_brackets[b]);
        }
      }
    }
    var _hasBracket = function (list, bracket) {
      return list.some(function (other) {
        return other.prefix === bracket.prefix && bracket.plusOne.some(function (word) { return other.words.indexOf(word) !== -1; });
      });
    };
    _rest = _rest.filter(function (marker) {
      var _orphan = loopBrackets(splitChain(marker.name)[0]).some(function (bracket) {
        return bracket.plusOne.length > 0 && _hasBracket(_setBrackets, bracket) === true && _hasBracket(_baseBrackets, bracket) === false;
      });
      return _orphan === false;
    });
    return { markers : _rest, setMarkers : _set };
  },

  /**
   * Выполнить метки :set по порядку документа, записывая значения в options.complement
   * @param  {Array}    setMarkers
   * @param  {Mixed}    data
   * @param  {Object}   options     опции рендера (complement заменяется рабочей копией)
   * @param  {Function} buildXML    builder.buildXML
   * @param  {Function} callback(err)
   */
  run : function (setMarkers, data, options, buildXML, callback) {
    if (setMarkers.length === 0) {
      return callback(null);
    }
    // рабочая копия complement на весь рендер: значения :set видны всем следующим файлам, вызывающий не затронут
    var _state = options._setState;
    if (_state === undefined || _state.root !== options.complement) {
      var _root = (options.complement instanceof Object) ? copyContainer(options.complement) : {};
      _state = { root : _root, owned : new WeakSet([_root]), keyIndex : new WeakMap() };
      Object.defineProperty(options, '_setState', { value : _state, writable : true, configurable : true, enumerable : false });
      options.complement = _root;
    }
    var _jobs = [];
    var _sorted = setMarkers.slice().sort(function (a, b) { return a.pos - b.pos; });
    try {
      for (var i = 0; i < _sorted.length; i++) {
        _jobs.push(set.prepare(_sorted[i].name));
      }
    }
    catch (e) {
      return callback(e);
    }
    var _next = function (index) {
      if (index >= _jobs.length) {
        return callback(null);
      }
      set.execute(_jobs[index], data, options, _state, buildXML, function (err) {
        if (err) {
          return callback(err);
        }
        _next(index + 1);
      });
    };
    _next(0);
  },

  /**
   * Разобрать метку :set в задание
   * @param  {String} name '_root.d.cars[].qty:add(c.total):set(c.total)'
   * @return {Object}      { source, iterSource, chain, segments, original }
   */
  prepare : function (name) {
    var _parts = splitChain(name);
    var _source = _parts[0].replace(/^_root\./, '');
    var _chain = [];
    var _target = null;
    for (var i = 1; i < _parts.length; i++) {
      var _setMatch = /^\s*set\s*\(([\s\S]*)\)\s*$/.exec(_parts[i]);
      if (_setMatch !== null) {
        if (i !== _parts.length - 1) {
          throw new Error(':set must be the last formatter in {' + name.replace(/^_root\./, '') + '}');
        }
        _target = _setMatch[1];
      }
      else {
        _chain.push(_parts[i]);
      }
    }
    var _segments = parseTarget(_target);
    // «d.a[]» (и вложенные «d.a[].b[]») — для каждого элемента; иначе одно значение.
    // Явный «[i]» / «[i, фильтр]» в источнике тоже перебирается (поведение EE не записано).
    var _iterSource = _source.replace(/\[\s*\]/g, '[i]');
    var _iterates = /\[i(?=[,\]])/.test(_iterSource);
    return {
      original   : '{' + name.replace(/^_root\./, '') + '}',
      target     : _target.trim(),
      source     : _source,
      iterSource : _iterSource,
      iterates   : _iterates,
      chain      : _chain,
      segments   : _segments,
      // особенность EE: цель без «[…]» при перебираемом источнике сначала получает цепочку первого элемента,
      // затем — всех (накопитель add(c.total) даёт 14 вместо 11, эталон help/totals-set-sum)
      firstTwice : _iterates === true && _target.indexOf('[') === -1
    };
  },

  /**
   * Синтетический XML: метка с внутренним форматтером __set и закрывающие метки [i+1] для каждого уровня цикла
   */
  syntheticXml : function (job) {
    var _p = function (marker) {
      return '<w:p><w:r><w:t>{' + marker + '}</w:t></w:r></w:p>';
    };
    var _xml = _p([job.iterSource].concat(job.chain, ['__set']).join(':'));
    // позиции «[i]» в пути: закрываем циклы изнутри наружу
    var _positions = [];
    var _regex = /\[i(?=[,\]])/g;
    var _match;
    while ((_match = _regex.exec(job.iterSource)) !== null) {
      _positions.push(_match.index);
    }
    for (var k = _positions.length - 1; k >= 0; k--) {
      _xml += _p(job.iterSource.slice(0, _positions[k]) + '[i+1]');
    }
    return _xml;
  },

  execute : function (job, data, options, state, buildXML, callback) {
    var _passes = [];
    if (job.firstTwice === true) {
      _passes.push(true);
    }
    _passes.push(false);
    var _xml = job.iterates === true ? set.syntheticXml(job) : '<w:p><w:r><w:t>{' + [job.source].concat(job.chain, ['__set']).join(':') + '}</w:t></w:r></w:p>';
    var _runPass = function (index) {
      if (index >= _passes.length) {
        return callback(null);
      }
      var _onlyFirst = _passes[index];
      var _done = false;
      // внутренний форматтер прохода: не попадает в общий реестр, виден только синтетической сборке
      var _formatters = Object.create(options.formatters || {});
      // неперечисляемый: не попадает в подсказку «Do you mean …» для неизвестного форматтера
      Object.defineProperty(_formatters, '__set', { enumerable : false, value : function (value) {
        if (this.isRowFiltered === true || (_onlyFirst === true && _done === true)) {
          return '';
        }
        _done = true;
        assign(state, job.segments, value, this.parentsData);
        return '';
      } });
      var _options = Object.assign({}, options, { formatters : _formatters, isDebugActive : false });
      buildXML(_xml, data, _options, function (err) {
        if (err) {
          return callback(set.sourceError(err, job));
        }
        _runPass(index + 1);
      });
    };
    _runPass(0);
  },

  /**
   * Ошибка синтетической сборки с подписью исходной метки (в синтетической — служебный __set)
   */
  sourceError : function (err, job) {
    // служебный __set синтетической метки в сообщении не показываем — только исходную форму :set(…)
    var _message = String(err.message).replace(/ Source: "[\s\S]*"$/, '').replace(/:__set\b/g, ':set(' + job.target + ')');
    var _source = (err.forbiddenPath !== undefined) ? eeSource(job.iterSource, job.chain, job.segments) : job.original;
    err.message = _message + ' Source: "' + _source + '"';
    return err;
  }
};

module.exports = set;
