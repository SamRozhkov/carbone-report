// Диаграммы DOCX/XLSX (2.5.0, спецификация §34.2): чистые функции — разбор ссылок `c:f`, числа, кэш точек.
// Сборка (renderBuffer): препроцессор помечает листы книг с диаграммами (tagSheet, правило R1), после сборки
// finish переписывает ссылки `c:f` (R2), кэши точек и ячейки числовых рядов, затем снимает служебные атрибуты.
const path = require('path');
const xmltree = require('./xmltree');

// Лист: в кавычках (кавычка внутри удваивается) или без; адрес: [$]СТОЛБЕЦ[$]СТРОКА
const CELL = '(\\$?)([A-Za-z]{1,3})(\\$?)([1-9]\\d*)';
// в имени листа `[` и `]` недопустимы: `'[1]Лист'!A1` — ссылка на внешнюю книгу
const REF_RE = new RegExp('^(?:\'((?:[^\'\\[\\]]|\'\')+)\'|([^\'!:,()\\[\\]\\s]+))!' + CELL + '(?::' + CELL + ')?$');
const NUMBER_RE = /^-?\d+([.,]\d+)?([eE][-+]?\d+)?$/;

const charts = {
  /**
   * Разобрать ссылку `c:f` на диапазон; всё прочее (объединения, целые столбцы/строки, внешние книги, имена) — null
   * @param  {String} f
   * @return {Object|null}
   */
  parseRef : function (f) {
    if (typeof f !== 'string') {
      return null;
    }
    const m = REF_RE.exec(f);
    if (m === null) {
      return null;
    }
    const quoted = m[1] !== undefined;
    const single = m[8] === undefined;
    return {
      sheet  : quoted ? m[1].replace(/''/g, '\'') : m[2],
      quoted : quoted,
      c1     : m[4],
      r1     : parseInt(m[6], 10),
      c2     : single ? m[4] : m[8],
      r2     : parseInt(single ? m[6] : m[10], 10),
      abs    : {
        c1 : m[3] === '$',
        r1 : m[5] === '$',
        c2 : single ? m[3] === '$' : m[7] === '$',
        r2 : single ? m[5] === '$' : m[9] === '$'
      }
    };
  },

  /**
   * Собрать ссылку обратно; одна ячейка — без `:`
   * @param  {Object} ref  результат parseRef
   * @return {String}
   */
  formatRef : function (ref) {
    const sheet = ref.quoted ? '\'' + ref.sheet.replace(/'/g, '\'\'') + '\'' : ref.sheet;
    const a = ref.abs;
    let out = sheet + '!' + (a.c1 ? '$' : '') + ref.c1 + (a.r1 ? '$' : '') + ref.r1;
    if (ref.c2 !== ref.c1 || ref.r2 !== ref.r1 || a.c2 !== a.c1 || a.r2 !== a.r1) {
      out += ':' + (a.c2 ? '$' : '') + ref.c2 + (a.r2 ? '$' : '') + ref.r2;
    }
    return out;
  },

  /**
   * Правило R2: пересчитать строки диапазона шаблона в строки результата
   * @param  {Map<Number, {first: Number, last: Number}>} rowMap  строка шаблона -> первая и последняя строки результата
   * @param  {Number} r1  первая строка диапазона шаблона
   * @param  {Number} r2  последняя строка диапазона шаблона
   * @return {{r1: Number, r2: Number, empty: Boolean}}
   */
  remapRows : function (rowMap, r1, r2) {
    let start = null;
    let end = null;
    let startKey = Infinity;
    let endKey = -Infinity;
    let maxLast = 0;
    rowMap.forEach(function (v, key) {
      if (v.last > maxLast) {
        maxLast = v.last;
      }
      // начало: сама строка либо ближайшая большая
      if (key >= r1 && key < startKey) {
        startKey = key;
        start = v.first;
      }
      // конец: сама строка либо ближайшая меньшая
      if (key <= r2 && key > endKey) {
        endKey = key;
        end = v.last;
      }
    });
    if (start === null && end === null) {
      return { r1 : r1, r2 : r2, empty : true };
    }
    if (end === null) {
      end = 0;
    }
    if (start === null) {
      start = maxLast + 1;
    }
    if (start > end) {
      return { r1 : end + 1, r2 : end + 1, empty : true };
    }
    return { r1 : start, r2 : end, empty : false };
  },

  /**
   * Текст ячейки -> число для числового ряда (пробелы и U+00A0 убираются, запятая — десятичный разделитель)
   * @param  {String} text
   * @return {Number|null}
   */
  toNumber : function (text) {
    if (typeof text !== 'string') {
      return null;
    }
    const s = text.replace(/[\s ]/g, '');
    if (!NUMBER_RE.test(s)) {
      return null;
    }
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  },

  /**
   * Содержимое `c:strCache`; прежние `c:ptCount`/`c:pt` из innerXml отбрасываются, прочее (extLst) остаётся после точек
   * @param  {Array<String|null>} values  уже экранированные для XML значения
   * @param  {String} innerXml  прежнее содержимое кэша
   * @return {String}
   */
  buildStrCache : function (values, innerXml) {
    let out = '<c:ptCount val="' + values.length + '"/>';
    values.forEach(function (v, i) {
      if (v !== null && v !== undefined && v !== '') {
        out += '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>';
      }
    });
    const rest = (innerXml || '')
      .replace(/<c:ptCount\b[^>]*\/>/g, '')
      .replace(/<c:pt\b[^>]*>[\s\S]*?<\/c:pt>/g, '');
    return out + rest;
  },

  /**
   * Содержимое `c:numCache`; `formatCode` (уже в виде XML-текста) — первым, если был
   * @param  {Array<Number|null>} values
   * @param  {String|null} formatCode
   * @return {String}
   */
  buildNumCache : function (values, formatCode) {
    let out = formatCode !== null && formatCode !== undefined ? '<c:formatCode>' + formatCode + '</c:formatCode>' : '';
    out += '<c:ptCount val="' + values.length + '"/>';
    values.forEach(function (v, i) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        out += '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>';
      }
    });
    return out;
  },

  /** Буквы столбца -> номер (A=1) */
  columnIndex : function (letters) {
    let n = 0;
    String(letters).toUpperCase().split('').forEach(function (ch) {
      n = n * 26 + ch.charCodeAt(0) - 64;
    });
    return n;
  },

  /** Номер столбца -> буквы (как preprocessor.columnName; свой — препроцессор сам требует этот модуль) */
  columnName : function (index) {
    let name = '';
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
      name = String.fromCharCode(65 + (n - 1) % 26) + name;
    }
    return name;
  },

  /**
   * Есть ли диаграммы `c:chartSpace`, данные которых лежат в книге parent ('' — книга верхнего уровня XLSX,
   * иначе путь встроенной книги DOCX)
   * @param  {Object} template
   * @param  {String} parent
   * @return {Boolean}
   */
  hasCharts : function (template, parent) {
    const files = template && template.files instanceof Array ? template.files : [];
    return files.some(function (f) {
      return chartWorkbook(files, f) === parent;
    });
  },

  /**
   * Правило R1: пометить строки листа исходным номером (`crRow`), ячейки — буквой столбца (`crCol`)
   * @param  {String} xml  лист
   * @return {String}
   */
  tagSheet : function (xml) {
    return mapSheetData(xml, function (data) {
      return data.replace(/<(row|c)\b([^>]*?)(\/?)>/g, function (tag, name, attrs, slash) {
        const r = R_ATTR.exec(attrs);
        if (r === null) {
          return tag;
        }
        if (name === 'row') {
          return /^\d+$/.test(r[1]) === true ? '<row' + attrs + ' crRow="' + r[1] + '"' + slash + '>' : tag;
        }
        const col = /^\$?([A-Za-z]{1,3})\$?\d+$/.exec(r[1]);
        return col !== null ? '<c' + attrs + ' crCol="' + col[1].toUpperCase() + '"' + slash + '>' : tag;
      });
    });
  },

  /**
   * После сборки всех файлов: номера строк и ячеек помеченных листов (R1), ссылки `c:f` (R2), кэши точек
   * и числа в ячейках числовых рядов диаграмм верхнего уровня; служебные атрибуты снимаются.
   * Синхронно, меняет template.files.
   * @param  {Object} template
   */
  finish : function (template) {
    if (template === null || template === undefined || !(template.files instanceof Array)) {
      return;
    }
    const files = template.files;
    const tagged = files.filter(function (f) {
      return f.chartsTagged === true && typeof f.data === 'string';
    });
    if (tagged.length === 0) {
      return;
    }
    const rowMaps = new Map();
    tagged.forEach(function (f) {
      const res = numberSheet(f.data);
      f.data = res.xml;
      rowMaps.set(f, res.rowMap);
    });
    const books = new Map();
    const jobs = [];
    files.forEach(function (chart) {
      const parent = chartWorkbook(files, chart);
      if (parent === null) {
        return;
      }
      if (books.has(parent) === false) {
        books.set(parent, loadWorkbook(files, parent));
      }
      const book = books.get(parent);
      const tree = xmltree.parse(chart.data);
      xmltree.descendants(tree.root, ['c:ser']).forEach(function (ser) {
        ser.children.forEach(function (part) {
          if (SERIES_PARTS.indexOf(part.name) === -1) {
            return;
          }
          // c:multiLvlStrRef (R3), c:strLit/c:numLit — не трогаются
          part.children.forEach(function (refEl) {
            if (refEl.name !== 'c:strRef' && refEl.name !== 'c:numRef') {
              return;
            }
            const job = refJob(chart, refEl, book, rowMaps);
            if (job !== null) {
              jobs.push(job);
            }
          });
        });
      });
    });
    // ячейки числовых рядов — числа (до построения кэшей)
    const toConvert = new Map();
    jobs.forEach(function (job) {
      if (job.numeric === true) {
        const item = toConvert.get(job.sheet) || { book : job.book, cells : new Set() };
        job.cells.forEach(function (ref) {
          item.cells.add(ref);
        });
        toConvert.set(job.sheet, item);
      }
    });
    toConvert.forEach(function (item, sheet) {
      sheet.data = convertCells(sheet.data, item.cells, item.book.shared);
    });
    // кэши точек
    const cellMaps = new Map();
    const edits = new Map();
    jobs.forEach(function (job) {
      if (cellMaps.has(job.sheet) === false) {
        cellMaps.set(job.sheet, readCells(job.sheet.data, job.book.shared));
      }
      const cells = cellMaps.get(job.sheet);
      const list = edits.get(job.chart) || [];
      edits.set(job.chart, list);
      list.push({ start : job.f.openEnd, end : job.f.closeStart, rep : job.fText });
      const xml = job.chart.data;
      let content;
      if (job.numeric === true) {
        const fc = job.cache === null ? undefined : job.cache.children.find(function (el) {
          return el.name === 'c:formatCode';
        });
        const formatCode = fc === undefined ? null : xml.slice(fc.openEnd, fc.closeStart);
        content = charts.buildNumCache(job.cells.map(function (ref) {
          const c = cells.get(ref);
          return c === undefined ? null : c.num;
        }), formatCode);
      }
      else {
        const old = job.cache === null ? '' : xml.slice(job.cache.openEnd, job.cache.closeStart);
        content = charts.buildStrCache(job.cells.map(function (ref) {
          const c = cells.get(ref);
          return c === undefined ? null : c.text;
        }), old);
      }
      const cacheName = job.numeric === true ? 'c:numCache' : 'c:strCache';
      if (job.cache === null) {
        list.push({ start : job.f.end, end : job.f.end, rep : '<' + cacheName + '>' + content + '</' + cacheName + '>' });
      }
      else if (job.cache.openEnd === job.cache.end) {
        // пустой элемент <c:strCache/>
        list.push({ start : job.cache.start, end : job.cache.end, rep : '<' + cacheName + '>' + content + '</' + cacheName + '>' });
      }
      else {
        list.push({ start : job.cache.openEnd, end : job.cache.closeStart, rep : content });
      }
    });
    edits.forEach(function (list, chart) {
      chart.data = xmltree.applyEdits(chart.data, list);
    });
    tagged.forEach(function (f) {
      f.data = f.data.replace(/\scr(?:Row|Col)="[^"]*"/g, '');
    });
  }
};

