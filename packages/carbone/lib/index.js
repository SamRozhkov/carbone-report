var os = require('os');
var file = require('./file');
var params = require('./params');
// Курсы по умолчанию как в Carbone EE 5: исходная таблица params.js (EUR=1, USD=1.1403, RUB=77.6790, …).
// Вывод из эталонов: convCurr('USD') на 1000 даёт 1140.3000000000002 (= 1000 × 1.1403) при lang ru-ru
// и 14.679643146796433 (= 1000 / 77.6790 × 1.1403) при lang ru (help/fmt-convcurr) — ровно эта таблица.
var DEFAULT_CURRENCY_RATES = Object.freeze(Object.assign({}, params.currencyRates));
var builder = require('./builder');
var input = require('./input');
var translator = require('./translator');
var preprocessor = require('./preprocessor');
var dayjs = require('dayjs');
var locales = require('../formatters/_locale');

var carbone = {

  /**
   * Глобальные параметры библиотеки (встроенная сборка: без LibreOffice, без временных каталогов).
   * @param {Object} options {
   *                           templatePath : каталог шаблонов для относительных путей в render
   *                           lang         : язык по умолчанию, можно переопределить в options.lang
   *                           timezone     : часовой пояс по умолчанию, можно переопределить в options.timezone
   *                           translations : объект переводов
   *                           currencySource : валюта данных, по умолчанию зависит от локали
   *                           currencyTarget : валюта по умолчанию для convCurr
   *                           currencyRates  : курсы относительно EUR { EUR : 1, USD : 1.14 }
   *                         }
   */
  set : function (options) {
    for (var attr in options) {
      if (params[attr] !== undefined) {
        params[attr] = options[attr];
      }
      else {
        throw Error('Undefined options :' + attr);
      }
    }
    // Переводы из каталога шаблонов (templatePath/lang/*.json), если они не переданы явно
    if (options.templatePath !== undefined && options.translations === undefined) {
      translator.loadTranslations(params.templatePath);
    }
    dayjs.tz.setDefault(params.timezone);
    dayjs.locale(params.lang.toLowerCase());
  },

  /**
   * Reset parameters (for test purpose)
   */
  reset : function () {
    // manage node 0.8 / 0.10 differences
    var _nodeVersion = process.versions.node.split('.');
    var _tmpDir = (parseInt(_nodeVersion[0], 10) === 0 && parseInt(_nodeVersion[1], 10) < 10) ? os.tmpDir() : os.tmpdir();

    params.tempPath                = _tmpDir;
    params.templatePath            = process.cwd();
    params.uidPrefix               = 'c';
    params.lang                    = 'en';
    params.timezone                = 'Europe/Paris';
    params.translations            = {};
    params.currencySource          = '';
    params.currencyTarget          = '';
    params.currencyRates           = Object.assign({}, DEFAULT_CURRENCY_RATES);
  },

  /**
   * add formatters
   * @param {Object} formatters {toInt: function(d, args, agrs, ...)}
   */
  addFormatters : function (customFormatters) {
    for (var f in customFormatters) {
      input.formatters[f] = customFormatters[f];
    }
  },

  /**
   * Render XML directly
   *
   * @param {String}        xml          The XML
   * @param {Object|Array}  data         The data
   * @param {Object}        optionsRaw   The options raw
   * @param {Function}      callbackRaw  The callback raw
   */
  renderXML : function (xml, data, optionsRaw, callbackRaw) {
    input.parseOptions(optionsRaw, callbackRaw, function (options, callback) {
      // Clean XML tags inside Carbone markers and translate
      xml = preprocessor.preParseXML(xml, options);
      return builder.buildXML(xml, data, options, callback);
    });
  },

  /**
   * Renders a template with given datas and return result to the callback function
   *
   * @param {String}       templatePath : file name of the template (or absolute path)
   * @param {Object|Array} data : Datas to be inserted in the template represented by the {d.****}
   * @param {Object}       optionsRaw [optional] : {
   *                          'complement'   : {}    data which is represented by the {c.****}
   *                          'convertTo'    : не поддерживается, допустим только формат шаблона (иначе ошибка)
   *                          'extension'    : 'odt' || undefined Specify the template extension
   *                          'variableStr'  : ''    pre-declared variables,
   *                          'lang'         : overwrite default lang. Ex. "fr"
   *                          'timezone'     : set timezone for date formatters (Europe/Paris) by default
   *                          'translations' : overwrite all loaded translations {fr: {}, en: {}, es: {}}
   *                          'enum'         : { ORDER_STATUS : ['open', 'close', 'sent']
   *                          'currencySource'   : currency of data, 'EUR'
   *                          'currencyTarget' : default target currency when the formatter convCurr is used without target
   *                          'currencyRates'  : rates, based on EUR { EUR : 1, USD : 1.14 }
   *                       }
   * @param {Function}     callbackRaw(err, buffer, reportName) : Function called after generation with the result
   */
  render : function (templatePath, data, optionsRaw, callbackRaw) {
    input.parseOptions(optionsRaw, callbackRaw, function (options, callback) {
      // open the template (unzip if necessary)
      file.openTemplate(templatePath, function (err, template) {
        if (err) {
          return callback(err, null);
        }
        // Determine the template extension.
        var _extension = file.detectType(template);
        // It takes the user defined one, or use the file type.
        options.extension = optionsRaw.extension || _extension;
        if (options.extension === null) {
          return callback('Unknown input file type. It should be a docx, xlsx, pptx, odt, ods, odp, xhtml, html or an xml file');
        }
        // Конвертация форматов в этой сборке не поддерживается: допустим только формат шаблона
        var _convertTo = optionsRaw.convertTo;
        if (_convertTo && typeof _convertTo === 'object') {
          _convertTo = _convertTo.formatName;
        }
        if (typeof _convertTo === 'string' && _convertTo.toLowerCase().trim() !== options.extension) {
          return callback('Conversion is not supported in this build. Use the same format as the template.');
        }
        template.reportName = options.reportName;
        template.extension = options.extension;
        preprocessor.execute(template, options, function (err, template) {
          if (err) {
            return callback(err, null);
          }
          // parse all files of the template
          walkFiles(template, data, options, 0, function (err, report) {
            if (err) {
              return callback(err, null);
            }
            // assemble all files and zip if necessary
            file.buildFile(report, function (err, result) {
              if (err) {
                return callback(err, null);
              }
              callback(null, result, report.reportName, (options.isDebugActive === true ? options.debugInfo : null) );
            });
          });
        });
      });
    });
  },

  renderBuffer : renderBuffer,

  /**
   * Определить расширение шаблона по пути
   * @param {String} filePath Путь к файлу
   * @param {Function} callback(err, extension)
   */
  getFileExtension : function (filePath, callback) {
    file.openTemplate(filePath, function (err, template) {
      if (err) {
        return callback(err);
      }
      var ext = file.detectType(template);
      if (ext === null) {
        return callback('Cannot detect file extension');
      }
      return callback(null, ext);
    });
  },

  formatters : input.formatters
};

