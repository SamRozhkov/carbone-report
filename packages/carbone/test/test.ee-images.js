// Изображения из данных (2.4.0, спецификация §32.1): картинка-заглушка DOCX с меткой в замещающем тексте
// заменяется изображением из data URI. Эталона EE нет: ожидания — по §32.1 и решениям R2/R3 плана 2.4.0 (R3 изменено итоговым ревью).
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const carbone = require('../lib/index');
const { renderBuffer, renderBufferWithWarnings } = carbone;
const { buildDocx, docxText, normalizeError, readEntry, entryNames } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PIC_REL = '<Relationship Id="rIdImg" Type="' + IMAGE_REL + '" Target="media/p.png"/>';

// ---------------------------------------------------------------------------------------------------------------
// картинки нужного размера

function chunk (type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Настоящий PNG w×h (RGB, чёрный); seed меняет пиксель, чтобы файлы различались */
function png (w, h, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  raw[1] = seed || 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Заголовок JPEG с размером (SOI, APP0, SOF0, EOI) — для image-size достаточно */
function jpeg (w, h) {
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
}

function gif (w, h) {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3B])]);
}

/** PNG-заголовок с «хвостом» до size байт */
function bigPng (size, seed) {
  const head = png(1, 1, seed);
  const buf = Buffer.alloc(size);
  head.copy(buf);
  buf[size - 1] = seed || 0;
  return buf;
}

const uri = (type, buf) => 'data:image/' + type + ';base64,' + buf.toString('base64');

// ---------------------------------------------------------------------------------------------------------------
// шаблон

