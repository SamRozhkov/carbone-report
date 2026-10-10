const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

// XLSX-файл целиком (renderBuffer): препроцессор переводит общие строки во встроенные и убирает r у строк и ячеек;
// после сборки (циклы) текст снова уходит в sharedStrings.xml, номера ставятся заново. Со встроенными
// строками OnlyOffice Document Server 9.4 при конвертации оставлял только первую ячейку-текст (CI 38051370006).
describe('XLSX: общие строки и номера строк и ячеек после сборки', function () {
  const yazl = require('yazl');
  const yauzl = require('yauzl');
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const zip = (files) => new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    const parts = [];
    z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name);
    z.end();
  });
  const entry = (buffer, name) => new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      z.on('entry', (e) => {
        if (e.fileName !== name) return z.readEntry();
        z.openReadStream(e, (err2, s) => {
          if (err2) return reject(err2);
          const parts = [];
          s.on('data', (c) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        });
      });
      z.on('end', () => reject(new Error('нет ' + name)));
      z.readEntry();
    });
  });
  // строки — массивы значений ячеек; общие строки, как в файле Excel (sharedStrings.xml)
  async function xlsx (rows, cols, extra) {
    const strings = [];
    const cell = (v, r, c) => {
      const ref = String.fromCharCode(65 + c) + r;
      strings.push(v);
      return '<c r="' + ref + '" t="s"><v>' + (strings.length - 1) + '</v></c>';
    };
    const sheet = rows.map((cells, r) => '<row r="' + (r + 1) + '" spans="1:' + cells.length + '">' + cells.map((v, c) => cell(v, r + 1, c)).join('') + '</row>').join('');
    return zip({
      '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
      '_rels/.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML + '<workbook xmlns="' + M + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
      'xl/sharedStrings.xml': XML + '<sst xmlns="' + M + '">' + strings.map((s) => '<si><t>' + s + '</t></si>').join('') + '</sst>',
      'xl/worksheets/sheet1.xml': XML + '<worksheet xmlns="' + M + '">' + (cols || '') + '<sheetData>' + sheet + '</sheetData></worksheet>',
      ...(extra || {})
    });
  }
  // [[ref, текст]] по строкам; проверка: строки 1…N подряд, ячейки A, B, C… с номером своей строки
  function grid (sheetXml, sst) {
    const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(''));
    const rows = [];
    let expectRow = 1;
    for (const [, rowAttrs, body] of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = /\sr="(\d+)"/.exec(rowAttrs);
      assert.ok(r, 'у строки нет r: ' + rowAttrs);
      assert.strictEqual(Number(r[1]), expectRow++, 'номера строк не подряд');
      let col = 0;
      const cells = [];
      for (const [, cellAttrs, inner] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\sr="([A-Z]+)(\d+)"/.exec(cellAttrs);
        assert.ok(ref, 'у ячейки нет r: ' + cellAttrs);
        assert.strictEqual(ref[1], String.fromCharCode(65 + col++), 'столбцы не подряд');
        assert.strictEqual(ref[2], r[1], 'номер строки в ссылке ячейки');
        assert.ok(!/inlineStr/.test(cellAttrs), 'встроенная строка осталась: ' + cellAttrs);
        const v = ((inner || '').match(/<v>([^<]*)<\/v>/) || [])[1];
        cells.push(/\st="s"/.test(cellAttrs) ? strings[Number(v)] : (v || ''));
      }
      rows.push(cells);
    }
    return rows;
  }
  async function render (rows, data, cols) {
    const out = await renderBuffer(await xlsx(rows, cols), 'xlsx', data, RU);
    const sheet = await entry(out, 'xl/worksheets/sheet1.xml');
    const sst = await entry(out, 'xl/sharedStrings.xml');
    assert.match(await entry(out, '[Content_Types].xml'), /PartName="\/xl\/sharedStrings\.xml"/);
    assert.match(await entry(out, 'xl/_rels/workbook.xml.rels'), /relationships\/sharedStrings" Target="sharedStrings\.xml"/);
    return { sheet, sst, grid: grid(sheet, sst) };
  }
  const CARS = { cars: [{ n: 'Лада', ok: true }, { n: 'Тесла', ok: false }, { n: 'БМВ', ok: true }] };

  it('цикл: общие строки без повторов, строки и ячейки пронумерованы подряд (до 2.1.1 — встроенные строки без r)', async function () {
    const out = await render([['H1', 'H2'], ['{d.cars[i].n}', 'x'], ['{d.cars[i+1].n}', '']], CARS);
    assert.deepStrictEqual(out.grid, [['H1', 'H2'], ['Лада', 'x'], ['Тесла', 'x'], ['БМВ', 'x']]);
    assert.strictEqual((out.sst.match(/<si>/g) || []).length, 6);
    assert.match(out.sst, /count="8" uniqueCount="6"/);
  });
  it('XLSX со вложенной книгой (xl/embeddings): рендер проходит, внешний и вложенный файлы целы', async function () {
    const inner = await xlsx([['вложенная', '{d.cars[0].n}']]);
    const out = await renderBuffer(await xlsx([['H1', 'H2'], ['{d.cars[i].n}', 'x'], ['{d.cars[i+1].n}', '']], null, { 'xl/embeddings/Microsoft_Excel_Worksheet.xlsx': inner }), 'xlsx', CARS, RU);
    const sheet = await entry(out, 'xl/worksheets/sheet1.xml');
    const sst = await entry(out, 'xl/sharedStrings.xml');
    assert.deepStrictEqual(grid(sheet, sst), [['H1', 'H2'], ['Лада', 'x'], ['Тесла', 'x'], ['БМВ', 'x']]);
    const embedded = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(out, { lazyEntries: true }, (err, z) => {
        if (err) return reject(err);
        const names = [];
        z.on('entry', (e) => { names.push(e.fileName); z.readEntry(); }).on('end', () => resolve(names));
        z.readEntry();
      });
    });
    assert.ok(embedded.includes('xl/embeddings/Microsoft_Excel_Worksheet.xlsx'), embedded.join());
    assert.strictEqual(embedded.filter((n) => n === 'xl/sharedStrings.xml').length, 1);
    assert.strictEqual(embedded.includes(''), false);
  });
  it('встроенная строка с содержимым после </is> (extLst): соседние ячейки не сливаются', async function () {
    const sheet = '<row><c t="inlineStr"><is><t>X</t></is><extLst><ext uri="u"/></extLst></c><c t="inlineStr"><is><t>Y</t></is></c></row>';
    const z = await zip({
      '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML + '<workbook xmlns="' + M + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': XML + '<worksheet xmlns="' + M + '"><sheetData>' + sheet + '</sheetData></worksheet>'
    });
    const out = await renderBuffer(z, 'xlsx', CARS, RU);
    const sst = await entry(out, 'xl/sharedStrings.xml');
    const xml = await entry(out, 'xl/worksheets/sheet1.xml');
    assert.strictEqual((sst.match(/<si>/g) || []).length, 2, sst);
    assert.match(sst, /<si><t>X<\/t><\/si><si><t>Y<\/t><\/si>/);
    assert.match(xml, /<c r="A1" t="s"><v>0<\/v><extLst><ext uri="u"\/><\/extLst><\/c><c r="B1" t="s"><v>1<\/v><\/c>/);
  });
  it('addRowCounterInWorksheet: пустые и самозакрытые ячейки, столбцы после Z, существующие r не трогаются', function () {
    const { addRowCounterInWorksheet, columnName } = require('../lib/preprocessor');
    assert.deepStrictEqual([1, 26, 27, 52, 703].map(columnName), ['A', 'Z', 'AA', 'AZ', 'AAA']);
    assert.strictEqual(addRowCounterInWorksheet('<x><cols><col min="1"/></cols><sheetData><row><c t="s"/><c><v>1</v></c></row><row/><row r="7"><c/></row></sheetData></x>'),
      '<x><cols><col min="1"/></cols><sheetData><row r="1"><c r="A1" t="s"/><c r="B1"><v>1</v></c></row><row r="2"/><row r="7"><c r="A7"/></row></sheetData></x>');
    assert.strictEqual(addRowCounterInWorksheet('<x/>'), '<x/>');
  });
});
