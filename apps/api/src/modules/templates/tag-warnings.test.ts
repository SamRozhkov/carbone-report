import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { findTagWarnings } from './tag-warnings';

async function zip(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: 'nodebuffer' });
}

const sst = (...items: string[]) =>
  `<sst>${items.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;

describe('findTagWarnings', () => {
  it('DOCX: тег, разрезанный на два фрагмента текста, находится', async () => {
    const file = await zip({
      'word/document.xml':
        '<w:document><w:p><w:r><w:t>{d.data[i].</w:t></w:r><w:r><w:t>сnt}</w:t></w:r></w:p></w:document>',
    });
    const r = await findTagWarnings(file, 'docx');
    expect(r.total).toBe(1);
    expect(r.warnings[0]).toEqual({ tag: '{d.data[i].сnt}', word: 'сnt', letters: ['с'] });
  });

  it('XLSX: смешанное слово и русский корень тега', async () => {
    const file = await zip({
      'xl/sharedStrings.xml': sst('{d.data[].сnt:aggSum}', '{с.g[i].cnt}'),
    });
    const r = await findTagWarnings(file, 'xlsx');
    expect(r.total).toBe(2);
    expect(r.warnings).toEqual([
      { tag: '{d.data[].сnt:aggSum}', word: 'сnt', letters: ['с'] },
      { tag: '{с.g[i].cnt}', word: 'с', letters: ['с'] },
    ]);
  });

  it('корректные теги не вызывают предупреждений', async () => {
    const file = await zip({
      'xl/sharedStrings.xml': sst(
        '{d.data[i].Сумма}',
        "{d.x:ifEQ('Да')}",
        "{d.rows[type='Да'].v}",
        '{привет}',
        '{d.a:format(Сnt)}',
      ),
    });
    expect(await findTagWarnings(file, 'xlsx')).toEqual({ warnings: [], total: 0 });
  });

  it('сущности XML декодируются', async () => {
    const file = await zip({
      'content.xml': '<x><p>{d.a[i].&#1089;nt}</p><p>{d.b[i].&#x441;nt}</p></x>',
    });
    const r = await findTagWarnings(file, 'ods');
    expect(r.total).toBe(2);
  });

  it('части чужого формата не просматриваются', async () => {
    const file = await zip({ 'ppt/slides/slide1.xml': '<a>{d.сnt}</a>' });
    expect((await findTagWarnings(file, 'docx')).total).toBe(0);
    expect((await findTagWarnings(file, 'pptx')).total).toBe(1);
  });

  it('повреждённый архив — пустой результат', async () => {
    expect(await findTagWarnings(Buffer.from('not a zip'), 'docx')).toEqual({
      warnings: [],
      total: 0,
    });
  });

  it('больше 20 тегов: первые 20 и общее число', async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `{d.a[i].сnt${i}}`);
    const file = await zip({ 'xl/sharedStrings.xml': sst(...tags, tags[0]!) });
    const r = await findTagWarnings(file, 'xlsx');
    expect(r.warnings).toHaveLength(20);
    expect(r.total).toBe(25);
  });
});