const R_ATTR = /\sr\s*=\s*"([^"]*)"/;
const CHART_RE = /^(word|xl)\/charts\/chart\d+\.xml$/;
// элементы ряда, где бывают ссылки на ячейки
const SERIES_PARTS = ['c:tx', 'c:cat', 'c:val', 'c:xVal', 'c:yVal', 'c:bubbleSize'];
const CELL_RE = /<c\b([^>]*?)(?:\/>|>((?:(?!<\/c>)[\s\S])*)<\/c>)/g;

function isTop (f) {
  return f.parent === '' || f.parent === undefined;
}

function escapeXml (s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml (s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) {
      return String.fromCodePoint(parseInt(h, 16));
    })
    .replace(/&#(\d+);/g, function (m, n) {
      return String.fromCodePoint(Number(n));
    })
    .replace(/&amp;/g, '&');
}

/** Применить fn к содержимому sheetData листа */
function mapSheetData (xml, fn) {
  if (typeof xml !== 'string') {
    return xml;
  }
  const start = xml.indexOf('<sheetData');
  const end = xml.lastIndexOf('</sheetData>');
  if (start === -1 || end === -1) {
    return xml;
  }
  return xml.slice(0, start) + fn(xml.slice(start, end)) + xml.slice(end);
}

/** Связи файла: Id -> { type, target } (target — путь в архиве) */
function readRels (relsXml, dir) {
  const rels = new Map();
  if (typeof relsXml !== 'string') {
    return rels;
  }
  const attr = function (tag, name) {
    const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
    return m === null ? null : unescapeXml(m[1]);
  };
  (relsXml.match(/<Relationship\b[^>]*>/g) || []).forEach(function (tag) {
    const id = attr(tag, 'Id');
    let target = attr(tag, 'Target');
    if (id === null || target === null || attr(tag, 'TargetMode') === 'External') {
      return;
    }
    try {
      target = decodeURIComponent(target);
    }
    catch (e) {
      // адрес без процентного кодирования
    }
    target = target.charAt(0) === '/' ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target));
    rels.set(id, { type : attr(tag, 'Type') || '', target : target });
  });
  return rels;
}