/** Картинка Word «в тексте»: метка (или текст) в descr у wp:docPr и pic:cNvPr; рамка cx×cy EMU */
function drawing (descr, opts) {
  const o = Object.assign({ cx: 2000000, cy: 2000000, rid: 'rIdImg', title: null, id: 1 }, opts);
  return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + o.cx + '" cy="' + o.cy + '"/>'
    + '<wp:docPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"' + (o.title !== null ? ' title="' + o.title + '"' : '') + '/>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>'
    + '<pic:cNvPr id="0" name="p.png" descr="' + descr + '"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="' + o.rid + '"><a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"/></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

const para = (inner) => '<w:p><w:r>' + inner + '</w:r></w:p>';

async function template (raws, files) {
  return buildDocx(raws.map(() => '<<RAW>>').join('\n'), raws, PIC_REL, Object.assign({ 'word/media/p.png': png(1, 1) }, files));
}

async function render (raws, data, options) {
  const out = await renderBuffer(await template(raws), 'docx', data, Object.assign({}, RU, options));
  return {
    out,
    doc: await readEntry(out, 'word/document.xml'),
    rels: await readEntry(out, 'word/_rels/document.xml.rels'),
    types: await readEntry(out, '[Content_Types].xml'),
    names: await entryNames(out)
  };
}

async function renderError (raws, data, options) {
  try {
    await renderBuffer(await template(raws), 'docx', data, Object.assign({}, RU, options));
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
}

/** r:embed всех a:blip документа по порядку */
const embeds = (doc) => [...doc.matchAll(/<a:blip r:embed="([^"]*)"/g)].map((m) => m[1]);
/** Target связи Id */
function target (rels, id) {
  const m = new RegExp('<Relationship [^>]*Id="' + id + '"[^>]*>').exec(rels);
  assert.ok(m, 'нет связи ' + id + ' в ' + rels);
  assert.ok(m[0].includes('Type="' + IMAGE_REL + '"'), m[0]);
  return /Target="([^"]*)"/.exec(m[0])[1];
}
const sizes = (doc) => [...doc.matchAll(/<(wp:extent|a:ext) cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => m[1] + ' ' + m[2] + '×' + m[3]);

/** Проверка, что XML сбалансирован (открытые и закрытые теги совпадают) */
function assertWellFormed (xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(xml)) !== null) {
    assert.ok(!/[<>]/.test(xml.slice(last, m.index)), 'лишний < или > перед ' + xml.slice(m.index, m.index + 40));
    last = m.index + m[0].length;
    if (m[2] === undefined) continue;
    assert.match(m[3], /^(?:\s+[^\s=<>"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*$/, 'сломан атрибут: ' + m[0]);
    if (m[1] === '/') assert.strictEqual(stack.pop(), m[2]);
    else if (m[4] !== '/') stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, []);
}

// ---------------------------------------------------------------------------------------------------------------

describe('EE платные: изображения из данных — DOCX (§32.1)', function () {
  it('PNG data URI заменяет картинку: новый media-файл, связь, r:embed, метка убрана из descr/title', async function () {
    const img = png(2, 1);
    const r = await render([para(drawing('{d.img}', { title: '{d.img}' }))], { img: uri('png', img) });
    const ids = embeds(r.doc);
    assert.strictEqual(ids.length, 1);
    assert.notStrictEqual(ids[0], 'rIdImg');
    const t = target(r.rels, ids[0]);
    assert.match(t, /^media\/cr-img-\d+\.png$/);
    assert.ok(Buffer.from(await readEntry(r.out, 'word/' + t, true)).equals(img));
    // исходная картинка и её связь на месте
    assert.ok(r.names.includes('word/media/p.png'));
    assert.ok(r.rels.includes(PIC_REL));
    assert.ok(r.doc.includes('<wp:docPr id="1" name="Picture 1" descr="" title=""/>'), r.doc);
    assert.ok(r.doc.includes('<pic:cNvPr id="0" name="p.png" descr=""/>'));
    assert.ok(!/[-]/.test(r.doc), 'жетон остался в документе');
    assertWellFormed(r.doc);
    assertWellFormed(r.rels);
    assert.strictEqual(await docxText(r.out), '');
  });

  for (const [type, make, ext] of [['jpeg', jpeg, 'jpeg'], ['jpg', jpeg, 'jpeg'], ['gif', gif, 'gif']]) {
    it(type.toUpperCase() + ': файл .' + ext + ' и Default Extension в [Content_Types].xml', async function () {
      const img = make(200, 100);
      const r = await render([para(drawing('{d.img}'))], { img: uri(type, img) });
      const t = target(r.rels, embeds(r.doc)[0]);
      assert.match(t, new RegExp('^media/cr-img-\\d+\\.' + ext + '$'));
      assert.ok(Buffer.from(await readEntry(r.out, 'word/' + t, true)).equals(img));
      assert.ok(r.types.includes('<Default Extension="' + ext + '" ContentType="image/' + ext + '"/>'), r.types);
      // png уже был — не дублируется
      assert.strictEqual(r.types.split('Extension="png"').length, 2);
      assert.deepStrictEqual(sizes(r.doc), ['wp:extent 2000000×1000000', 'a:ext 2000000×1000000']);
    });
  }

  it('Default Extension="png" добавляется, если его не было', async function () {
    const tpl = await buildDocx('<<RAW>>', [para(drawing('{d.img}'))], PIC_REL);
    const out = await renderBuffer(tpl, 'docx', { img: uri('png', png(2, 1)) }, RU);
    const types = await readEntry(out, '[Content_Types].xml');
    assert.ok(types.includes('<Default Extension="png" ContentType="image/png"/>'), types);
    assertWellFormed(types);
  });

  describe('imageFit: рамка 2000000×2000000 EMU', function () {
    const cases = [
      ['', 200, 100, '2000000×1000000'],
      [':imageFit(fillWidth)', 200, 100, '2000000×1000000'],
      [':imageFit(contain)', 200, 100, '2000000×1000000'],
      ['', 100, 200, '2000000×4000000'],
      [':imageFit(contain)', 100, 200, '1000000×2000000'],
      [':imageFit(fill)', 100, 200, '2000000×2000000'],
      [':imageFit(\'contain\')', 100, 200, '1000000×2000000']
    ];
    for (const [fit, w, h, want] of cases) {
      it((fit || 'по умолчанию') + ', ' + w + '×' + h + ' px → ' + want, async function () {
        const r = await render([para(drawing('{d.img' + fit + '}'))], { img: uri('png', png(w, h)) });
        assert.deepStrictEqual(sizes(r.doc), ['wp:extent ' + want, 'a:ext ' + want]);
        // a:ext без cx (расширения a:extLst) не тронут
        assert.ok(r.doc.includes('<a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"/>'));
      });
    }
    it('неизвестный режим — ошибка с меткой', async function () {
      const msg = await renderError([para(drawing('{d.img:imageFit(cover)}'))], { img: uri('png', png(2, 1)) });
      assert.strictEqual(msg, 'imageFit: неизвестный режим «cover» (fillWidth, contain или fill) Source: "{d.img:imageFit(cover)}"');
    });
    it('imageFit вне замещающего текста картинки — ошибка', async function () {
      const msg = await renderError([para('<w:t>{d.img:imageFit(contain)}</w:t>')], { img: 'x' });
      assert.match(msg, /^imageFit ставится в метку изображения .* Source: "\{d\.img:imageFit\(contain\)\}"$/);
    });
  });

  for (const [name, data] of [['null', { img: null }], ['пустая строка', { img: '' }], ['нет значения', {}]]) {
    it(name + ' — w:drawing удаляется целиком', async function () {
      const r = await render([para(drawing('{d.img}')) + '<w:p><w:r><w:t>после</w:t></w:r></w:p>'], data);
      assert.ok(!r.doc.includes('<w:drawing'), r.doc);
      assert.ok(r.doc.includes('<w:p><w:r></w:r></w:p><w:p><w:r><w:t>после</w:t></w:r></w:p>'), r.doc);
      assert.ok(!r.rels.includes('cr-img'));
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
    });
  }

  describe('ошибки с меткой', function () {
    const cases = [
      ['неверный base64', 'data:image/png;base64,@@@не base64@@@', 'неверный data URI изображения (ожидается data:image/png;base64,…)'],
      ['data URI без base64', 'data:image/png,abc', 'неверный data URI изображения (ожидается data:image/png;base64,…)'],
      ['data:text/plain', 'data:text/plain;base64,aGVsbG8=', 'тип изображения «text/plain» не поддерживается (изображения: PNG, JPEG, GIF)'],
      ['SVG', 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64'), 'SVG не поддерживается (изображения: PNG, JPEG, GIF)'],
      ['SVG под видом PNG', 'data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64'), 'SVG не поддерживается (изображения: PNG, JPEG, GIF)'],
      ['не картинка внутри', 'data:image/png;base64,' + Buffer.from('hello world').toString('base64'), 'данные изображения повреждены или это не PNG, JPEG, GIF'],
      ['адрес при пустом белом списке', 'https://example.org/a.png', 'загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST)']
    ];
    for (const [name, value, message] of cases) {
      it(name, async function () {
        const msg = await renderError([para(drawing('{d.img}'))], { img: value });
        assert.strictEqual(msg, message + ' Source: "{d.img}"');
        assert.strictEqual(normalizeError(msg), message);
      });
    }
    it('11 МБ после декодирования — ошибка', async function () {
      const msg = await renderError([para(drawing('{d.img}'))], { img: uri('png', bigPng(11 * 1024 * 1024)) });
      assert.strictEqual(msg, 'изображение больше 10 МБ Source: "{d.img}"');
    });
    it('6 изображений по 9 МБ — ошибка суммарного лимита 50 МБ', async function () {
      this.timeout(60000);
      const data = {};
      const raws = [];
      for (let i = 1; i <= 6; i++) {
        data['i' + i] = uri('png', bigPng(9 * 1024 * 1024, i));
        raws.push(para(drawing('{d.i' + i + '}', { id: i })));
      }
      const msg = await renderError(raws, data);
      assert.match(msg, /^изображения отчёта больше 50 МБ Source: "\{d\.i\d\}"$/);
    });
    it('одинаковые 9 МБ шесть раз — один файл, лимит не превышен', async function () {
      this.timeout(60000);
      const img = uri('png', bigPng(9 * 1024 * 1024, 7));
      const r = await render([1, 2, 3, 4, 5, 6].map((i) => para(drawing('{d.img}', { id: i }))), { img });
      assert.strictEqual(r.names.filter((n) => n.includes('cr-img')).length, 1);
      assert.strictEqual(new Set(embeds(r.doc)).size, 1);
    });
  });

  it('Review Focus 1: цикл в строке таблицы — разные значения в разных файлах, одинаковые делят файл', async function () {
    const A = png(10, 10, 1);
    const B = png(20, 10, 2);
    const C = png(10, 20, 3);
    const items = [A, B, C, A, A];
    const cell = (inner) => '<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r>' + inner + '</w:r></w:p></w:tc>';
    const tbl = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
      + '<w:tr>' + cell('<w:t>{d.items[i].n}</w:t>') + cell(drawing('{d.items[i].img}')) + '</w:tr>'
      + '<w:tr>' + cell('<w:t>{d.items[i+1].n}</w:t>') + cell(drawing('{d.items[i+1].img}')) + '</w:tr></w:tbl>';
    const r = await render([tbl], { items: items.map((b, i) => ({ n: i + 1, img: uri('png', b) })) });
    const ids = embeds(r.doc);
    assert.strictEqual(ids.length, 5);
    assert.strictEqual(new Set(ids).size, 3);
    assert.strictEqual(r.names.filter((n) => n.includes('cr-img')).length, 3);
    for (let i = 0; i < 5; i++) {
      const data = Buffer.from(await readEntry(r.out, 'word/' + target(r.rels, ids[i]), true));
      assert.ok(data.equals(items[i]), 'строка ' + (i + 1));
    }
    // размеры по своему изображению: 10×10, 20×10, 10×20 при fillWidth в рамке 2000000
    assert.deepStrictEqual(sizes(r.doc).filter((s) => s.startsWith('wp:extent')), [
      'wp:extent 2000000×2000000', 'wp:extent 2000000×1000000', 'wp:extent 2000000×4000000', 'wp:extent 2000000×2000000', 'wp:extent 2000000×2000000'
    ]);
    assert.strictEqual(await docxText(r.out), '| 1 | |\n| 2 | |\n| 3 | |\n| 4 | |\n| 5 | |');
    assertWellFormed(r.doc);
  });

  it('Review Focus 2: " и < в соседнем статическом alt и в тексте вокруг метки не ломают XML', async function () {
    const r = await render([
      para(drawing('Логотип &quot;ООО&quot; &lt;1&gt; &amp; {d.img:imageFit(fillWidth)}', { title: 'a &quot;b&quot;' })) + para(drawing('Статика &quot;x&quot; &lt;y&gt;', { id: 2 }))
    ], { img: uri('png', png(2, 1)) });
    assertWellFormed(r.doc);
    assert.ok(r.doc.includes('descr="Логотип &quot;ООО&quot; &lt;1&gt; &amp; " title="a &quot;b&quot;"/>'), r.doc);
    assert.ok(r.doc.includes('descr="Статика &quot;x&quot; &lt;y&gt;"/>'));
    assert.deepStrictEqual(embeds(r.doc).map((id) => id === 'rIdImg'), [false, true]);
  });

  it('Review Focus 4: шаблон без меток в картинке собирается как до 2.4.0', async function () {
    // эталон снят на 7f42de6 (до изображений из данных) тем же шаблоном
    const pic = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1" descr="Логотип &quot;ООО&quot; &lt;1&gt;" title="t"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p.png" descr="Логотип"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    const tpl = await buildDocx('Имя {d.name}\n<<RAW>>\n| {d.rows[i].v} |\n| {d.rows[i+1].v} |', [pic], PIC_REL);
    const out = await renderBuffer(tpl, 'docx', { name: 'Вася <&">', rows: [{ v: 1 }, { v: 2 }] }, RU);
    const doc = await readEntry(out, 'word/document.xml');
    const rels = await readEntry(out, 'word/_rels/document.xml.rels');
    assert.strictEqual(crypto.createHash('sha256').update(doc).digest('hex'), '0cb83d851a479657539b774f13a88ad62b82fbab6b43734f66507f279bfab296');
    assert.strictEqual(crypto.createHash('sha256').update(rels).digest('hex'), '162a52856a437e64998d40544d4cfa256bfd21b1b776e4330c7ea1619c181815');
  });

  describe('замещающий текст как в 2.3.0 (итоговое ревью I1)', function () {
    it('смешанный текст «Фото {d.name}» со значением — текст печатается, картинка остаётся', async function () {
      const r = await render([para(drawing('Фото {d.name}'))], { name: 'Иван' });
      assert.ok(r.doc.includes('descr="Фото Иван"'), r.doc);
      assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
    });
    it('смешанный текст с null — картинка не удаляется', async function () {
      const r = await render([para(drawing('Фото {d.name}'))], { name: null });
      assert.ok(r.doc.includes('<w:drawing'), r.doc);
      assert.ok(r.doc.includes('descr="Фото "'), r.doc);
      assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
    });
    it('смешанный текст с data URI — тоже просто текст (метка изображения — только весь замещающий текст)', async function () {
      const value = uri('png', png(2, 1));
      const r = await render([para(drawing('Фото {d.img}'))], { img: value });
      assert.ok(r.doc.includes('descr="Фото ' + value + '"'), r.doc);
      assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
    });
    it('одна метка (пробелы вокруг не в счёт) с обычным текстом — текст в замещающем тексте, картинка остаётся, без ошибки', async function () {
      for (const [descr, value, printed] of [['{d.img}', 'просто текст', 'просто текст'], [' {d.img} ', 'Иван', ' Иван '], ['{d.img}', 42, '42'], ['{d.img}', 'ftp://127.0.0.1/a.png', 'ftp://127.0.0.1/a.png']]) {
        const r = await render([para(drawing(descr))], { img: value });
        assert.ok(r.doc.includes('descr="' + printed + '"'), r.doc);
        assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
        assert.ok(!r.names.some((n) => n.includes('cr-img')));
      }
    });
    it('одна метка со сломанным data: — ошибка шаблона', async function () {
      const msg = await renderError([para(drawing('{d.img}'))], { img: 'data:image/png;base64,@@@' });
      assert.strictEqual(msg, 'неверный data URI изображения (ожидается data:image/png;base64,…) Source: "{d.img}"');
    });
    it('одна метка в пробелах с data URI — картинка заменяется', async function () {
      const r = await render([para(drawing('  {d.img}  '))], { img: uri('png', png(2, 1)) });
      assert.deepStrictEqual(embeds(r.doc).map((id) => id === 'rIdImg'), [false]);
    });
    it('две метки в замещающем тексте — обе печатаются как текст', async function () {
      const r = await render([para(drawing('{d.a}{d.b}'))], { a: 'x', b: null });
      assert.ok(r.doc.includes('descr="x"'), r.doc);
      assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
    });
  });

  it('изображение больше 100 млн пикселей — ошибка шаблона (итоговое ревью M1)', async function () {
    const msg = await renderError([para(drawing('{d.img}'))], { img: uri('gif', gif(10001, 10000)) });
    assert.strictEqual(msg, 'изображение больше 100 млн пикселей (ширина × высота) Source: "{d.img}"');
    const r = await render([para(drawing('{d.img}'))], { img: uri('gif', gif(10000, 10000)) });
    assert.deepStrictEqual(embeds(r.doc).map((id) => id === 'rIdImg'), [false]);
  });

  it('метка {d.img} в обычном абзаце печатает строку как раньше', async function () {
    const value = 'data:image/png;base64,' + png(1, 1).toString('base64');
    const out = await renderBuffer(await buildDocx('Фото: {d.img}'), 'docx', { img: value }, RU);
    assert.strictEqual(await docxText(out), 'Фото: ' + value);
  });

  it('drop(img) в замещающем тексте по-прежнему удаляет картинку', async function () {
    const r = await render([para(drawing('{d.yes:drop(img)}'))], { yes: true });
    assert.ok(!r.doc.includes('<w:drawing'));
  });

  it('метка в замещающем тексте диаграммы (не картинки) печатается как раньше', async function () {
    const chart = '<w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="3" name="c" descr="{d.title}"/><a:graphic><a:graphicData><c:chart r:id="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing>';
    const r = await render([para(chart)], { title: 'Продажи' });
    assert.ok(r.doc.includes('descr="Продажи"'), r.doc);
  });

  it('imageFit с путём (.fit) — режим из данных; неизвестный — ошибка с меткой', async function () {
    const r = await render([para(drawing('{d.img:imageFit(.fit)}'))], { img: uri('png', png(100, 200)), fit: 'contain' });
    assert.deepStrictEqual(sizes(r.doc), ['wp:extent 1000000×2000000', 'a:ext 1000000×2000000']);
    const msg = await renderError([para(drawing('{d.img:imageFit(.fit)}'))], { img: uri('png', png(1, 1)), fit: 'cover' });
    assert.strictEqual(msg, 'imageFit: неизвестный режим «cover» (fillWidth, contain или fill) Source: "{d.img:imageFit(.fit)}"');
  });

  it('старая картинка VML (w:pict): r:id и размер в style', async function () {
    const pict = '<w:pict><v:shape id="s1" style="width:144pt;height:144pt" alt="{d.img}"><v:imagedata r:id="rIdImg" o:title=""/></v:shape></w:pict>';
    const r = await render([para(pict)], { img: uri('png', png(200, 100)) });
    const m = /<v:shape id="s1" style="width:144pt;height:72pt" alt=""><v:imagedata r:id="([^"]*)" o:title=""\/>/.exec(r.doc);
    assert.ok(m, r.doc);
    assert.match(target(r.rels, m[1]), /^media\/cr-img-\d+\.png$/);
  });

  it('картинка в колонтитуле без файла связей — файл связей создаётся', async function () {
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' + para(drawing('{d.img}')) + '</w:hdr>';
    const img = png(4, 2);
    const tpl = await buildDocx('текст', [], PIC_REL, { 'word/header1.xml': header });
    const out = await renderBuffer(tpl, 'docx', { img: uri('png', img) }, RU);
    const hdr = await readEntry(out, 'word/header1.xml');
    const rels = await readEntry(out, 'word/_rels/header1.xml.rels');
    assertWellFormed(rels);
    const t = target(rels, embeds(hdr)[0]);
    assert.ok(Buffer.from(await readEntry(out, 'word/' + t, true)).equals(img));
  });

  it('mc:AlternateContent с картинкой: меняются и Choice, и запасной VML', async function () {
    const alt = '<mc:AlternateContent><mc:Choice Requires="wpc">' + drawing('{d.img}') + '</mc:Choice><mc:Fallback><w:pict><v:shape style="width:157.5pt;height:157.5pt" alt="{d.img}"><v:imagedata r:id="rIdImg"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent>';
    const r = await render([para(alt)], { img: uri('png', png(2, 1)) });
    const ids = [...r.doc.matchAll(/(?:r:embed|r:id)="([^"]*)"/g)].map((m) => m[1]);
    assert.strictEqual(ids.length, 2);
    assert.strictEqual(ids[0], ids[1]);
    assert.notStrictEqual(ids[0], 'rIdImg');
    assert.ok(r.doc.includes('style="width:157.48pt;height:78.74pt"'), r.doc);
    const empty = await render([para(alt)], { img: null });
    assert.ok(!empty.doc.includes('mc:AlternateContent'));
  });

  it('renderBufferWithWarnings: { buffer, warnings }', async function () {
    const res = await renderBufferWithWarnings(await template([para(drawing('{d.img}'))]), 'docx', { img: uri('png', png(2, 1)) }, RU);
    assert.ok(Buffer.isBuffer(res.buffer));
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(embeds(await readEntry(res.buffer, 'word/document.xml')).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// PPTX, XLSX, OpenDocument (Task 2 плана 2.4.0): минимальные архивы собираются здесь

const yazl = require('yazl');

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

/** zip из { имя: данные } по порядку; mimetype (ODF) — без сжатия */
function zip (files) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    const parts = [];
    z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name, { compress: name !== 'mimetype' });
    z.end();
  });
}

const rels = (list) => XML_HEAD + '<Relationships xmlns="' + RELS_NS + '">' + list.map(([id, type, t]) => '<Relationship Id="' + id + '" Type="' + (type.startsWith('http') ? type : OFFICE_REL + type) + '" Target="' + t + '"/>').join('') + '</Relationships>';
const types = (overrides) => XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
  + Object.entries(overrides).map(([p, t]) => '<Override PartName="' + p + '" ContentType="' + t + '"/>').join('') + '</Types>';

/** Картинка слайда PPTX; рамка cx×cy EMU в точке x,y */
function pptxPic (descr, opts) {
  const o = Object.assign({ id: 2, cx: 2000000, cy: 2000000, x: 100, y: 200, title: null, blip: '' }, opts);
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"' + (o.title !== null ? ' title="' + o.title + '"' : '') + '/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + '<p:blipFill><a:blip r:embed="rIdImg"' + (o.blip ? '>' + o.blip + '</a:blip>' : '/>') + '<a:stretch><a:fillRect/></a:stretch></p:blipFill>'
    + '<p:spPr><a:xfrm><a:off x="' + o.x + '" y="' + o.y + '"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

const pptxText = (text, id) => '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="T' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>';

function buildPptx (shapes) {
  const P = 'application/vnd.openxmlformats-officedocument.presentationml.';
  return zip({
    '[Content_Types].xml': types({ '/ppt/presentation.xml': P + 'presentation.main+xml', '/ppt/slides/slide1.xml': P + 'slide+xml' }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': XML_HEAD + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide1.xml']]),
    'ppt/slides/slide1.xml': XML_HEAD + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + shapes.join('') + '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels([['rIdImg', 'image', '../media/p.png']]),
    'ppt/media/p.png': png(1, 1)
  });
}

