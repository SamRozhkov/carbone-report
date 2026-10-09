const assert = require('assert');
const yazl = require('yazl');
const yauzl = require('yauzl');
const carbone = require('../lib/index');

function docx (bodyXml) {
  return new Promise(function (resolve) {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + bodyXml + '</w:body></w:document>'), 'word/document.xml');
    const parts = [];
    zip.outputStream.on('data', function (c) { parts.push(c); }).on('end', function () { resolve(Buffer.concat(parts)); });
    zip.end();
  });
}

function documentXml (buf) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(buf, { lazyEntries: true }, function (err, z) {
      if (err) return reject(err);
      z.readEntry();
      z.on('entry', function (e) {
        if (e.fileName !== 'word/document.xml') return z.readEntry();
        z.openReadStream(e, function (err, s) {
          if (err) return reject(err);
          const parts = [];
          s.on('data', function (c) { parts.push(c); }).on('end', function () { resolve(Buffer.concat(parts).toString()); });
        });
      });
    });
  });
}

const p = function (t) { return '<w:p><w:r><w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>'; };

describe('renderBuffer', function () {
  it('собирает docx из буфера в формате шаблона', async function () {
    const out = await carbone.renderBuffer(await docx(p('Покупатель: {d.name}')), 'docx', { name: 'Иван' }, { lang: 'ru', timezone: 'Europe/Moscow' });
    assert.ok(Buffer.isBuffer(out));
    assert.strictEqual(out.slice(0, 2).toString(), 'PK');
    assert.ok((await documentXml(out)).includes('Покупатель: Иван'));
  });

  it('ошибка шаблона — отклонённый Promise с текстом Carbone', async function () {
    await assert.rejects(
      carbone.renderBuffer(await docx(p('{d.n:fooBar()}')), 'docx', { n: 1 }, {}),
      /Formatter "fooBar" does not exist/
    );
  });

  it('битый zip — отклонённый Promise, без двойного callback', async function () {
    await assert.rejects(carbone.renderBuffer(Buffer.from('PK\u0003\u0004 not a zip'), 'docx', {}, {}));
  });

  it('XML-шаблон без zip возвращает Buffer', async function () {
    const out = await carbone.renderBuffer(Buffer.from('<a>{d.x}</a>'), 'xml', { x: 'y' }, {});
    assert.strictEqual(out.toString(), '<a>y</a>');
  });

  it('дата без смещения разбирается как UTC при любом TZ процесса', async function () {
    const tpl = await docx(p('{d.d:formatD(\'DD.MM.YYYY HH:mm\')}'));
    const out = await carbone.renderBuffer(tpl, 'docx', { d: '2026-03-08 23:30:00' }, { lang: 'ru', timezone: 'Europe/Moscow' });
    assert.ok((await documentXml(out)).includes('09.03.2026 02:30'));
  });
});