/**
 * Книга с данными диаграммы: '' — верхний уровень XLSX, путь встроенной книги — DOCX, null — не диаграмма
 * `c:chartSpace` верхнего уровня или книги нет
 */
function chartWorkbook (files, chart) {
  if (!isTop(chart) || CHART_RE.test(chart.name) === false || typeof chart.data !== 'string' || chart.data.indexOf('<c:chartSpace') === -1) {
    return null;
  }
  if (chart.name.indexOf('xl/') === 0) {
    return '';
  }
  const relsName = 'word/charts/_rels/' + path.posix.basename(chart.name) + '.rels';
  const relsFile = files.find(function (f) {
    return isTop(f) && f.name === relsName;
  });
  if (relsFile === undefined) {
    return null;
  }
  const rels = readRels(relsFile.data, 'word/charts');
  const isPackage = function (rel) {
    return rel !== undefined && /\/relationships\/package$/.test(rel.type) === true;
  };
  const external = /<c:externalData\b[^>]*\sr:id\s*=\s*"([^"]*)"/.exec(chart.data);
  let rel = external !== null ? rels.get(external[1]) : undefined;
  if (isPackage(rel) === false) {
    rel = Array.from(rels.values()).find(isPackage);
  }
  if (rel === undefined) {
    return null;
  }
  const parent = rel.target;
  const unzipped = files.some(function (f) {
    return f.parent === parent;
  });
  return unzipped === true ? parent : null;
}