/** Картинка листа XLSX в привязке anchor (oneCellAnchor | twoCellAnchor | absoluteAnchor) */
function xlsxPic (descr, opts) {
  const o = Object.assign({ id: 2, cx: 2000000, cy: 2000000, anchor: 'oneCellAnchor' }, opts);
  const from = '<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>';
  const place = {
    oneCellAnchor: from + '<xdr:ext cx="' + o.cx + '" cy="' + o.cy + '"/>',
    twoCellAnchor: from + '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>',
    absoluteAnchor: '<xdr:pos x="0" y="0"/><xdr:ext cx="' + o.cx + '" cy="' + o.cy + '"/>'
  }[o.anchor];
  return '<xdr:' + o.anchor + '>' + place
    + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
    + '<xdr:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
    + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
    + '<xdr:clientData/></xdr:' + o.anchor + '>';
}

function buildXlsx (anchors) {
  const S = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip({
    '[Content_Types].xml': types({
      '/xl/workbook.xml': S + 'sheet.main+xml', '/xl/worksheets/sheet1.xml': S + 'worksheet+xml',
      '/xl/sharedStrings.xml': S + 'sharedStrings+xml', '/xl/drawings/drawing1.xml': 'application/vnd.openxmlformats-officedocument.drawing+xml'
    }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': XML_HEAD + '<workbook ' + MAIN + '><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'sharedStrings', 'sharedStrings.xml']]),
    'xl/sharedStrings.xml': XML_HEAD + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>{d.title}</t></si></sst>',
    'xl/worksheets/sheet1.xml': XML_HEAD + '<worksheet ' + MAIN + '><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': rels([['rId1', 'drawing', '../drawings/drawing1.xml']]),
    'xl/drawings/drawing1.xml': XML_HEAD + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' + A_NS + '>' + anchors.join('') + '</xdr:wsDr>',
    'xl/drawings/_rels/drawing1.xml.rels': rels([['rIdImg', 'image', '../media/p.png']]),
    'xl/media/p.png': png(1, 1)
  });
}

const ODF_MIME = { odt: 'text', ods: 'spreadsheet', odp: 'presentation' };
const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
  + ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"'
  + ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"'
  + ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

/** Рамка ODF с картинкой; title/desc — содержимое svg:title / svg:desc (null — нет элемента) */
function odfFrame (opts) {
  const o = Object.assign({ name: 'Image1', w: '4cm', h: '4cm', title: null, desc: null, attrs: ' text:anchor-type="as-char"' }, opts);
  return '<draw:frame draw:name="' + o.name + '"' + o.attrs + ' svg:width="' + o.w + '" svg:height="' + o.h + '" draw:z-index="0">'
    + '<draw:image xlink:href="Pictures/p.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/png"/>'
    + (o.title !== null ? '<svg:title>' + o.title + '</svg:title>' : '') + (o.desc !== null ? '<svg:desc>' + o.desc + '</svg:desc>' : '')
    + '</draw:frame>';
}

/** ODT/ODS/ODP: body — содержимое office:text / office:spreadsheet / office:presentation */
function buildOdf (ext, body) {
  const kind = ODF_MIME[ext];
  const mime = 'application/vnd.oasis.opendocument.' + kind;
  return zip({
    mimetype: mime,
    'META-INF/manifest.xml': XML_HEAD + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
      + '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + mime + '"/>'
      + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
      + '<manifest:file-entry manifest:full-path="Pictures/p.png" manifest:media-type="image/png"/></manifest:manifest>',
    'content.xml': XML_HEAD + '<office:document-content ' + ODF_NS + ' office:version="1.3"><office:body><office:' + kind + '>' + body + '</office:' + kind + '></office:body></office:document-content>',
    'Pictures/p.png': png(1, 1)
  });
}

const odsBody = (shapes, cell) => '<table:table table:name="S"><table:shapes>' + shapes + '</table:shapes><table:table-column/><table:table-row><table:table-cell office:value-type="string"><text:p>' + (cell || '') + '</text:p></table:table-cell></table:table-row></table:table>';
const odpBody = (frames) => '<draw:page draw:name="p1">' + frames + '</draw:page>';

