
/**
 * Flatten an array of String or Number
 *
 * @version 0.12.5
 *
 * @example [ ["homer", "bart", "lisa"]        ]
 * @example [ ["homer", "bart", "lisa"] , " | "]
 * @example [ ["homer", "bart", "lisa"] , ""   ]
 * @example [ [10, 50]                         ]
 * @example [ []                               ]
 * @example [ null                             ]
 * @example [ {}                               ]
 * @example [ 20                               ]
 * @example [                                  ]
 *
 * @param  {Array}  d           array passed by carbone
 * @param  {String} separator   [optional] item separator (`,` by default)
 * @param  {Integer} index      [optional] Carbone 5: с какого элемента начинать
 * @param  {Integer} count      [optional] Carbone 5: сколько элементов взять (отрицательное — до стольких-то с конца)
 * @return {String}             computed result, or `d` if `d` is not an array
 */
function arrayJoin (d, separator, index, count) {
  if (separator === undefined) {
    separator = ', ';
  }
  if (separator === '\\n') {
    separator = '\n';
  }
  if (separator === '\\r\\n') {
    separator = '\r\n';
  }

  if (d instanceof Array) {
    // Carbone 5: срез массива по index/count, как arrayJoin('', 1, 1) → второй элемент
    var _index = parseInt(index, 10);
    var _count = parseInt(count, 10);
    var _items = d;
    if (isNaN(_index) === false || isNaN(_count) === false) {
      var _start = isNaN(_index) === true ? 0 : _index;
      var _end;
      if (isNaN(_count) === false) {
        _end = _count < 0 ? _count : _start + _count;
        if (_start < 0 && _end >= 0) {
          _end = d.length + _start + _count;
        }
      }
      _items = d.slice(_start, _end);
    }
    return _items.join(separator);
  }
  return d;
}

/**
 *
 * @version 0.12.5
 *
 * Flatten an array of objects
 *
 * It ignores nested objects and arrays
 *
 * @example [ [{"id":2, "name":"homer"}, {"id":3, "name":"bart"} ]                    ]
 * @example [ [{"id":2, "name":"homer"}, {"id":3, "name":"bart"} ] , " - "            ]
 * @example [ [{"id":2, "name":"homer"}, {"id":3, "name":"bart"} ] , " ; ", "|"       ]
 * @example [ [{"id":2, "name":"homer"}, {"id":3, "name":"bart"} ] , " ; ", "|", "id" ]
 * @example [ [{"id":2, "name":"homer", "obj":{"id":20}, "arr":[12,23] }]             ]
 * @example [ ["homer", "bart", "lisa"]                                               ]
 * @example [ [10, 50]                                                                ]
 * @example [ []                                                                      ]
 * @example [ null                                                                    ]
 * @example [ {}                                                                      ]
 * @example [ 20                                                                      ]
 * @example [                                                                         ]
 *
 * @param  {Array} d                     array passed by carbone
 * @param  {String} objSeparator         [optional] object separator (`, ` by default)
 * @param  {String} attributeSeparator   [optional] attribute separator (`:` by default)
 * @param  {String} attributes           [optional] list of object's attributes to print
 * @return {String}                      the computed result, or `d` if `d` is not an array
 */
function arrayMap (d, objSeparator, attributeSeparator) {
  if (objSeparator === undefined) {
    objSeparator = ', ' ;
  }
  if (attributeSeparator === undefined) {
    attributeSeparator = ':' ;
  }
  var _isAttributeFilterActive = arguments.length > 3;
  var _res = [];
  if (d instanceof Array) {
    for (var i = 0; i < d.length; i++) {
      var _obj = d[i];
      var _flatObj = [];
      // if user want to print only some attributes, avoid looping on whole object
      if (_isAttributeFilterActive === true) {
        for (var j = 3; j < arguments.length; j++) {
          var _att = arguments[j];
          _flatObj.push(_obj[_att]);
        }
      }
      else if (_obj instanceof Object === false) {
        _flatObj.push(_obj);
      }
      // else, loop on all attributes and print each one if it is not an object
      else {
        for (var _attr in _obj) {
          var _val = _obj[_attr];
          if (!(_val instanceof Object)) {
            _flatObj.push(_val);
          }
        }
      }
      _res.push(_flatObj.join(attributeSeparator));
    }
    return _res.join(objSeparator);
  }
  return d;
}

module.exports = {
  arrayJoin : arrayJoin,
  arrayMap  : arrayMap
  // count убран: как в Carbone EE 5, он отключён в бесплатном режиме (lib/community.js)
};