/** ***************************************************************************************************************/
/* Privates methods */
/** ***************************************************************************************************************/

/**
 * Parse and compute XML for all files of the template
 * @param  {Object}   template     template file returned by file.js
 * @param  {Object}   data         data to insert
 * @param  {Object}   options      {'complement', 'variables', ...}
 * @param  {Integer}  currentIndex currently visited files in the template
 * @param  {Function} callback(err, template)
 */
function walkFiles (template, data, options, currentIndex, callback) {
  if (currentIndex >= template.files.length) {
    // we have parsed all files, now parse the reportName
    if (template.reportName !== undefined) {
      builder.buildXML(template.reportName, data, options, function (err, reportNameResult) {
        template.reportName = reportNameResult;
        callback(null, template);
      });
    }
    else {
      callback(null, template);
    }
    return;
  }
  var _file = template.files[currentIndex];
  if (_file.isMarked===true) {
    builder.buildXML(_file.data, data, options, function (err, xmlResult) {
      if (err) {
        return callback(err, template);
      }
      _file.data = xmlResult;
      process.nextTick(function () {
        walkFiles(template, data, options, ++currentIndex, callback);
      });
    });
  }
  else {
    walkFiles(template, data, options, ++currentIndex, callback);
  }
}


var ZIP_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

/**
 * Собирает отчёт из шаблона в памяти. Формат результата совпадает с форматом шаблона;
 * перевод в другой формат в этой сборке не поддерживается (его делает OnlyOffice в API).
 * @param {Buffer} template содержимое файла шаблона
 * @param {String} extension расширение шаблона: docx, xlsx, odt, ods, pptx, xml, html…
 * @param {*} data данные отчёта (d.)
 * @param {Object} [options] lang, timezone, complement, translations, currencySource, currencyTarget, currencyRates
 * @returns {Promise<Buffer>}
 */