/** Листы книги по имени (без учёта регистра, как в Excel) и общие строки */
function loadWorkbook (files, parent) {
  const inBook = files.filter(function (f) {
    return parent === '' ? isTop(f) : f.parent === parent;
  });
  const byName = function (name) {
    return inBook.find(function (f) {
      return f.name === name;
    });
  };
  const book = { sheets : new Map(), shared : [] };
  const workbook = byName('xl/workbook.xml') || inBook.find(function (f) {
    return /(^|\/)workbook\.xml$/.test(f.name) === true;
  });
  if (workbook === undefined || typeof workbook.data !== 'string') {
    return book;
  }
  const dir = path.posix.dirname(workbook.name);
  const relsFile = byName((dir === '.' ? '' : dir + '/') + '_rels/workbook.xml.rels');
  const rels = readRels(relsFile === undefined ? null : relsFile.data, dir === '.' ? '' : dir);
  (workbook.data.match(/<sheet\b[^>]*>/g) || []).forEach(function (tag) {
    const name = /\sname\s*=\s*"([^"]*)"/.exec(tag);
    const id = /\s[\w]+:id\s*=\s*"([^"]*)"/.exec(tag);
    const rel = id === null ? undefined : rels.get(id[1]);
    const sheet = rel === undefined ? undefined : byName(rel.target);
    if (name !== null && sheet !== undefined) {
      book.sheets.set(unescapeXml(name[1]).toLowerCase(), sheet);
    }
  });
  const sst = inBook.find(function (f) {
    return /(^|\/)sharedStrings\.xml$/.test(f.name) === true;
  });
  if (sst !== undefined && typeof sst.data === 'string') {
    for (const m of sst.data.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      book.shared.push(m[1]);
    }
  }
  return book;
}