async function renderAny (tpl, ext, data, options) {
  const out = await renderBuffer(tpl, ext, data, Object.assign({}, RU, options));
  const names = await entryNames(out);
  return { out, names, read: (name, binary) => readEntry(out, name, binary) };
}

/** атрибуты всех элементов name (по порядку) */
const tags = (xml, name) => [...xml.matchAll(new RegExp('<' + name + '(?=[\\s/>])[^>]*>', 'g'))].map((m) => m[0]);
const attrOf = (tag, name) => (new RegExp('\\s' + name + '="([^"]*)"').exec(tag) || [])[1];
const relTarget = (relsXml, id) => target(relsXml, id);
const ids = (xml, name) => tags(xml, name).map((t) => attrOf(t, 'id'));

describe('EE платные: изображения из данных — PPTX (§32.1)', function () {
  it('p:pic: файл ppt/media, связь слайда ../media, r:embed, a:xfrm/a:ext по fillWidth, метка убрана из descr/title', async function () {
    const img = png(200, 100);
    const r = await renderAny(await buildPptx([pptxPic('{d.img}', { title: '{d.img}' })]), 'pptx', { img: uri('png', img) });
    const slide = await r.read('ppt/slides/slide1.xml');
    const slideRels = await r.read('ppt/slides/_rels/slide1.xml.rels');
    const blip = tags(slide, 'a:blip');
    assert.strictEqual(blip.length, 1);
    const id = attrOf(blip[0], 'r:embed');
    assert.notStrictEqual(id, 'rIdImg');
    const t = relTarget(slideRels, id);
    assert.match(t, /^\.\.\/media\/cr-img-\d+\.png$/);
    assert.ok(Buffer.from(await r.read('ppt/' + t.slice(3), true)).equals(img));
    assert.ok(tags(slide, 'p:cNvPr')[1].includes('descr="" title=""'), slide);
    assert.deepStrictEqual(tags(slide, 'a:ext'), ['<a:ext cx="2000000" cy="1000000"/>']);
    assert.ok(slide.includes('<a:off x="100" y="200"/>'));
    assert.ok(slideRels.includes('Id="rIdImg"'));
    assert.ok(!/[\uE020\uE021]/.test(slide), 'жетон остался в слайде');
    assertWellFormed(slide);
    assertWellFormed(slideRels);
  });

  it('imageFit(contain) и JPEG: Default Extension="jpeg"', async function () {
    const r = await renderAny(await buildPptx([pptxPic('{d.img:imageFit(contain)}')]), 'pptx', { img: uri('jpeg', jpeg(100, 200)) });
    const slide = await r.read('ppt/slides/slide1.xml');
    assert.deepStrictEqual(tags(slide, 'a:ext'), ['<a:ext cx="1000000" cy="2000000"/>']);
    assert.ok((await r.read('[Content_Types].xml')).includes('<Default Extension="jpeg" ContentType="image/jpeg"/>'));
    assert.ok(r.names.some((n) => /^ppt\/media\/cr-img-\d+\.jpeg$/.test(n)));
  });

  it('SVG-версия заглушки (asvg:svgBlip в a:extLst) удаляется, иначе Office показал бы её', async function () {
    const svgExt = '<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rIdSvg"/></a:ext></a:extLst>';
    const r = await renderAny(await buildPptx([pptxPic('{d.img}', { blip: svgExt })]), 'pptx', { img: uri('png', png(2, 1)) });
    const slide = await r.read('ppt/slides/slide1.xml');
    assert.ok(!slide.includes('svgBlip'), slide);
    assert.match(slide, /<a:blip r:embed="rIdCrImg1"><a:extLst><\/a:extLst><\/a:blip>/);
  });

  it('пустое значение — p:pic удаляется, связи и media не добавляются', async function () {
    const r = await renderAny(await buildPptx([pptxPic('{d.img}'), pptxText('после', 3)]), 'pptx', { img: null });
    const slide = await r.read('ppt/slides/slide1.xml');
    assert.ok(!slide.includes('<p:pic>'), slide);
    assert.ok(slide.includes('<a:t>после</a:t>'));
    assert.ok(!(await r.read('ppt/slides/_rels/slide1.xml.rels')).includes('cr-img'));
    assert.ok(!r.names.some((n) => n.includes('cr-img')));
  });

  it('цикл с абсолютно позиционированной картинкой (§32.1: не поддерживается) — без падения, позиции не меняются, id уникальны', async function () {
    const items = [png(10, 10, 1), png(20, 10, 2), png(10, 20, 3)];
    const tpl = await buildPptx([pptxPic('{d.items[i].img}', { id: 2 }), pptxPic('{d.items[i+1].img}', { id: 3 })]);
    const r = await renderAny(tpl, 'pptx', { items: items.map((b) => ({ img: uri('png', b) })) });
    const slide = await r.read('ppt/slides/slide1.xml');
    const embeds = tags(slide, 'a:blip').map((t) => attrOf(t, 'r:embed'));
    assert.strictEqual(embeds.length, 3);
    assert.strictEqual(new Set(embeds).size, 3);
    assert.deepStrictEqual(tags(slide, 'a:off'), Array(3).fill('<a:off x="100" y="200"/>'));
    const all = ids(slide, 'p:cNvPr');
    assert.strictEqual(new Set(all).size, all.length, all.join(','));
    assertWellFormed(slide);
  });
});

describe('EE платные: изображения из данных — XLSX (§32.1)', function () {
  it('oneCellAnchor: xl/media, связь рисунка ../media, xdr:ext и a:ext по fillWidth', async function () {
    const img = png(200, 100);
    const r = await renderAny(await buildXlsx([xlsxPic('{d.img}')]), 'xlsx', { img: uri('png', img), title: 'Отчёт' });
    const drawingXml = await r.read('xl/drawings/drawing1.xml');
    const drawingRels = await r.read('xl/drawings/_rels/drawing1.xml.rels');
    const id = attrOf(tags(drawingXml, 'a:blip')[0], 'r:embed');
    const t = relTarget(drawingRels, id);
    assert.match(t, /^\.\.\/media\/cr-img-\d+\.png$/);
    assert.ok(Buffer.from(await r.read('xl/' + t.slice(3), true)).equals(img));
    assert.deepStrictEqual(tags(drawingXml, 'xdr:ext'), ['<xdr:ext cx="2000000" cy="1000000"/>']);
    assert.deepStrictEqual(tags(drawingXml, 'a:ext'), ['<a:ext cx="2000000" cy="1000000"/>']);
    assert.ok(tags(drawingXml, 'xdr:cNvPr')[0].includes('descr=""'));
    assert.ok(!/[\uE020\uE021]/.test(drawingXml), 'жетон остался в рисунке');
    assertWellFormed(drawingXml);
  });

  it('absoluteAnchor: размер по imageFit(contain)', async function () {
    const r = await renderAny(await buildXlsx([xlsxPic('{d.img:imageFit(contain)}', { anchor: 'absoluteAnchor' })]), 'xlsx', { img: uri('png', png(100, 200)) });
    const drawingXml = await r.read('xl/drawings/drawing1.xml');
    assert.deepStrictEqual(tags(drawingXml, 'xdr:ext'), ['<xdr:ext cx="1000000" cy="2000000"/>']);
  });

  it('twoCellAnchor: размер задают ячейки from/to — не меняется, меняется только картинка', async function () {
    const r = await renderAny(await buildXlsx([xlsxPic('{d.img}', { anchor: 'twoCellAnchor' })]), 'xlsx', { img: uri('png', png(200, 100)) });
    const drawingXml = await r.read('xl/drawings/drawing1.xml');
    assert.deepStrictEqual(tags(drawingXml, 'a:ext'), ['<a:ext cx="2000000" cy="2000000"/>']);
    assert.ok(drawingXml.includes('<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'));
    assert.notStrictEqual(attrOf(tags(drawingXml, 'a:blip')[0], 'r:embed'), 'rIdImg');
  });

  it('media и связи переживают finishXlsx (общие строки собираются заново)', async function () {
    const r = await renderAny(await buildXlsx([xlsxPic('{d.img}')]), 'xlsx', { img: uri('png', png(2, 1)), title: 'Отчёт' });
    const sheet = await r.read('xl/worksheets/sheet1.xml');
    assert.match(sheet, /<c r="A1"\s+t="s"><v>0<\/v><\/c>/);
    assert.ok((await r.read('xl/sharedStrings.xml')).includes('<si><t>Отчёт</t></si>'));
    const ct = await r.read('[Content_Types].xml');
    assert.ok(ct.includes('PartName="/xl/sharedStrings.xml"'));
    assertWellFormed(ct);
    const id = attrOf(tags(await r.read('xl/drawings/drawing1.xml'), 'a:blip')[0], 'r:embed');
    const t = relTarget(await r.read('xl/drawings/_rels/drawing1.xml.rels'), id);
    assert.ok(r.names.includes('xl/' + t.slice(3)));
  });

  it('пустое значение — привязка с картинкой удаляется целиком', async function () {
    const r = await renderAny(await buildXlsx([xlsxPic('{d.img}'), xlsxPic('статика', { id: 3, anchor: 'twoCellAnchor' })]), 'xlsx', { img: '' });
    const drawingXml = await r.read('xl/drawings/drawing1.xml');
    assert.ok(!drawingXml.includes('oneCellAnchor'), drawingXml);
    assert.strictEqual(tags(drawingXml, 'xdr:pic').length, 1);
    assert.ok(!r.names.some((n) => n.includes('cr-img')));
  });

  it('цикл с картинкой (§32.1: не поддерживается) — без падения, id уникальны', async function () {
    const items = [png(10, 10, 1), png(20, 10, 2), png(10, 20, 3)];
    const tpl = await buildXlsx([xlsxPic('{d.items[i].img}', { id: 2 }), xlsxPic('{d.items[i+1].img}', { id: 3 })]);
    const r = await renderAny(tpl, 'xlsx', { items: items.map((b) => ({ img: uri('png', b) })) });
    const drawingXml = await r.read('xl/drawings/drawing1.xml');
    assert.strictEqual(tags(drawingXml, 'a:blip').length, 3);
    const all = ids(drawingXml, 'xdr:cNvPr');
    assert.strictEqual(all.length, 3);
    assert.strictEqual(new Set(all).size, 3, all.join(','));
    assertWellFormed(drawingXml);
  });
});

