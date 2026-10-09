import sys, json, base64, zlib, struct; sys.path.insert(0,'.'); from lib import run, para
cars = [{'brand':'Лада','qty':3,'price':100.5,'ok':True},{'brand':'Тесла','qty':1,'price':2000,'ok':False},{'brand':'Лада','qty':2,'price':120,'ok':True},{'brand':'БМВ','qty':5,'price':1500,'ok':True}]
T=[]
def t(name, items, data=None, **kw): T.append(dict(name=name, items=items, data=data or {}, **kw))
for lang in ['ru-ru','ru-RU','ru','ru_RU', None]:
    o = {'lang': lang}
    t(f'locale lang={lang}', ["{d.n:formatN()} | {d.n:formatN(2)} | {d.n:formatC()} | {d.n:formatC(0)} | {d.five:formatC('M')} | {d.five:formatC('LL')} | {d.d:formatD('DD MMMM YYYY, dddd')} | {d.d:formatD('LL')}"], {'n':1234567.891,'five':5,'d':'2026-03-08'}, opts=o)
t('formatC ru + currencyTarget RUB', ["{d.n:formatC()} | {d.n:formatC(2,'RUB')} | {d.n:formatC(2,'USD')} | {d.n:convCurr('USD')}"], {'n':1000}, opts={'lang':'ru','currencySource':'RUB','currencyTarget':'RUB'})
t('ru-ru + currencySource/Target RUB', ["{d.n:formatC()} | {d.n:formatC(2,'USD')} | {d.n:convCurr('USD')} | {d.n:formatN(2)}"], {'n':1000}, opts={'currencySource':'RUB','currencyTarget':'RUB'})
t('ru + currencyRates', ["{d.n:formatC(2,'USD')} | {d.n:convCurr('USD')}"], {'n':1000}, opts={'lang':'ru','currencySource':'RUB','currencyTarget':'RUB','currencyRates':{'RUB':1,'USD':0.011}})
t('ru no currency opts', ["{d.n:formatC(2,'USD')} | {d.n:convCurr('USD')} | {d.n:formatC(2,'RUB')}"], {'n':1000}, opts={'lang':'ru'})
t('count() alone', ['{d.cars[i].brand:count()} {d.cars[i].brand}','{d.cars[i+1].brand}'], {'cars':cars})
t('iterator via print(.i)', ['{d.cars[i].brand:print(.i)} {d.cars[i].brand}','{d.cars[i+1].brand}'], {'cars':cars})
t('iterator via qty:mul(0):add(.i):add(1)', ['{d.cars[i].qty:mul(0):add(.i):add(1)}. {d.cars[i].brand}','{d.cars[i+1].brand}'], {'cars':cars})
t('iterator {d.cars[i].brand:add(.i)}', ['{d.cars[i].i:add(1)}|{d.cars[i]..i}|{d.cars[i].brand}','{d.cars[i+1].brand}'], {'cars':cars})
t('sum via :set accumulator', ['{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}'], {'cars':cars}, opts={'complement':{'total':0}})
t('sum via :set accumulator no init', ['{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}'], {'cars':cars})
t('sum via :set accumulator mul', ['{d.cars[].qty:mul(.price):add(c.total):set(c.total)}Итого: {c.total:formatN(2)}'], {'cars':cars}, opts={'complement':{'total':0}})
t('group via :set whole object', ['{d.cars[]:set(c.g[id=.brand].rows[])}','{c.g[i].id}','- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}','- {c.g[i].rows[i+1].qty}','{c.g[i+1].id}'], {'cars':cars})
t('group via :set table', ['{d.cars[]:set(c.g[id=.brand].rows[])}',[['{c.g[i].id}',''],['','{c.g[i].rows[i].qty}'],['','{c.g[i].rows[i+1].qty}'],['{c.g[i+1].id}','']]], {'cars':cars})
t('group via :set + subtotal :set', ['{d.cars[]:set(c.g[id=.brand].rows[])}{d.cars[].qty:add(c.g[id=.brand].sum):set(c.g[id=.brand].sum)}','{c.g[i].id}: {c.g[i].sum}','{c.g[i+1].id}'], {'cars':cars})
t('hide row: hideBegin at end of prev row, hideEnd at end of row', [[['H',''],['{d.cars[i].brand}','{d.cars[i].qty}{d.cars[i].ok:ifEQ(false):hideBegin}'],['{d.cars[i+1].brand}','{d.cars[i].ok:hideEnd}']]], {'cars':cars})
t('empty array paragraphs + ifEM message', ['{d.cars[i].brand}','{d.cars[i+1].brand}','{d.cars:ifEM():show(\'Нет данных\')}'], {'cars':[]})
t('pdf output', ['Привет {d.n:formatN(2)}'], {'n':1}, convertTo='pdf')
t('txt output', ['Привет {d.n}'], {'n':1}, convertTo='txt')
t('pdf formatOptions', ['Привет'], {}, convertTo={'formatName':'pdf','formatOptions':{'EncryptFile':True,'DocumentOpenPassword':'x'}})
t('naive datetime tz', ["{d.v:formatD('DD.MM.YYYY HH:mm')} | {d.w:formatD('DD.MM.YYYY HH:mm')} | {d.v:formatD('DD.MM.YYYY HH:mm','YYYY-MM-DD HH:mm:ss')}"], {'v':'2026-03-08 23:30:00','w':'2026-03-08T23:30:00+03:00'})
t('endOfD tz', ["{d.v:endOfD('month'):formatD('DD.MM.YYYY HH:mm')} | {d.v:endOfD('month'):formatD('DD.MM.YYYY HH:mm')}"], {'v':'2026-03-08'}, opts={'timezone':'UTC'})
t('ifEmpty chain with formatD', ["{d.v:ifEmpty('—'):formatD('DD.MM.YYYY')} | {d.v:formatD('DD.MM.YYYY'):ifEmpty('—')}"], {'v':None})
t('ifEmpty on formatted number', ["{d.v:formatN(2):ifEmpty('—')}"], {'v':None})
t('bindColor with colored run', [{'raw':'<w:p><w:r><w:t>{bindColor(ff0000, #hexa) = d.c}</w:t></w:r><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>цвет</w:t></w:r></w:p>'}], {'c':'#00FF00'})
# image
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
img = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1" descr="{d.img}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p.png" descr="{d.img}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
t('dynamic image (alt text)', [{'raw':img}], {'img':'data:image/png;base64,'+base64.b64encode(png).decode()}, rels='<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/>', media={'word/media/p.png':png})
link = '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>ссылка</w:t></w:r></w:hyperlink></w:p>'
t('dynamic hyperlink', [{'raw':link}], {'url':'https://example.org/x'}, rels='<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{d.url}" TargetMode="External"/>')