/**
 * R1 после сборки: строки подряд (как addRowCounterInWorksheet), ячейкам r = crCol + номер строки; в строке
 * с повторяющимся crCol (цикл по столбцам) ячейки без номеров
 * @return {{xml: String, rowMap: Map<Number, {first: Number, last: Number}>}}
 */
function numberSheet (xml) {
  const rowMap = new Map();
  let rowNum = 0;
  const out = mapSheetData(xml, function (data) {
    return data.replace(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g, function (m, attrs, tail, body) {
      const r = R_ATTR.exec(attrs);
      rowNum = r !== null && /^\d+$/.test(r[1]) === true ? parseInt(r[1], 10) : rowNum + 1;
      const crRow = /\scrRow="(\d+)"/.exec(attrs);
      if (crRow !== null) {
        const key = parseInt(crRow[1], 10);
        const range = rowMap.get(key);
        if (range === undefined) {
          rowMap.set(key, { first : rowNum, last : rowNum });
        }
        else {
          range.last = rowNum;
        }
      }
      const open = r !== null ? '<row' + attrs : '<row r="' + rowNum + '"' + attrs;
      if (tail === '/>') {
        return open + '/>';
      }
      const cols = Array.from(body.matchAll(/<c\b[^>]*?\scrCol="([A-Z]+)"/g), function (c) {
        return c[1];
      });
      if (new Set(cols).size !== cols.length) {
        return open + '>' + body + '</row>';
      }
      const row = rowNum;
      return open + '>' + body.replace(/<c\b([^>]*?)(\/?)>/g, function (tag, cellAttrs, slash) {
        const col = /\scrCol="([A-Z]+)"/.exec(cellAttrs);
        if (col === null || R_ATTR.test(cellAttrs) === true) {
          return tag;
        }
        return '<c r="' + col[1] + row + '"' + cellAttrs + slash + '>';
      }) + '</row>';
    });
  });
  return { xml : out, rowMap : rowMap };
}

/** Текст строки (содержимое <is> или <si>): все <t> подряд, фонетика (<rPh>) не в счёт; XML-экранирование остаётся */
function richText (xml) {
  let text = '';
  const plain = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of plain.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += m[1] === undefined ? '' : m[1];
  }
  return text;
}

