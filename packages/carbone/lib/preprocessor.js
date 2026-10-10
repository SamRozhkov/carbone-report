var path  = require('path');
var helper = require('./helper');
var parser = require('./parser');


var preprocessor = {

  /**
   * Execute preprocessor on main, and embedded document
   * @param  {Object}   template
   * @param  {Function} callback
   */
  execute : function (template, options, callback) {
    if (!(callback instanceof Function)) {
      callback = options;
      options = {};
    }
    if (template === null || template.files === undefined) {
      return callback(null, template);
    }
    for (let i = 0, len = template.files.length; i < len; i++) {
      template.files[i].data = preprocessor.preParseXML(template.files[i].data, options);
    }
    for (var i = -1; i < template.embeddings.length; i++) {
      var _mainOrEmbeddedTemplate = template.filename;
      var _parentFilter = '';
      var _fileType = template.extension;
      if (i > -1) {
        // If the current template is an embedded file
        _mainOrEmbeddedTemplate = _parentFilter = template.embeddings[i];
        _fileType = path.extname(_mainOrEmbeddedTemplate).toLowerCase().slice(1);
      }
      switch (_fileType) {
        case 'xlsx':
          preprocessor.removeCalcChain(template, _parentFilter);
          preprocessor.convertSharedStringToInlineString(template, _parentFilter);
          break;
        case 'ods':
          preprocessor.convertNumberMarkersIntoNumericFormat(template);
          break;
        case 'odt':
          preprocessor.removeSoftPageBreak(template);
          break;
        default:
          break;
      }
    }
    return callback(null, template);
  },

  /**
   * Loop through XML files to clean tags inside markers and to translate
   *
   * @param {Object} template
   */
  preParseXML : function (xml, options) {
    // find translation markers {t()} and translate before other processing
    xml = parser.translate(xml, options);
    // Remove XML tags inside markers
    xml = parser.removeXMLInsideMarkers(xml);
    return xml;
  },
  /**
   * Remove soft page break in ODT document as we modify them
   *
   * Search title "text:use-soft-page-breaks" in
   * http://docs.oasis-open.org/office/v1.2/os/OpenDocument-v1.2-os-part1.html#__RefHeading__1415190_253892949
   *
   * TODO: Should we do it in Word?
   *
   * @param  {Object} template (modified)
   * @return {Object}          template
   */
  removeSoftPageBreak : function (template) {
    for (var i = 0; i < template.files.length; i++) {
      var _file = template.files[i];
      if (/content\.xml$/.test(_file.name) === true) {
        _file.data = _file.data
          .replace(/text:use-soft-page-breaks="true"/g, '')
          .replace(/<text:soft-page-break\/>/g, '')
          .replace(/<text:soft-page-break><\/text:soft-page-break>/g, '');
        return template;
      }
    }
    return template;
  },

  /**
   * [XLSX] Convert shared string to inline string in Excel format in order to be compatible with Carbone algorithm
   * @param  {Object} template     (modified)
   * @param  {String} parentFilter apply the transformation on a specific embedded file
   * @return {Object}              the modified template
   */
  convertSharedStringToInlineString : function (template, parentFilter) {
    var _sharedStrings = [];
    var _filesToConvert = [];
    var _sharedStringIndex = -1;
    // parse all files and find shared strings first
    for (var i = 0; i < template.files.length; i++) {
      var _file = template.files[i];
      if (_file.parent === parentFilter) {
        if (/sharedStrings\.xml$/.test(_file.name) === true) {
          _sharedStringIndex = i;
          _sharedStrings = preprocessor.readSharedString(_file.data);
        }
        else if (/\.xml$/.test(_file.name) === true) {
          if (_file.name.indexOf('sheet') !== -1) {
            _filesToConvert.push(_file);
          }
        }
      }
    }
    preprocessor.removeOneFile(template, _sharedStringIndex, parentFilter);
    // once shared string is found, convert files
    for (var f = 0; f < _filesToConvert.length; f++) {
      var _modifiedFile = _filesToConvert[f];
      _modifiedFile.data = preprocessor.removeRowCounterInWorksheet(
        preprocessor.convertToInlineString(_modifiedFile.data, _sharedStrings)
      );
      // после сборки номера строк и ячеек восстанавливает finishXlsx (renderBuffer); свойство неперечисляемое —
      // разобранный шаблон сериализуется как в апстриме
      Object.defineProperty(_modifiedFile, 'rowCounterRemoved', { value : true, enumerable : false, writable : true });
    }
    return template;
  },

  /**
   * Removes uselss calc chain file.
   *
   * https://docs.microsoft.com/en-us/office/open-xml/working-with-the-calculation-chain
   *
   * This file is a sort of "cache" for Excel. The Calculation Chain part specifies the order in
   * which cells in the workbook were last calculated.
   *
   * As Carbone will modify the Excel file, this file may become incorrect.
   * We can safely remove this file to force Excel to recompute this file on opening.
   *
   * It removes the "alert" when opening the generated report with Excel
   *
   * @param      {<type>}  template      The template
   * @param      {<type>}  parentFilter  The parent filter
   * @return     {<type>}  { description_of_the_return_value }
   */
  removeCalcChain : function (template, parentFilter) {
    // parse all files and find shared strings first
    for (var i = 0; i < template.files.length; i++) {
      var _file = template.files[i];
      if (_file.parent === parentFilter && /xl\/calcChain\.xml$/.test(_file.name) === true) {
        preprocessor.removeOneFile(template, i, parentFilter);
        break;
      }
    }
    return template;
  },

  /**
   * [XLSX] Remove one file in the template and its relations
   * @param  {Object} template
   * @param  {Integer} indexOfFileToRemove index of the file to remove
   * @param  {String} parentFilter         filter to modify only an embedded document
   * @return {}                            it modifies the template directly
   */
  removeOneFile : function (template, indexOfFileToRemove, parentFilter) {
    if (indexOfFileToRemove < 0 || indexOfFileToRemove >= template.files.length) {
      return;
    }
    var _fileToRemove = template.files[indexOfFileToRemove];
    var _dirname  = path.dirname(_fileToRemove.name);
    var _basename = path.basename(_fileToRemove.name);
    template.files.splice(indexOfFileToRemove, 1);
    for (var i = 0; i < template.files.length; i++) {
      var _file = template.files[i];
      if (_file.parent === parentFilter) {
        // remove relations
        if (_dirname + '/_rels/workbook.xml.rels' === _file.name) {
          var _regExp = new RegExp('<Relationship [^>]*Target="' + helper.regexEscape(_basename) + '"[^>]*/>');
          _file.data = _file.data.replace(_regExp, '');
        }
      }
    }
  },

  /**
   * [XLSX] Parse and generate an array of shared string
   * @param  {String} sharedStringXml shared string content
   * @return {Array}                  array
   */
  readSharedString : function (sharedStringXml) {
    var _sharedStrings = [];
    if (sharedStringXml === null || sharedStringXml === undefined) {
      return _sharedStrings;
    }
    var _tagRegex = new RegExp('<si>(.+?)</si>','g');
    var _tag = _tagRegex.exec(sharedStringXml);
    while (_tag !== null) {
      _sharedStrings.push(_tag[1]);
      _tag = _tagRegex.exec(sharedStringXml);
    }
    return _sharedStrings;
  },

  /**
   * [XLSX] Inject shared string in sheets
   * @param  {String} xml           sheets where to insert shared strings
   * @param  {Array} sharedStrings  shared string
   * @return {String}               updated xml
   */
  convertToInlineString : function (xml, sharedStrings) {
    if (typeof(xml) !== 'string') {
      return xml;
    }
    // find all tags which have attribute t="s" (type = shared string)
    var _inlinedXml = xml.replace(/(<(\w)[^>]*t="s"[^>]*>)(.*?)(<\/\2>)/g, function (m, openTag, tagName, content, closeTag) {
      var _newXml = '';
      // get the index of shared string
      var _tab = /<v>(\d+?)<\/v>/.exec(content);
      if (_tab instanceof Array && _tab.length > 0) {
        // replace the index by the string
        var _sharedStringIndex = parseInt(_tab[1], 10);
        var _selectedSharedString = sharedStrings[_sharedStringIndex];
        const _contentAsNumber = /{[d|c][.].*:formatN\(.*\)}/.exec(_selectedSharedString);
        if (_contentAsNumber instanceof Array && _tab.length > 0) {
          // Convert the marker into number cell type when it using the ':formatN' formatter
          _selectedSharedString = _contentAsNumber[0].replace(/:formatN\(.*\)/, '');
          _newXml = openTag.replace('t="s"', 't="n"');
          _newXml += '<v>' + _selectedSharedString + '</v>';
        }
        else {
          // change type of tag to "inline string"
          _newXml = openTag.replace('t="s"', 't="inlineStr"');
          _newXml += '<is>' + _selectedSharedString + '</is>';
        }
        _newXml += closeTag;
        return _newXml;
      }
      // if something goes wrong, do nothing
      return m;
    });
    return _inlinedXml;
  },

  /**
   * [XLSX] Remove row and column counter (r=1, c=A1) in sheet (should be added in post-processing)
   * Carbone Engine cannot update these counter itself
   * @param  {String} xml sheet
   * @return {String}     sheet updated
   */
  removeRowCounterInWorksheet : function (xml) {
    if (typeof(xml) !== 'string') {
      return xml;
    }
    return xml.replace(/<(?:c|row)[^>]*\s(r="\S+")[^>]*>/g, function (m, rowValue) {
      return m.replace(rowValue, '');
    }).replace(/<(?:c|row)[^>]*(spans="\S+")[^>]*>/g, function (m, rowValue) {
      return m.replace(rowValue, '');
    });
  },

  /**
   * [XLSX] Вернуть номера строк и ячеек (r="3", r="B3") после сборки: removeRowCounterInWorksheet убирает их, чтобы
   * циклы могли размножать строки. Excel без r ставит строки и ячейки подряд, а OnlyOffice Document Server без r
   * оставляет только первую ячейку каждой строки — поэтому номера ставятся по тому же правилу «подряд»: строки 1…N,
   * ячейки A, B, C… по позиции в строке. Результат в Excel не меняется. Строки и ячейки, где r уже есть,
   * не трогаются.
   * @param  {String} xml sheet
   * @return {String}     sheet updated
   */
  addRowCounterInWorksheet : function (xml) {
    if (typeof(xml) !== 'string') {
      return xml;
    }
    var _start = xml.indexOf('<sheetData');
    var _end = xml.lastIndexOf('</sheetData>');
    if (_start === -1 || _end === -1) {
      return xml;
    }
    var _row = 0;
    var _col = 0;
    var _data = xml.slice(_start, _end).replace(/<(row|c)\b([^>]*?)(\/?)>/g, function (tag, name, attrs, selfClosing) {
      var _r = /\sr\s*=\s*"([^"]*)"/.exec(attrs);
      if (name === 'row') {
        _row = _r !== null && /^\d+$/.test(_r[1]) === true ? parseInt(_r[1], 10) : _row + 1;
        _col = 0;
        return _r !== null ? tag : '<row r="' + _row + '"' + attrs + selfClosing + '>';
      }
      _col++;
      if (_r !== null) {
        return tag;
      }
      return '<c r="' + preprocessor.columnName(_col) + _row + '"' + attrs + selfClosing + '>';
    });
    return xml.slice(0, _start) + _data + xml.slice(_end);
  },

  /**
   * [XLSX] Привести собранный XLSX к виду, который читает OnlyOffice: номера строк и ячеек, общие строки
   * @param  {Object} template  (modified)
   */
  finishXlsx : function (template) {
    if (template.extension !== 'xlsx') {
      return template;
    }
    for (var f = 0; f < template.files.length; f++) {
      if (template.files[f].rowCounterRemoved === true && (template.files[f].parent === '' || template.files[f].parent === undefined)) {
        template.files[f].data = preprocessor.addRowCounterInWorksheet(template.files[f].data);
      }
    }
    return preprocessor.convertInlineStringToSharedString(template);
  },

  /**
   * [XLSX] После сборки вернуть текст ячеек в общие строки (xl/sharedStrings.xml).
   * convertSharedStringToInlineString переводит их во «встроенные» (t="inlineStr"), чтобы метки собирались прямо
   * в листе. Excel такие файлы читает, а OnlyOffice Document Server 9.4 при конвертации (xlsx → pdf/ods)
   * берёт из листа только первую встроенную строку, остальные ячейки пропадают. Поэтому для XLSX-шаблона
   * (верхний уровень, не вложенный в DOCX файл) встроенные строки снова становятся общими.
   * @param  {Object} template  (modified)
   */
  convertInlineStringToSharedString : function (template) {
    var _sheets = template.files.filter(function (f) {
      return f.rowCounterRemoved === true && (f.parent === '' || f.parent === undefined) && typeof f.data === 'string';
    });
    if (_sheets.length === 0) {
      return template;
    }
    // каталог книги: рядом с xl/_rels/workbook.xml.rels; без него листы не трогаем (иначе ссылки t="s" повисли бы)
    var _relsIndex = template.files.findIndex(function (f) {
      return (f.parent === '' || f.parent === undefined) && /(^|\/)_rels\/workbook\.xml\.rels$/.test(f.name) === true;
    });
    var _types = template.files.find(function (f) {
      return (f.parent === '' || f.parent === undefined) && f.name === '[Content_Types].xml';
    });
    if (_relsIndex === -1 || _types === undefined || typeof template.files[_relsIndex].data !== 'string' || typeof _types.data !== 'string') {
      return template;
    }
    var _rels = template.files[_relsIndex];
    var _strings = [];
    var _index = new Map();
    var _count = 0;
    _sheets.forEach(function (sheet) {
      var _start = sheet.data.indexOf('<sheetData');
      var _end = sheet.data.lastIndexOf('</sheetData>');
      if (_start === -1 || _end === -1) {
        return;
      }
      // всё, что стоит в ячейке после </is> (например extLst), остаётся на месте
      var _data = sheet.data.slice(_start, _end).replace(/<c\b([^>]*?)\st="inlineStr"([^>]*)>\s*(?:<is\s*\/>|<is>((?:(?!<\/is>)[\s\S])*)<\/is>)((?:(?!<\/c>)[\s\S])*)<\/c>/g, function (m, before, after, content, rest) {
        var _content = content === undefined ? '<t></t>' : content;
        var _i = _index.get(_content);
        if (_i === undefined) {
          _i = _strings.length;
          _strings.push(_content);
          _index.set(_content, _i);
        }
        _count++;
        return '<c' + before + ' t="s"' + after + '><v>' + _i + '</v>' + rest.replace(/^\s+/, '') + '</c>';
      });
      sheet.data = sheet.data.slice(0, _start) + _data + sheet.data.slice(_end);
    });
    if (_strings.length === 0) {
      return template;
    }
    var _dir = _rels.name.replace(/(^|\/)_rels\/workbook\.xml\.rels$/, '');
    var _name = (_dir === '' ? '' : _dir + '/') + 'sharedStrings.xml';
    template.files = template.files.filter(function (f) {
      return !((f.parent === '' || f.parent === undefined) && f.name === _name);
    });
    // вставка рядом со связями книги, а не в конец: после файлов вложенных архивов (xl/embeddings/*.xlsx, *.ods)
    // файл верхнего уровня zipFiles принял бы за отдельный архив с пустым именем
    template.files.splice(template.files.indexOf(_rels) + 1, 0, {
      name     : _name,
      parent   : '',
      isMarked : false,
      data     : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + _count + '" uniqueCount="' + _strings.length + '">'
        + _strings.map(function (str) {
          return '<si>' + str + '</si>';
        }).join('') + '</sst>'
    });
    if (/relationships\/sharedStrings"/.test(_rels.data) === false) {
      _rels.data = _rels.data.replace(/<\/Relationships>\s*$/, '<Relationship Id="rIdCarboneSharedStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
    }
    if (_types.data.indexOf('PartName="/' + _name + '"') === -1) {
      _types.data = _types.data.replace(/<\/Types>\s*$/, '<Override PartName="/' + _name + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
    }
    return template;
  },

  /**
   * Имя столбца Excel по номеру с 1: 1 → A, 27 → AA
   */
  columnName : function (index) {
    var _name = '';
    for (var n = index; n > 0; n = Math.floor((n - 1) / 26)) {
      _name = String.fromCharCode(65 + (n - 1) % 26) + _name;
    }
    return _name;
  },

  /**
   * @description [ODS] convert number markers with the `formatN()` formatter into numeric format
   *
   * @param {Object} template
   * @return
   */
  convertNumberMarkersIntoNumericFormat : function (template) {
    const _contentFileId = template.files.findIndex(x => x.name === 'content.xml');
    if (_contentFileId > -1 && !!template.files[_contentFileId] === true) {
      template.files[_contentFileId].data = template.files[_contentFileId].data.replace(/<table:table-cell[^<]*>\s*<text:p>[^<]*formatN[^<]*<\/text:p>\s*<\/table:table-cell>/g, function (xml) {
        const _markers = xml.match(/(\{[^{]+?\})/g);
        // we cannot convert to number of there are multiple markers in the same cell
        if (_markers.length !== 1) {
          return xml;
        }
        const _marker = _markers[0].replace(/:formatN\(.*\)/, '');
        xml = xml.replace(/:formatN\(.*\)/, '');
        xml = xml.replace(/office:value-type="string"/, `office:value-type="float" office:value="${_marker}"`);
        xml = xml.replace(/calcext:value-type="string"/, 'calcext:value-type="float"');
        return xml;
      });
    }
    return template;
  }
};

module.exports = preprocessor;