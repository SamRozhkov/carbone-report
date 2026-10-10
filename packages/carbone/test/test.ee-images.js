// Изображения из данных (2.4.0, спецификация §32.1): картинка-заглушка DOCX с меткой в замещающем тексте
// заменяется изображением из data URI. Эталона EE нет: ожидания — по §32.1 и решениям R2/R3 плана 2.4.0.
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
      ['просто текст (R3)', 'просто текст', 'значение не изображение (ожидается data URI или адрес http(s))'],
      ['число (R3)', 42, 'значение не изображение (ожидается data URI или адрес http(s))'],
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
      para(drawing('Логотип &quot;ООО&quot; &lt;1&gt; &amp; {d.img}', { title: 'a &quot;b&quot;' })) + para(drawing('Статика &quot;x&quot; &lt;y&gt;', { id: 2 }))
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