/** Содержимое ячейки: тип t, текст (XML-экранированный) и число (для ячеек-чисел) */
function cellValue (attrs, body, shared) {
  const t = /\st\s*=\s*"([^"]*)"/.exec(attrs);
  const type = t === null ? 'n' : t[1];
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body || '');
  const raw = v === null ? '' : v[1];
  if (type === 'inlineStr') {
    const is = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(body || '');
    return { type : type, text : is === null ? '' : richText(is[1]), num : null };
  }
  if (type === 's') {
    const si = shared[parseInt(raw, 10)];
    return { type : type, text : si === undefined ? '' : richText(si), num : null };
  }
  const n = type === 'n' && raw.trim() !== '' ? Number(raw) : NaN;
  return { type : type, text : raw, num : Number.isFinite(n) ? n : null };
}

/** Ячейки-строки из set (адреса A1), текст которых — число, становятся числами `<c …><v>n</v></c>` (s сохраняется) */
function convertCells (xml, set, shared) {
  return mapSheetData(xml, function (data) {
    return data.replace(CELL_RE, function (m, attrs, body) {
      const r = R_ATTR.exec(attrs);
      if (r === null || set.has(r[1]) === false || /<f\b/.test(body || '') === true) {
        return m;
      }
      const cell = cellValue(attrs, body, shared);
      if (cell.type !== 'inlineStr' && cell.type !== 's') {
        return m;
      }
      const n = charts.toNumber(unescapeXml(cell.text));
      if (n === null) {
        return m;
      }
      return '<c' + attrs.replace(/\st\s*=\s*"[^"]*"/, '') + '><v>' + n + '</v></c>';
    });
  });
}

/** Адрес A1 -> { text, num } по всем ячейкам листа с номером */
function readCells (xml, shared) {
  const cells = new Map();
  mapSheetData(xml, function (data) {
    for (const m of data.matchAll(CELL_RE)) {
      const r = R_ATTR.exec(m[1]);
      if (r !== null) {
        const cell = cellValue(m[1], m[2], shared);
        cells.set(r[1], { text : cell.text, num : cell.num });
      }
    }
    return data;
  });
  return cells;
}

/** Ссылка c:strRef/c:numRef -> задание: новый текст c:f и адреса ячеек; null — ссылку не трогать */
function refJob (chart, refEl, book, rowMaps) {
  const xml = chart.data;
  const f = refEl.children.find(function (el) {
    return el.name === 'c:f';
  });
  if (f === undefined || f.openEnd === f.end) {
    return null;
  }
  const fText = unescapeXml(xml.slice(f.openEnd, f.closeStart));
  const ref = charts.parseRef(fText);
  if (ref === null) {
    return null;
  }
  const sheet = book.sheets.get(ref.sheet.toLowerCase());
  const rowMap = sheet === undefined ? undefined : rowMaps.get(sheet);
  if (rowMap === undefined) {
    return null;
  }
  const isRange = fText.indexOf(':', fText.lastIndexOf('!')) !== -1;
  const rows = charts.remapRows(rowMap, Math.min(ref.r1, ref.r2), Math.max(ref.r1, ref.r2));
  const out = Object.assign({}, ref, { r1 : rows.r1, r2 : rows.empty === true ? rows.r1 : rows.r2 });
  let text = charts.formatRef(out);
  if (isRange === true && text.indexOf(':', text.lastIndexOf('!')) === -1) {
    // диапазон из одной строки остаётся диапазоном
    text += ':' + (out.abs.c2 ? '$' : '') + out.c2 + (out.abs.r2 ? '$' : '') + out.r2;
  }
  const cells = [];
  if (rows.empty !== true) {
    const ca = charts.columnIndex(ref.c1);
    const cb = charts.columnIndex(ref.c2);
    for (let r = out.r1; r <= out.r2; r++) {
      for (let c = Math.min(ca, cb); c <= Math.max(ca, cb); c++) {
        cells.push(charts.columnName(c) + r);
      }
    }
  }
  const numeric = refEl.name === 'c:numRef';
  const cache = refEl.children.find(function (el) {
    return el.name === (numeric ? 'c:numCache' : 'c:strCache');
  });
  return {
    chart   : chart,
    book    : book,
    sheet   : sheet,
    f       : f,
    fText   : escapeXml(text),
    numeric : numeric,
    cache   : cache === undefined ? null : cache,
    cells   : cells
  };
}

module.exports = charts;