function renderBuffer (template, extension, data, options) {
  return new Promise(function (resolve, reject) {
    // Ошибки Carbone бывают строками — приводим к Error с тем же текстом
    var _fail = function (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    // Синхронное исключение внутри колбэка цепочки не должно стать uncaught exception — превращаем в отказ промиса
    var _guard = function (fn) {
      return function () {
        try {
          return fn.apply(null, arguments);
        }
        catch (e) {
          return _fail(e);
        }
      };
    };
    if (!Buffer.isBuffer(template)) {
      return _fail(new Error('renderBuffer: template must be a Buffer'));
    }
    if (typeof extension !== 'string' || extension === '') {
      return _fail(new Error('renderBuffer: extension is required'));
    }
    // регистр расширения не важен: 'DOCX' — тоже zip
    if (ZIP_EXTENSIONS.indexOf(extension.toLowerCase()) !== -1 && !(template.length >= 2 && template[0] === 0x50 && template[1] === 0x4B)) {
      return _fail(new Error('renderBuffer: template is not a zip archive (PK signature expected) for extension "' + extension + '"'));
    }
    // parseOptions дописывает в complement неизменяемое свойство now — работаем с копией, объект вызывающего не трогаем
    var _userOptions = Object.assign({}, options);
    if (typeof _userOptions.complement === 'object' && _userOptions.complement !== null) {
      _userOptions.complement = Object.assign({}, _userOptions.complement);
    }
    input.parseOptions(_userOptions, _fail, _guard(function (_options) {
      _options.extension = extension;
      file.openTemplateBuffer(template, extension, _guard(function (err, _template) {
        if (err) {
          return _fail(err);
        }
        _template.extension = extension;
        preprocessor.execute(_template, _options, _guard(function (err, _template) {
          if (err) {
            return _fail(err);
          }
          walkFiles(_template, data, _options, 0, _guard(function (err, _report) {
            if (err) {
              return _fail(err);
            }
            file.buildFile(_report, _guard(function (err, _result) {
              if (err) {
                return _fail(err);
              }
              resolve(Buffer.isBuffer(_result) ? _result : Buffer.from(_result, 'utf8'));
            }));
          }));
        }));
      }));
    }));
  });
}

// add default formatters
carbone.addFormatters(require('../formatters/array.js'));
carbone.addFormatters(require('../formatters/condition.js'));
carbone.addFormatters(require('../formatters/date.js'));
carbone.addFormatters(require('../formatters/number.js'));
carbone.addFormatters(require('../formatters/string.js'));

// We must include all locales like this for PKG
require('dayjs/locale/af.js');
require('dayjs/locale/am.js');
require('dayjs/locale/ar-dz.js');
require('dayjs/locale/ar-kw.js');
require('dayjs/locale/ar-ly.js');
require('dayjs/locale/ar-ma.js');
require('dayjs/locale/ar-sa.js');
require('dayjs/locale/ar-tn.js');
require('dayjs/locale/ar.js');
require('dayjs/locale/az.js');
require('dayjs/locale/be.js');
require('dayjs/locale/bg.js');
require('dayjs/locale/bi.js');
require('dayjs/locale/bm.js');
require('dayjs/locale/bn.js');
require('dayjs/locale/bo.js');
require('dayjs/locale/br.js');
require('dayjs/locale/bs.js');
require('dayjs/locale/ca.js');
require('dayjs/locale/cs.js');
require('dayjs/locale/cv.js');
require('dayjs/locale/cy.js');
require('dayjs/locale/da.js');
require('dayjs/locale/de-at.js');
require('dayjs/locale/de-ch.js');
require('dayjs/locale/de.js');
require('dayjs/locale/dv.js');
require('dayjs/locale/el.js');
require('dayjs/locale/en-au.js');
require('dayjs/locale/en-ca.js');
require('dayjs/locale/en-gb.js');
require('dayjs/locale/en-ie.js');
require('dayjs/locale/en-il.js');
require('dayjs/locale/en-in.js');
require('dayjs/locale/en-nz.js');
require('dayjs/locale/en-sg.js');
require('dayjs/locale/en-tt.js');
require('dayjs/locale/en.js');
require('dayjs/locale/eo.js');
require('dayjs/locale/es-do.js');
require('dayjs/locale/es-pr.js');
require('dayjs/locale/es-us.js');
require('dayjs/locale/es.js');
require('dayjs/locale/et.js');
require('dayjs/locale/eu.js');
require('dayjs/locale/fa.js');
require('dayjs/locale/fi.js');
require('dayjs/locale/fo.js');
require('dayjs/locale/fr-ca.js');
require('dayjs/locale/fr-ch.js');
require('dayjs/locale/fr.js');
require('dayjs/locale/fy.js');
require('dayjs/locale/ga.js');
require('dayjs/locale/gd.js');
require('dayjs/locale/gl.js');
require('dayjs/locale/gom-latn.js');
require('dayjs/locale/gu.js');
require('dayjs/locale/he.js');
require('dayjs/locale/hi.js');
require('dayjs/locale/hr.js');
require('dayjs/locale/ht.js');
require('dayjs/locale/hu.js');
require('dayjs/locale/hy-am.js');
require('dayjs/locale/id.js');
require('dayjs/locale/is.js');
require('dayjs/locale/it-ch.js');
require('dayjs/locale/it.js');
require('dayjs/locale/ja.js');
require('dayjs/locale/jv.js');
require('dayjs/locale/ka.js');
require('dayjs/locale/kk.js');
require('dayjs/locale/km.js');
require('dayjs/locale/kn.js');
require('dayjs/locale/ko.js');
require('dayjs/locale/ku.js');
require('dayjs/locale/ky.js');
require('dayjs/locale/lb.js');
require('dayjs/locale/lo.js');
require('dayjs/locale/lt.js');
require('dayjs/locale/lv.js');
require('dayjs/locale/me.js');
require('dayjs/locale/mi.js');
require('dayjs/locale/mk.js');
require('dayjs/locale/ml.js');
require('dayjs/locale/mn.js');
require('dayjs/locale/mr.js');
require('dayjs/locale/ms-my.js');
require('dayjs/locale/ms.js');
require('dayjs/locale/mt.js');
require('dayjs/locale/my.js');
require('dayjs/locale/nb.js');
require('dayjs/locale/ne.js');
require('dayjs/locale/nl-be.js');
require('dayjs/locale/nl.js');
require('dayjs/locale/nn.js');
require('dayjs/locale/oc-lnc.js');
require('dayjs/locale/pa-in.js');
require('dayjs/locale/pl.js');
require('dayjs/locale/pt-br.js');
require('dayjs/locale/pt.js');
require('dayjs/locale/ro.js');
require('dayjs/locale/ru.js');
require('dayjs/locale/rw.js');
require('dayjs/locale/sd.js');
require('dayjs/locale/se.js');
require('dayjs/locale/si.js');
require('dayjs/locale/sk.js');
require('dayjs/locale/sl.js');
require('dayjs/locale/sq.js');
require('dayjs/locale/sr-cyrl.js');
require('dayjs/locale/sr.js');
require('dayjs/locale/ss.js');
require('dayjs/locale/sv.js');
require('dayjs/locale/sw.js');
require('dayjs/locale/ta.js');
require('dayjs/locale/te.js');
require('dayjs/locale/tet.js');
require('dayjs/locale/tg.js');
require('dayjs/locale/th.js');
require('dayjs/locale/tk.js');
require('dayjs/locale/tl-ph.js');
require('dayjs/locale/tlh.js');
require('dayjs/locale/tr.js');
require('dayjs/locale/tzl.js');
require('dayjs/locale/tzm-latn.js');
require('dayjs/locale/tzm.js');
require('dayjs/locale/ug-cn.js');
require('dayjs/locale/uk.js');
require('dayjs/locale/ur.js');
require('dayjs/locale/uz-latn.js');
require('dayjs/locale/uz.js');
require('dayjs/locale/vi.js');
require('dayjs/locale/yo.js');
require('dayjs/locale/zh-cn.js');
require('dayjs/locale/zh-hk.js');
require('dayjs/locale/zh-tw.js');
require('dayjs/locale/zh.js');

// if DayJS does not have a locale defined with country code, define it
// For example "de-de" does not exists in DaysJS, but "de" exists.
// So add locale "de-de" in DaysJS
for (let _locale in locales) {
  if (dayjs.Ls[_locale] === undefined) {
    let _localeWithoutCountry = _locale.replace(/-\S+/g, '');
    if (dayjs.Ls[_localeWithoutCountry] !== undefined) {
      dayjs.locale(_locale, dayjs.Ls[_localeWithoutCountry]);
    }
  }
}

dayjs.extend(require('dayjs/plugin/advancedFormat'));    // Support Quarter, ...
dayjs.extend(require('dayjs/plugin/localizedFormat'));   // Support L LL LLLL
dayjs.extend(require('dayjs/plugin/customParseFormat')); // Support custom format as input
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/isoWeek'));
dayjs.extend(require('dayjs/plugin/timezone'));

dayjs.tz.setDefault('Europe/Paris');
dayjs.locale('en');

module.exports = carbone;