describe('EE платные: изображения из данных — ODT, ODS, ODP (§32.1)', function () {
  it('ODT: метка в svg:desc — Pictures/cr-img-1.png, xlink:href, manifest, svg:width/height в см', async function () {
    const img = png(200, 100);
    const body = '<text:p>' + odfFrame({ title: 'Логотип', desc: '{d.img}' }) + '</text:p>';
    const r = await renderAny(await buildOdf('odt', body), 'odt', { img: uri('png', img) });
    const content = await r.read('content.xml');
    const image = tags(content, 'draw:image')[0];
    assert.strictEqual(attrOf(image, 'xlink:href'), 'Pictures/cr-img-1.png');
    assert.strictEqual(attrOf(image, 'draw:mime-type'), 'image/png');
    assert.ok(Buffer.from(await r.read('Pictures/cr-img-1.png', true)).equals(img));
    const frame = tags(content, 'draw:frame')[0];
    assert.strictEqual(attrOf(frame, 'svg:width'), '4cm');
    assert.strictEqual(attrOf(frame, 'svg:height'), '2cm');
    assert.ok(content.includes('<svg:title>Логотип</svg:title><svg:desc></svg:desc>'), content);
    const manifest = await r.read('META-INF/manifest.xml');
    assert.ok(manifest.includes('<manifest:file-entry manifest:full-path="Pictures/cr-img-1.png" manifest:media-type="image/png"/>'), manifest);
    assertWellFormed(manifest);
    assertWellFormed(content);
    assert.ok(!/[\uE020\uE021]/.test(content), 'жетон остался в content.xml');
    assert.strictEqual(r.names[0], 'mimetype');
  });

  it('ODT: JPEG — расширение, draw:mime-type и media-type в manifest', async function () {
    const r = await renderAny(await buildOdf('odt', '<text:p>' + odfFrame({ title: '{d.img}' }) + '</text:p>'), 'odt', { img: uri('jpeg', jpeg(200, 100)) });
    const content = await r.read('content.xml');
    assert.strictEqual(attrOf(tags(content, 'draw:image')[0], 'xlink:href'), 'Pictures/cr-img-1.jpeg');
    assert.strictEqual(attrOf(tags(content, 'draw:image')[0], 'draw:mime-type'), 'image/jpeg');
    assert.ok((await r.read('META-INF/manifest.xml')).includes('manifest:full-path="Pictures/cr-img-1.jpeg" manifest:media-type="image/jpeg"'));
  });

  const units = [
    ['ods', 'mm', '40mm', '40mm', ':imageFit(fill)', 100, 200, '40mm', '40mm'],
    ['odp', 'in', '2in', '2in', ':imageFit(contain)', 100, 200, '1in', '2in'],
    ['odt', 'pt', '144pt', '144pt', '', 200, 100, '144pt', '72pt'],
    ['odp', 'cm (дробные)', '5.08cm', '3cm', '', 300, 100, '5.08cm', '1.6933cm']
  ];
  for (const [ext, unit, w, h, fit, iw, ih, ww, wh] of units) {
    it(ext.toUpperCase() + ': размер в единицах рамки (' + unit + ')' + (fit ? ', ' + fit : ''), async function () {
      const frame = odfFrame({ w, h, title: '{d.img' + fit + '}', attrs: ext === 'odt' ? ' text:anchor-type="as-char"' : ' svg:x="1cm" svg:y="1cm"' });
      const body = ext === 'ods' ? odsBody(frame) : ext === 'odp' ? odpBody(frame) : '<text:p>' + frame + '</text:p>';
      const r = await renderAny(await buildOdf(ext, body), ext, { img: uri('png', png(iw, ih)) });
      const content = await r.read('content.xml');
      const f = tags(content, 'draw:frame')[0];
      assert.deepStrictEqual([attrOf(f, 'svg:width'), attrOf(f, 'svg:height')], [ww, wh]);
      assert.strictEqual(attrOf(tags(content, 'draw:image')[0], 'xlink:href'), 'Pictures/cr-img-1.png');
      assert.ok(r.names.includes('Pictures/cr-img-1.png'));
    });
  }

  for (const ext of ['odt', 'ods', 'odp']) {
    it(ext.toUpperCase() + ': пустое значение — draw:frame удаляется, manifest не меняется', async function () {
      const frame = odfFrame({ title: '{d.img}' });
      const body = ext === 'ods' ? odsBody(frame, 'ячейка') : ext === 'odp' ? odpBody(frame) : '<text:p>до' + frame + 'после</text:p>';
      const r = await renderAny(await buildOdf(ext, body), ext, { img: null });
      const content = await r.read('content.xml');
      assert.ok(!content.includes('draw:frame'), content);
      assert.ok(!(await r.read('META-INF/manifest.xml')).includes('cr-img'));
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
      if (ext === 'odt') assert.ok(content.includes('<text:p>допосле</text:p>'));
    });
  }

  it(':color(shape, background) в svg:title рамки с картинкой — не метка изображения (итоговое ревью M4)', async function () {
    const frame = odfFrame({ title: '{d.c:color(shape, background)}', attrs: ' draw:style-name="gr1" text:anchor-type="as-char"' });
    const r = await renderAny(await buildOdf('odt', '<text:p>' + frame + '</text:p>'), 'odt', { c: '#FF0000' });
    const content = await r.read('content.xml');
    assertWellFormed(content);
    assert.strictEqual(attrOf(tags(content, 'draw:image')[0], 'xlink:href'), 'Pictures/p.png');
    assert.ok(content.includes('draw:fill-color="#ff0000"'), content);
    assert.ok(!r.names.some((n) => n.includes('cr-img')));
  });

  it('метка в svg:title обычной рамки-надписи (не картинки) печатается как раньше', async function () {
    const box = '<draw:frame draw:name="b" svg:width="4cm" svg:height="1cm"><draw:text-box><text:p>x</text:p></draw:text-box><svg:title>{d.t}</svg:title></draw:frame>';
    const r = await renderAny(await buildOdf('odt', '<text:p>' + box + '</text:p>'), 'odt', { t: 'Название' });
    assert.ok((await r.read('content.xml')).includes('<svg:title>Название</svg:title>'));
  });

  it('ODT: 3 изображения в цикле абзацев (привязка «как символ») — 3 файла, 3 ссылки', async function () {
    const items = [png(10, 10, 1), png(20, 10, 2), png(10, 20, 3)];
    const body = '<text:p>{d.items[i].n} ' + odfFrame({ title: '{d.items[i].img}' }) + '</text:p><text:p>{d.items[i+1].n}</text:p>';
    const r = await renderAny(await buildOdf('odt', body), 'odt', { items: items.map((b, i) => ({ n: i + 1, img: uri('png', b) })) });
    const content = await r.read('content.xml');
    const hrefs = tags(content, 'draw:image').map((t) => attrOf(t, 'xlink:href'));
    assert.strictEqual(hrefs.length, 3);
    assert.strictEqual(new Set(hrefs).size, 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(Buffer.from(await r.read(hrefs[i], true)).equals(items[i]), 'абзац ' + (i + 1));
    }
    assert.deepStrictEqual(tags(content, 'draw:frame').map((t) => attrOf(t, 'svg:height')), ['4cm', '2cm', '8cm']);
    const manifest = await r.read('META-INF/manifest.xml');
    assert.strictEqual(manifest.split('cr-img-').length - 1, 3);
    assertWellFormed(content);
  });

  it('ODP: цикл с абсолютно позиционированной картинкой (§32.1: не поддерживается) — без падения, позиции не меняются', async function () {
    const items = [png(10, 10, 1), png(20, 10, 2), png(10, 20, 3)];
    const frames = odfFrame({ title: '{d.items[i].img}', attrs: ' svg:x="1cm" svg:y="2cm"' }) + odfFrame({ name: 'Image2', title: '{d.items[i+1].img}', attrs: ' svg:x="1cm" svg:y="2cm"' });
    const r = await renderAny(await buildOdf('odp', odpBody(frames)), 'odp', { items: items.map((b) => ({ img: uri('png', b) })) });
    const content = await r.read('content.xml');
    const frameTags = tags(content, 'draw:frame');
    assert.strictEqual(frameTags.length, 3);
    assert.deepStrictEqual(frameTags.map((t) => attrOf(t, 'svg:x') + ' ' + attrOf(t, 'svg:y')), Array(3).fill('1cm 2cm'));
    assert.strictEqual(new Set(tags(content, 'draw:image').map((t) => attrOf(t, 'xlink:href'))).size, 3);
    assertWellFormed(content);
  });
});

