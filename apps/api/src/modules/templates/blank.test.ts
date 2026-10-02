import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createBlankDocument } from './blank';

describe('createBlankDocument', () => {
  it('docx содержит обязательные части OOXML', async () => {
    const zip = await JSZip.loadAsync(await createBlankDocument('docx'));
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']),
    );
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:body>');
  });
  it('xlsx содержит книгу и лист', async () => {
    const zip = await JSZip.loadAsync(await createBlankDocument('xlsx'));
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']),
    );
  });
});
