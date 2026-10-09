import zipfile, io, base64, json, subprocess, re, html
from xml.sax.saxutils import escape
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def para(t): return f'<w:p><w:r><w:t xml:space="preserve">{escape(t)}</w:t></w:r></w:p>'
def table(rows):
    x = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' + ''.join('<w:gridCol w:w="2000"/>' for _ in rows[0]) + '</w:tblGrid>'
    for r in rows:
        x += '<w:tr>' + ''.join(f'<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>{para(c)}</w:tc>' for c in r) + '</w:tr>'
    return x + '</w:tbl>'
def docx(items, rels='', media=None):
    body = ''
    for it in items:
        body += para(it) if isinstance(it, str) else (it['raw'] if isinstance(it, dict) else table(it))
    doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}<w:p/><w:sectPr/></w:body></w:document>'
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels+'</Relationships>')
        for k,v in (media or {}).items(): z.writestr(k, v)
        z.writestr('word/document.xml', doc)
    return b.getvalue()
def text_of(docx_bytes):
    z = zipfile.ZipFile(io.BytesIO(docx_bytes))
    x = z.read('word/document.xml').decode()
    # tables: rows -> lines, cells joined by ' | '
    def tbl(m):
        rows = re.findall(r'<w:tr[ >].*?</w:tr>', m.group(0), re.S)
        return '\n'.join('[' + ' | '.join(ptext(c) for c in re.findall(r'<w:tc>.*?</w:tc>', r, re.S)) + ']' for r in rows) + '\n'
    def ptext(s):
        ps = re.findall(r'<w:p[ >].*?</w:p>|<w:p/>', s, re.S)
        return ' / '.join(''.join(html.unescape(t) for t in re.findall(r'<w:t[^>]*>(.*?)</w:t>', p, re.S)) for p in ps)
    parts = []
    pos = 0
    body = re.search(r'<w:body>(.*)</w:body>', x, re.S).group(1)
    for m in re.finditer(r'<w:tbl>.*?</w:tbl>|<w:p[ >].*?</w:p>|<w:p/>', body, re.S):
        if m.group(0).startswith('<w:tbl>'): parts.append(tbl(m).rstrip('\n'))
        else: parts.append(ptext(m.group(0)))
    return '\n'.join(p for p in parts if p != '')
def run(cases):
    payload = []
    for c in cases:
        payload.append({'name': c['name'], 'tpl': base64.b64encode(docx(c['items'], c.get('rels',''), c.get('media'))).decode(), 'data': c.get('data', {}), 'opts': c.get('opts'), 'convertTo': c.get('convertTo')})
    p = subprocess.run(['docker', 'exec', '-i', 'carbone-reports-api-1', 'node', '-e', open(__file__.replace('lib.py','runner.js')).read()], input=json.dumps(payload).encode(), capture_output=True)
    if p.returncode: raise SystemExit(p.stderr.decode())
    res = json.loads(p.stdout)
    for c, r in zip(cases, res):
        if 'out' in r:
            raw = base64.b64decode(r['out']); r['raw'] = raw
            if c.get('convertTo') in (None, 'docx'):
                try: r['text'] = text_of(raw)
                except Exception as e: r['text'] = f'<parse error {e}; {raw[:80]!r}>'
            else:
                r['text'] = f'<{len(raw)} bytes, starts {raw[:8]!r}>'; r['raw'] = raw
            del r['out']
    return res