describe('EE платные: изображения из данных — циклы и служебное (Task 2)', function () {
  it('xmltree.setAttr/putAttr: $&, $` и $\' в значении не раскрываются (итоговое ревью M3)', function () {
    const xmltree = require('../lib/xmltree');
    assert.strictEqual(xmltree.setAttr('<a b="1" c="2">', 'b', 'x$&y$`z$\'$1'), '<a b="x$&y$`z$\'$1" c="2">');
    assert.strictEqual(xmltree.putAttr('<a c="2"/>', 'b', '$&$1'), '<a c="2" b="$&$1"/>');
    assert.strictEqual(xmltree.putAttr('<a b="1">', 'b', '$&'), '<a b="$&">');
  });
  it('DOCX: 3 изображения в цикле абзацев — 3 файла, 3 связи, wp:docPr id уникальны', async function () {
    const items = [png(10, 10, 1), png(20, 10, 2), png(10, 20, 3)];
    const r = await render([para(drawing('{d.items[i].img}', { id: 7 })) + para(drawing('{d.items[i+1].img}', { id: 8 }))], { items: items.map((b) => ({ img: uri('png', b) })) });
    const list = embeds(r.doc);
    assert.strictEqual(list.length, 3);
    assert.strictEqual(new Set(list).size, 3);
    assert.strictEqual(r.names.filter((n) => n.includes('cr-img')).length, 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(Buffer.from(await readEntry(r.out, 'word/' + target(r.rels, list[i]), true)).equals(items[i]));
    }
    assert.deepStrictEqual(ids(r.doc, 'wp:docPr'), ['7', '8', '9']);
  });

  it('DOCX: цикл в строке таблицы (Review Focus 1) — повторённые wp:docPr получают новые id выше максимума', async function () {
    const cell = (inner) => '<w:tc><w:p><w:r>' + inner + '</w:r></w:p></w:tc>';
    const tbl = '<w:tbl><w:tr>' + cell(drawing('{d.items[i].img}', { id: 4 })) + '</w:tr><w:tr>' + cell(drawing('{d.items[i+1].img}', { id: 4 })) + '</w:tr></w:tbl>';
    const r = await render([para(drawing('статика', { id: 9 })) + tbl], { items: [1, 2, 3, 4].map((i) => ({ img: uri('png', png(i, 1)) })) });
    assert.deepStrictEqual(ids(r.doc, 'wp:docPr'), ['9', '4', '10', '11', '12']);
  });

  it('Id связей в одинарных кавычках учитываются: новый Id не совпадает с существующим', async function () {
    const extra = '<Relationship Id=\'rIdCrImg1\' Type=\'' + IMAGE_REL + '\' Target=\'media/p.png\'/>';
    const tpl = await buildDocx('<<RAW>>', [para(drawing('{d.img}'))], PIC_REL + extra, { 'word/media/p.png': png(1, 1) });
    const out = await renderBuffer(tpl, 'docx', { img: uri('png', png(2, 1)) }, RU);
    const id = embeds(await readEntry(out, 'word/document.xml'))[0];
    assert.notStrictEqual(id, 'rIdCrImg1');
    assert.match(target(await readEntry(out, 'word/_rels/document.xml.rels'), id), /^media\/cr-img-1\.png$/);
  });

  it('DOCX с вложенной книгой (word/embeddings/*.xlsx): новые файлы верхнего уровня не ломают сборку архива', async function () {
    const inner = await zip({ '[Content_Types].xml': types({}), 'xl/workbook.xml': XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' });
    const tpl = await buildDocx('<<RAW>>', [para(drawing('{d.img}'))], PIC_REL, { 'word/media/p.png': png(1, 1), 'word/embeddings/book.xlsx': inner });
    const img = png(2, 1);
    const out = await renderBuffer(tpl, 'docx', { img: uri('png', img) }, RU);
    const names = await entryNames(out);
    assert.ok(names.includes('word/embeddings/book.xlsx'), names.join(','));
    assert.ok(names.includes('word/media/cr-img-1.png'), names.join(','));
    assert.ok(Buffer.from(await readEntry(out, 'word/media/cr-img-1.png', true)).equals(img));
    const book = await readEntry(out, 'word/embeddings/book.xlsx', true);
    assert.ok((await entryNames(book)).includes('xl/workbook.xml'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Загрузка по адресу (§32.2, Task 3 плана 2.4.0): локальный http-сервер на 127.0.0.1

const http = require('http');

describe('EE платные: изображения по адресу из белого списка (§32.2)', function () {
  let server;
  let host;
  let base;
  const hits = {};
  let active = 0;
  let maxActive = 0;
  const hung = [];
  let stallClosed = 0;

  const IMG = png(3, 1, 9);

  before(async function () {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      hits[url.pathname] = (hits[url.pathname] || 0) + 1;
      const p = url.pathname;
      if (p === '/ok.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(IMG);
      }
      if (p === '/redirect') {
        res.writeHead(302, { Location: '/ok.png' });
        return res.end();
      }
      if (p === '/missing') {
        res.writeHead(404);
        return res.end('нет');
      }
      if (p === '/hang') {
        hung.push(res);
        return; // не отвечает
      }
      if (p === '/endless') {
        // тело без длины и без конца: загрузка должна оборвать чтение после 10 МБ
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(png(1, 1));
        const block = Buffer.alloc(256 * 1024);
        const pump = () => {
          while (!res.destroyed && res.write(block)) {
            // пишем, пока буфер не полон
          }
          if (!res.destroyed) res.once('drain', pump);
        };
        return pump();
      }
      if (p === '/declared') {
        // заявленная длина 11 МБ — отказ по заголовку
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(11 * 1024 * 1024) });
        return res.write(png(1, 1));
      }
      if (p.startsWith('/slowlong/')) {
        return setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(png(1, 1));
        }, 3000);
      }
      if (p.startsWith('/stall/')) {
        // заголовки есть, тело не приходит; закрытие соединения клиентом считается
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.write(png(1, 1).subarray(0, 8));
        hung.push(res);
        req.socket.once('close', () => stallClosed++);
        return;
      }
      if (p.startsWith('/big/')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(bigPng(9 * 1024 * 1024, Number(p.slice(5))));
      }
      if (p === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('hello');
      }
      if (p.startsWith('/slow/')) {
        active++;
        maxActive = Math.max(maxActive, active);
        return setTimeout(() => {
          active--;
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(png(Number(p.slice(6)), 1));
        }, 50);
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = '127.0.0.1:' + server.address().port;
    base = 'http://' + host;
  });

  after(function () {
    hung.forEach((res) => res.destroy());
    server.closeAllConnections();
    server.close();
  });

  const allow = () => ({ imageUrlAllowlist: [host] });

  async function renderWarn (raws, data, options) {
    const res = await renderBufferWithWarnings(await template(raws), 'docx', data, Object.assign({}, RU, options));
    return { warnings: res.warnings, doc: await readEntry(res.buffer, 'word/document.xml'), names: await entryNames(res.buffer), out: res.buffer };
  }

  it('200 PNG из белого списка — картинка заменена', async function () {
    const r = await renderWarn([para(drawing('{d.img}'))], { img: base + '/ok.png?token=секрет' }, allow());
    assert.deepStrictEqual(r.warnings, []);
    const ids = embeds(r.doc);
    assert.strictEqual(ids.length, 1);
    const rels = await readEntry(r.out, 'word/_rels/document.xml.rels');
    assert.ok(Buffer.from(await readEntry(r.out, 'word/' + target(rels, ids[0]), true)).equals(IMG));
    assert.deepStrictEqual(sizes(r.doc), ['wp:extent 2000000×666667', 'a:ext 2000000×666667']);
  });

  it('пустой белый список — ошибка «загрузка изображений по адресу выключена»', async function () {
    const msg = await renderError([para(drawing('{d.img}'))], { img: base + '/ok.png' }, { imageUrlAllowlist: [] });
    assert.strictEqual(msg, 'загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST) Source: "{d.img}"');
  });

  it('хост вне белого списка — ошибка шаблона, запроса нет', async function () {
    const before = hits['/ok.png'] || 0;
    const msg = await renderError([para(drawing('{d.img}'))], { img: base + '/ok.png' }, { imageUrlAllowlist: ['example.org', '127.0.0.2:' + server.address().port] });
    assert.strictEqual(msg, 'хост «' + host + '» не входит в белый список IMAGE_URL_ALLOWLIST Source: "{d.img}"');
    assert.strictEqual(hits['/ok.png'] || 0, before);
  });

  it('127.0.0.1 в списке без порта не разрешает 127.0.0.1:<порт>', async function () {
    const msg = await renderError([para(drawing('{d.img}'))], { img: base + '/ok.png' }, { imageUrlAllowlist: ['127.0.0.1'] });
    assert.strictEqual(msg, 'хост «' + host + '» не входит в белый список IMAGE_URL_ALLOWLIST Source: "{d.img}"');
  });

  it('регистр имени хоста и пробелы в списке не мешают', async function () {
    const r = await renderWarn([para(drawing('{d.img}'))], { img: 'HTTP://127.0.0.1:' + server.address().port + '/ok.png' }, { imageUrlAllowlist: [' ' + host + ' '] });
    assert.deepStrictEqual(r.warnings, []);
    assert.strictEqual(embeds(r.doc).length, 1);
  });

  it('сравнение хоста: точное имя, порт — только если указан; порт по умолчанию равен хосту без порта', function () {
    const { hostAllowed } = require('../lib/media');
    assert.strictEqual(hostAllowed(new URL('https://Example.org/a.png'), ['example.org']), true);
    assert.strictEqual(hostAllowed(new URL('https://example.org:443/a.png'), ['example.org']), true);
    assert.strictEqual(hostAllowed(new URL('https://example.org/a.png'), ['example.org:443']), true);
    assert.strictEqual(hostAllowed(new URL('http://example.org/a.png'), ['example.org:443']), false);
    assert.strictEqual(hostAllowed(new URL('https://example.org:8443/a.png'), ['example.org']), false);
    assert.strictEqual(hostAllowed(new URL('https://cdn.example.org/a.png'), ['example.org']), false);
    assert.strictEqual(hostAllowed(new URL('https://example.org.evil.com/a.png'), ['example.org']), false);
    assert.strictEqual(hostAllowed(new URL('http://[::1]:8080/a.png'), ['[::1]:8080']), true);
  });

  const failures = [
    ['302 (перенаправления не выполняются)', '/redirect?sig=abc', 'код ответа 302'],
    ['404', '/missing?sig=abc', 'код ответа 404'],
    ['тайм-аут', '/hang?sig=abc', 'тайм-аут 200 мс'],
    ['тело больше 10 МБ (чтение обрывается)', '/endless?sig=abc', 'изображение больше 10 МБ'],
    ['заявленная длина больше 10 МБ', '/declared?sig=abc', 'изображение больше 10 МБ']
  ];
  for (const [name, path, reason] of failures) {
    it(name + ' — заглушка удалена, предупреждение с адресом без query-строки', async function () {
      this.timeout(10000);
      const okBefore = hits['/ok.png'] || 0;
      const started = Date.now();
      const r = await renderWarn([para('<w:t>до</w:t>') + para(drawing('{d.img}'))], { img: base + path + '#frag' }, Object.assign(allow(), { imageUrlTimeoutMs: 200 }));
      assert.ok(Date.now() - started < 5000);
      assert.ok(!r.doc.includes('<w:drawing>'), r.doc);
      assert.ok(r.doc.includes('до'));
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
      const url = base + path.replace(/\?.*$/, '');
      assert.deepStrictEqual(r.warnings, ['изображение не загружено: ' + url + ' — ' + reason + ' Метка: {d.img}']);
      assert.ok(!r.warnings[0].includes('sig') && !r.warnings[0].includes('frag'));
      assert.strictEqual(hits['/ok.png'] || 0, okBefore, 'перенаправление не выполняется');
    });
  }

  it('сетевая ошибка (порт закрыт) — заглушка удалена, предупреждение', async function () {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const r = await renderWarn([para(drawing('{d.img}'))], { img: 'http://127.0.0.1:' + port + '/a.png?x=1' }, { imageUrlAllowlist: ['127.0.0.1:' + port] });
    assert.ok(!r.doc.includes('<w:drawing>'));
    assert.strictEqual(r.warnings.length, 1);
    assert.match(r.warnings[0], new RegExp('^изображение не загружено: http://127\\.0\\.0\\.1:' + port + '/a\\.png — ошибка сети'));
    assert.ok(!r.warnings[0].includes('x=1'));
  });

  it('адрес с именем пользователя и паролем — ошибка шаблона без учётных данных в тексте', async function () {
    const msg = await renderError([para(drawing('{d.img}'))], { img: 'http://user:secret@' + host + '/ok.png' }, allow());
    assert.strictEqual(msg, 'адрес изображения с именем пользователя или паролем не поддерживается Source: "{d.img}"');
  });

  it('10 изображений в цикле — не больше 4 запросов одновременно; одинаковые адреса загружаются один раз', async function () {
    active = 0;
    maxActive = 0;
    const items = [];
    for (let i = 1; i <= 10; i++) items.push({ img: base + '/slow/' + i });
    items.push({ img: base + '/slow/1' }, { img: base + '/slow/2' });
    const before = hits['/slow/1'] || 0;
    const r = await renderWarn([para(drawing('{d.items[i].img}', { id: 7 })) + para(drawing('{d.items[i+1].img}', { id: 8 }))], { items }, allow());
    assert.deepStrictEqual(r.warnings, []);
    assert.strictEqual(embeds(r.doc).length, 12);
    assert.strictEqual(r.names.filter((n) => n.includes('cr-img')).length, 10);
    assert.ok(maxActive <= 4, 'одновременно: ' + maxActive);
    assert.ok(maxActive >= 2, 'загрузки идут параллельно: ' + maxActive);
    assert.strictEqual((hits['/slow/1'] || 0) - before, 1);
  });

  for (const value of ['ftp://' + '127.0.0.1/a.png', 'file:///etc/hosts']) {
    it(value.split(':')[0] + ':// — не загружается: печатается как замещающий текст, картинка остаётся', async function () {
      const r = await render([para(drawing('{d.img}'))], { img: value }, { imageUrlAllowlist: ['127.0.0.1'] });
      assert.ok(r.doc.includes('descr="' + value + '"'), r.doc);
      assert.deepStrictEqual(embeds(r.doc), ['rIdImg']);
    });
  }

  it('скачанные данные — не картинка: ошибка шаблона, как у data URI', async function () {
    const msg = await renderError([para(drawing('{d.img}'))], { img: base + '/text?sig=abc#frag' }, allow());
    assert.strictEqual(msg, 'данные изображения повреждены или это не PNG, JPEG, GIF (адрес ' + base + '/text) Source: "{d.img}"');
  });

  describe('ошибка прерывает загрузку (ревью Task 3)', function () {
    const loop = [para(drawing('{d.items[i].img}', { id: 7 })) + para(drawing('{d.items[i+1].img}', { id: 8 }))];

    it('хост вне списка у поздней картинки — ошибка сразу, ранние медленные адреса не запрашиваются', async function () {
      const items = [1, 2, 3, 4, 5, 6].map((i) => ({ img: base + '/slowlong/' + i }));
      items.push({ img: 'http://evil.example.org/a.png' });
      const started = Date.now();
      const msg = await renderError(loop, { items }, allow());
      assert.strictEqual(msg, 'хост «evil.example.org» не входит в белый список IMAGE_URL_ALLOWLIST Source: "{d.items[i].img}"');
      assert.ok(Date.now() - started < 1000, 'ошибка без ожидания загрузок: ' + (Date.now() - started) + ' мс');
      assert.strictEqual(Object.keys(hits).filter((k) => k.startsWith('/slowlong/')).length, 0);
    });

    it('не картинка в ответе — ошибка шаблона сразу, зависшие загрузки обрываются', async function () {
      const before = stallClosed;
      const items = [{ img: base + '/text?q=1' }, { img: base + '/stall/1' }, { img: base + '/stall/2' }, { img: base + '/stall/3' }];
      const started = Date.now();
      const msg = await renderError(loop, { items }, Object.assign(allow(), { imageUrlTimeoutMs: 5000 }));
      assert.strictEqual(msg, 'данные изображения повреждены или это не PNG, JPEG, GIF (адрес ' + base + '/text) Source: "{d.items[i].img}"');
      assert.ok(Date.now() - started < 2000, 'без ожидания тайм-аута: ' + (Date.now() - started) + ' мс');
      const deadline = Date.now() + 2000;
      while (stallClosed - before < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.strictEqual(stallClosed - before, 3, 'загрузки прерваны (AbortController)');
    });

    it('суммарный лимит 50 МБ считается по мере загрузки: ошибка до чтения всех ответов', async function () {
      this.timeout(30000);
      const items = [];
      for (let i = 1; i <= 14; i++) items.push({ img: base + '/big/' + i });
      const msg = await renderError(loop, { items }, allow());
      assert.match(msg, /^изображения отчёта больше 50 МБ Source: "\{d\.items\[i\]\.img\}"$/);
      const requested = Object.keys(hits).filter((k) => k.startsWith('/big/')).length;
      // 6 × 9 МБ > 50 МБ: после шестого ответа новые загрузки не начинаются (в полёте — не больше 3)
      assert.ok(requested <= 9, 'запрошено ' + requested + ' из 14');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Штрихкоды (Task 4 плана 2.4.0, спецификация §32.3): PNG из bwip-js вместо картинки-заглушки

describe('EE платные: штрихкоды (§32.3)', function () {
  const bwipjs = require('bwip-js');
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  /** размер PNG по заголовку IHDR */
  const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
  /** PNG, вставленный вместо первой картинки документа */
  async function insertedPng (r) {
    const ids = embeds(r.doc);
    assert.strictEqual(ids.length, 1, r.doc);
    const name = 'word/' + target(r.rels, ids[0]);
    assert.match(name, /^word\/media\/cr-img-\d+\.png$/);
    return Buffer.from(await readEntry(r.out, name, true));
  }
  /** то же, что вернёт bwip-js напрямую (масштаб по умолчанию — 3) */
  const direct = (opts) => bwipjs.toBuffer(Object.assign({ scale: 3 }, opts));
  const one = (marker, data, options) => render([para(drawing(marker))], data, options);
  const oneError = (marker, data, options) => renderError([para(drawing(marker))], data, options);

  it('qrcode в descr — PNG от bwip-js (масштаб 3 по умолчанию), метка убрана', async function () {
    const r = await one('{d.code:barcode(qrcode)}', { code: 'https://example.org/?a=1' });
    const buf = await insertedPng(r);
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE));
    const size = pngSize(buf);
    assert.ok(size.width > 0 && size.height > 0);
    assert.ok(buf.equals(await direct({ bcid: 'qrcode', text: 'https://example.org/?a=1' })));
    assert.ok(!r.doc.includes('barcode'), r.doc);
    assert.ok(!r.doc.includes('descr="{'), r.doc);
    assertWellFormed(r.doc);
  });

  it('ean13 с includetext:true; число в данных — как строка', async function () {
    const r = await one('{d.code:barcode(ean13, includetext:true)}', { code: 5901234123457 });
    const buf = await insertedPng(r);
    assert.ok(buf.equals(await direct({ bcid: 'ean13', text: '5901234123457', includetext: true })));
    assert.ok(!buf.equals(await direct({ bcid: 'ean13', text: '5901234123457' })));
  });

  it('width:40, height:20 (мм) — размер изображения: высота 20 мм, ширина не больше 40 мм (72 dpi × масштаб 3)', async function () {
    const r = await one('{d.code:barcode(code128, width:40, height:20)}', { code: 'ABC123' });
    const buf = await insertedPng(r);
    assert.ok(buf.equals(await direct({ bcid: 'code128', text: 'ABC123', width: 40, height: 20 })));
    const px = (mm) => mm / 25.4 * 72 * 3;
    const size = pngSize(buf);
    assert.ok(Math.abs(size.height - px(20)) <= 3, 'высота ' + size.height);
    assert.ok(size.width <= px(40) + 3 && size.width >= px(30), 'ширина ' + size.width);
  });

  it('scale 1 и 10 — размер в 10 раз больше; 0, 11 и 2.5 — ошибка шаблона', async function () {
    const s1 = pngSize(await insertedPng(await one('{d.c:barcode(qrcode, scale:1)}', { c: 'x' })));
    const s10 = pngSize(await insertedPng(await one('{d.c:barcode(qrcode, scale:10)}', { c: 'x' })));
    assert.strictEqual(s10.width, s1.width * 10);
    assert.strictEqual(s10.height, s1.height * 10);
    for (const bad of ['0', '11', '2.5', 'abc']) {
      const msg = await oneError('{d.c:barcode(qrcode, scale:' + bad + ')}', { c: 'x' });
      // в Source метка без пробелов, как её хранит разбор Carbone
      assert.strictEqual(msg, 'barcode: недопустимое значение «' + bad + '» опции scale (целое от 1 до 10) Source: "{d.c:barcode(qrcode,scale:' + bad + ')}"');
    }
  });

  it('rotate:R — ширина и высота меняются местами; rotate:X — ошибка', async function () {
    const n = pngSize(await insertedPng(await one('{d.c:barcode(code128)}', { c: 'ABC' })));
    const rr = pngSize(await insertedPng(await one('{d.c:barcode(code128, rotate:R)}', { c: 'ABC' })));
    assert.deepStrictEqual(rr, { width: n.height, height: n.width });
    const msg = await oneError('{d.c:barcode(code128, rotate:X)}', { c: 'ABC' });
    assert.strictEqual(normalizeError(msg), 'barcode: недопустимое значение «X» опции rotate (N, R, L или I)');
  });

  it('barcolor:#FF0000 — цвет передаётся в bwip-js как FF0000; цвет не #RRGGBB — ошибка', async function () {
    const buf = await insertedPng(await one('{d.c:barcode(qrcode, barcolor:#FF0000)}', { c: 'x' }));
    assert.ok(buf.equals(await direct({ bcid: 'qrcode', text: 'x', barcolor: 'FF0000' })));
    assert.ok(!buf.equals(await direct({ bcid: 'qrcode', text: 'x' })));
    for (const bad of ['red', 'FF0000', '#F00', '#GG0000']) {
      const msg = await oneError('{d.c:barcode(qrcode, barcolor:' + bad + ')}', { c: 'x' });
      assert.strictEqual(normalizeError(msg), 'barcode: недопустимое значение «' + bad + '» опции barcolor (цвет #RRGGBB)');
    }
  });

  it('textsize, textxalign, textyalign, textcolor, backgroundcolor передаются в bwip-js', async function () {
    const marker = '{d.c:barcode(code128, includetext:true, textsize:14, textxalign:left, textyalign:above, textcolor:#00FF00, backgroundcolor:#FFFFEE)}';
    const buf = await insertedPng(await one(marker, { c: 'ABC' }));
    assert.ok(buf.equals(await direct({ bcid: 'code128', text: 'ABC', includetext: true, textsize: 14, textxalign: 'left', textyalign: 'above', textcolor: '00FF00', backgroundcolor: 'FFFFEE' })));
  });

  it('eclevel:H — уровень коррекции QR; eclevel:Z — ошибка', async function () {
    const text = 'Съешь же ещё этих мягких французских булок, да выпей чаю';
    const buf = await insertedPng(await one('{d.c:barcode(qrcode, eclevel:H)}', { c: text }));
    assert.ok(buf.equals(await direct({ bcid: 'qrcode', text, eclevel: 'H' })));
    assert.ok(!buf.equals(await direct({ bcid: 'qrcode', text, eclevel: 'L' })));
    const msg = await oneError('{d.c:barcode(qrcode, eclevel:Z)}', { c: 'x' });
    assert.strictEqual(normalizeError(msg), 'barcode: недопустимое значение «Z» опции eclevel (L, M, Q или H)');
  });

  it('svg:true игнорируется — вывод PNG', async function () {
    const buf = await insertedPng(await one('{d.c:barcode(qrcode, svg:true)}', { c: 'x' }));
    assert.ok(buf.equals(await direct({ bcid: 'qrcode', text: 'x' })));
  });

  it('опция в кавычках и пробелы вокруг двоеточия', async function () {
    const buf = await insertedPng(await one('{d.c:barcode(\'qrcode\', \'barcolor: #FF0000\')}', { c: 'x' }));
    assert.ok(buf.equals(await direct({ bcid: 'qrcode', text: 'x', barcolor: 'FF0000' })));
  });

  describe('ошибки с меткой', function () {
    it('неизвестный тип', async function () {
      assert.strictEqual(await oneError('{d.c:barcode(nope)}', { c: 'x' }), 'неизвестный тип штрихкода «nope» Source: "{d.c:barcode(nope)}"');
    });
    it('тип не указан', async function () {
      assert.strictEqual(normalizeError(await oneError('{d.c:barcode()}', { c: 'x' })), 'barcode: укажите тип штрихкода, например barcode(qrcode)');
    });
    it('данные abc для ean13 — причина от bwip-js', async function () {
      assert.strictEqual(await oneError('{d.c:barcode(ean13)}', { c: 'abc' }),
        'штрихкод ean13 не построен: EAN-13 must be 12 or 13 digits Source: "{d.c:barcode(ean13)}"');
    });
    it('неизвестная опция', async function () {
      assert.strictEqual(normalizeError(await oneError('{d.c:barcode(qrcode, color:#FF0000)}', { c: 'x' })),
        'barcode: неизвестная опция «color» (width, height, scale, includetext, textsize, textxalign, textyalign, rotate, barcolor, textcolor, backgroundcolor, eclevel, svg)');
    });
    it('опция без двоеточия', async function () {
      assert.strictEqual(normalizeError(await oneError('{d.c:barcode(qrcode, includetext)}', { c: 'x' })), 'barcode: опция «includetext» записывается как имя:значение');
    });
    it('прочие недопустимые значения', async function () {
      const cases = [
        ['width:0', 'barcode: недопустимое значение «0» опции width (число миллиметров больше 0)'],
        ['height:-5', 'barcode: недопустимое значение «-5» опции height (число миллиметров больше 0)'],
        ['includetext:yes', 'barcode: недопустимое значение «yes» опции includetext (true или false)'],
        ['textsize:big', 'barcode: недопустимое значение «big» опции textsize (число больше 0)'],
        ['textxalign:middle', 'barcode: недопустимое значение «middle» опции textxalign (left, center, right или justify)'],
        ['textyalign:top', 'barcode: недопустимое значение «top» опции textyalign (below, center или above)']
      ];
      for (const [opt, message] of cases) {
        assert.strictEqual(await oneError('{d.c:barcode(code128, ' + opt + ')}', { c: 'x' }), message + ' Source: "{d.c:barcode(code128,' + opt + ')}"');
      }
    });
    it('объект вместо строки — ошибка', async function () {
      assert.strictEqual(normalizeError(await oneError('{d.c:barcode(qrcode)}', { c: { a: 1 } })), 'значение штрихкода должно быть строкой или числом');
    });
    it('слишком большое изображение — ошибка до выделения памяти', async function () {
      const msg = await oneError('{d.c:barcode(code128, scale:10, width:500, height:500)}', { c: 'ABC' });
      assert.strictEqual(normalizeError(msg), 'штрихкод больше 16 млн пикселей (уменьшите scale, width или height)');
    });
    it('ошибка в метке, которая не выполнялась (пустой цикл), — всё равно ошибка шаблона', async function () {
      const raws = ['<w:p><w:r><w:t>{d.items[i].x}</w:t></w:r></w:p>', para(drawing('{d.items[i].c:barcode(qrcode, scale:11)}')), '<w:p><w:r><w:t>{d.items[i+1].x}</w:t></w:r></w:p>'];
      assert.match(await renderError(raws, { items: [] }), /^barcode: недопустимое значение «11» опции scale/);
    });
  });

  for (const [name, data] of [['null', { c: null }], ['пустая строка', { c: '' }], ['нет значения', {}]]) {
    it(name + ' — заглушка удаляется', async function () {
      const r = await one('{d.c:barcode(qrcode)}', data);
      assert.ok(!r.doc.includes('<w:drawing'), r.doc);
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
    });
  }

  it(':barcode в обычном тексте — ошибка «штрихкод ставится в замещающий текст картинки»', async function () {
    const msg = await renderError([para('<w:t>[{d.c:barcode(qrcode)}]</w:t>')], { c: 'x' });
    assert.strictEqual(msg, 'штрихкод ставится в замещающий текст картинки Source: "{d.c:barcode(qrcode)}"');
  });

  it('barcode + imageFit(contain): портретный штрихкод вписан в квадратную рамку по высоте', async function () {
    const r = await one('{d.c:barcode(code128, rotate:R):imageFit(contain)}', { c: 'ABCDEFGHIJKL' });
    const size = pngSize(await insertedPng(r));
    assert.ok(size.height > size.width);
    const cx = Math.round(2000000 * size.width / size.height);
    assert.deepStrictEqual(sizes(r.doc), ['wp:extent ' + cx + '×2000000', 'a:ext ' + cx + '×2000000']);
    // без imageFit (fillWidth) рамка вытянулась бы по высоте
    const f = await one('{d.c:barcode(code128, rotate:R)}', { c: 'ABCDEFGHIJKL' });
    assert.strictEqual(sizes(f.doc)[0], 'wp:extent 2000000×' + Math.round(2000000 * size.height / size.width));
  });

  it('цикл: одинаковые штрихкоды делят файл, другие опции — другой файл', async function () {
    const raws = ['<w:p><w:r><w:t>{d.items[i].x}</w:t></w:r></w:p>' + para(drawing('{d.items[i].c:barcode(qrcode)}')) + '<w:p><w:r><w:t>{d.items[i+1].x}</w:t></w:r></w:p>', para(drawing('{d.items[0].c:barcode(qrcode, scale:5)}', { id: 9 }))];
    const r = await render(raws, { items: [{ c: 'a' }, { c: 'b' }, { c: 'a' }] });
    const list = embeds(r.doc);
    assert.strictEqual(list.length, 4);
    assert.strictEqual(list[0], list[2]);
    assert.strictEqual(new Set(list).size, 3);
  });

  it('ODT: штрихкод в svg:desc — Pictures/cr-img-1.png', async function () {
    const r = await renderAny(await buildOdf('odt', '<text:p>' + odfFrame({ desc: '{d.c:barcode(qrcode)}' }) + '</text:p>'), 'odt', { c: 'x' });
    assert.ok(Buffer.from(await r.read('Pictures/cr-img-1.png', true)).equals(await direct({ bcid: 'qrcode', text: 'x' })));
  });
});
