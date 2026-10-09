const params = require('./params');
const parser = require('./parser');
const locale = require('../formatters/_locale.js');
const formatters = Object.create(null); // Remove  __proto__ and constructor attributes. Mitigates prototype pollution attacks.

/**
 * Parse options coming from user-side. Clean it and generate a safe options object for internal use
 *
 * @param {Object}    userDefinedOptions  The options object coming from user-side, passed in carbone.render(XML) is used
 * @param {<type>}    callbackFn          The callback function of carbone.render(XML)
 * @param {Function}  callback            The callback of this function
 */
function parseOptions (userDefinedOptions, callbackFn, callback) {
  if (typeof(userDefinedOptions) === 'function') {
    callbackFn = userDefinedOptions;
    userDefinedOptions = {};
  }
  // define a default complement object with the current date
  if (typeof(userDefinedOptions.complement) !== 'object' || userDefinedOptions.complement === null) {
    userDefinedOptions.complement = {};
  }
  if (!userDefinedOptions.complement.now) {
    Object.defineProperty(userDefinedOptions.complement, 'now', {
      value      : (new Date()).toISOString(),
      enumerable : false
    });
  }
  // analyze pre-declared variables in the Object "userDefinedOptions"
  parser.findVariables(userDefinedOptions.variableStr, function (err, str, variables) {
    var _options = {
      enum              : userDefinedOptions.enum,
      currency          : {},
      lang              : (userDefinedOptions.lang || params.lang).toLowerCase(),
      timezone          : (userDefinedOptions.timezone || params.timezone),
      translations      : userDefinedOptions.translations || params.translations,
      complement        : userDefinedOptions.complement,
      reportName        : userDefinedOptions.reportName,
      extension         : userDefinedOptions.extension,
      formatters        : formatters,
      existingVariables : variables,
      isDebugActive     : userDefinedOptions.isDebugActive || false,     // show info about the template
      debugInfo         : { markers : [] } // filled and returned after POST /render if isDebugActive === true
    };
    var _currency           = _options.currency;
    var _locale             = locale[_options.lang] || locale.en;
    var _currencyFromLocale = _locale.currency.code;
    _currency.source        = userDefinedOptions.currencySource || params.currencySource;
    _currency.target        = userDefinedOptions.currencyTarget || params.currencyTarget;
    _currency.rates         = userDefinedOptions.currencyRates  || params.currencyRates;
    if (!_currency.source) {
      _currency.source = _currencyFromLocale;
    }
    if (!_currency.target) {
      _currency.target = _currencyFromLocale;
    }
    return callback(_options, callbackFn);
  });
}

module.exports = {
  formatters,
  parseOptions
};
