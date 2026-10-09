import sys, json, pickle; sys.path.insert(0,'.'); from lib import run
cars = [{'brand':'Лада','qty':3,'price':100.5,'ok':True},{'brand':'Тесла','qty':1,'price':2000,'ok':False},{'brand':'Лада','qty':2,'price':120,'ok':True},{'brand':'БМВ','qty':5,'price':1500,'ok':True}]
T = []
def t(sec, name, items, data=None, exp=None, **kw):
    T.append(dict(sec=sec, name=name, items=items if isinstance(items, list) else [items], data=data if data is not None else {}, exp=exp, **kw))
def P(tag, data, exp=None, sec=None, name=None, **kw):  # single-paragraph test
    t(sec or CUR, name or tag, ['['+tag+']'], data, None if exp is None else '['+exp+']', **kw)
# ---------- 1 basics
CUR='1'
P('{d.name}', {'name':'Иван'}, 'Иван')
P('{d.client.address.city}', {'client':{'address':{'city':'Москва'}}}, 'Москва')
P('{d.missing}', {}, '')
P('{d.items[0].name} {d.items[1].name}', {'items':[{'name':'a'},{'name':'b'}]}, 'a b')
P('{d.items[id=2].name}', {'items':[{'id':1,'name':'a'},{'id':2,'name':'b'}]}, 'b', name='array search [id=2]')
P("{d.items[code='X'].name}", {'items':[{'code':'Y','name':'a'},{'code':'X','name':'b'}]}, 'b', name='array search string')
P('{d.client.sub..name}', {'client':{'name':'Родитель','sub':{'x':1}}}, 'Родитель', name='parent ..')
P('<&> "кавычки"', {}, '<&> "кавычки"', name='literal xml chars')
P('{d.s}', {'s':'<b>&"\''}, '<b>&"\'', name='data with xml chars')
P('{c.param} {c.org.name}', {}, 'X ООО Ромашка', name='complement c.', opts={'complement':{'param':'X','org':{'name':'ООО Ромашка'}}})
P("{c.now:formatD('YYYY')}", {}, '2026', name='c.now')
P('{#cl = d.client}{$cl.name}', {'client':{'name':'Пётр'}}, 'Пётр', name='alias')
P('{#byId($x) = d.items[id=$x]}{$byId(2).name}', {'items':[{'id':1,'name':'a'},{'id':2,'name':'b'}]}, 'b', name='param alias')
t('1','table [i]/[i+1]', [[['№','Марка','Кол-во'],['{d.cars[i].brand}','{d.cars[i].qty}',''],['{d.cars[i+1].brand}','','']]], {'cars':cars}, '[Марка | Кол-во | ]... rows Лада/Тесла/Лада/БМВ')
t('1','paragraph loop', ['{d.cars[i].brand}','{d.cars[i+1].brand}'], {'cars':cars}, 'Лада\nТесла\nЛада\nБМВ')
t('1','inline loop same paragraph', ['[{d.cars[i].brand}, {d.cars[i+1].brand}]'], {'cars':cars}, '[Лада, Тесла, Лада, БМВ, ]')
nested = {'groups':[{'name':'Г1','items':[{'x':'a'},{'x':'b'}]},{'name':'Г2','items':[{'x':'c'}]},{'name':'Г3','items':[]}]}
t('1','nested loop paragraphs', ['{d.groups[i].name}:','- {d.groups[i].items[i].x}','- {d.groups[i].items[i+1].x}','{d.groups[i+1].name}'], nested, 'Г1: a b Г2: c Г3:')
t('1','nested loop table rows', [[['{d.groups[i].name}',''],['','{d.groups[i].items[i].x}'],['','{d.groups[i].items[i+1].x}'],['{d.groups[i+1].name}','']]], nested, 'Г1/a/b/Г2/c/Г3')
t('1','nested: table inside paragraph loop', ['== {d.groups[i].name}', [['{d.groups[i].items[i].x}'],['{d.groups[i].items[i+1].x}']], '{d.groups[i+1].name}'], nested, 'one table per group')
t('1','numbering .i', [[['{d.cars[i].i}','{d.cars[i].brand}'],['{d.cars[i+1].i}','']]], {'cars':cars}, '0..3?')
t('1','numbering .i:add(1)', [[['{d.cars[i].i:add(1)}','{d.cars[i].brand}'],['{d.cars[i+1].i}','']]], {'cars':cars}, '1..4')
t('1','numbering :count()', [[['{d.cars[i].brand:count()}','{d.cars[i].brand}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, '1..4')
t('1','numbering :cumCount', [[['{d.cars[i].brand:cumCount}','{d.cars[i].brand}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, '1..4')
t('1','empty array table', ['до', [['H'],['{d.cars[i].brand}'],['{d.cars[i+1].brand}']], 'после'], {'cars':[]}, 'до\n[H]\nпосле')
t('1','missing array table', ['до', [['H'],['{d.cars[i].brand}'],['{d.cars[i+1].brand}']], 'после'], {}, 'до\n[H]\nпосле')
t('1','loop over object .att/.val', ['{d.obj[i].att}={d.obj[i].val}','{d.obj[i+1].att}'], {'obj':{'a':1,'b':2}}, 'a=1\nb=2')
t('1','loop over string array', ['{d.tags[i]}','{d.tags[i+1]}'], {'tags':['x','y']}, 'x\ny')
t('1','horizontal loop (columns)', [[['{d.cols[i].n}','{d.cols[i+1].n}'],['{d.cols[i].v}','{d.cols[i+1].v}']]], {'cols':[{'n':'A','v':1},{'n':'B','v':2},{'n':'C','v':3}]}, '[A|B|C][1|2|3]')
t('1','root array d[i]', ['{d[i].brand}','{d[i+1].brand}'], cars, 'Лада Тесла Лада БМВ')
t('1','lookup (prerelease 5.2)', ['{o.preReleaseFeatureIn=5002000}','{d.movies[i].actorId:print(..actors[id=.actorId].name)}','{d.movies[i+1].actorId}'], {'movies':[{'actorId':2},{'actorId':1}],'actors':[{'id':1,'name':'A1'},{'id':2,'name':'A2'}]}, 'A2\nA1')
t('1','lookup in loop without prerelease', ['{d.movies[i].actorId:print(..actors[id=.actorId].name)}','{d.movies[i+1].actorId}'], {'movies':[{'actorId':2},{'actorId':1}],'actors':[{'id':1,'name':'A1'},{'id':2,'name':'A2'}]}, 'A2\nA1')
t('1','parent access in loop ..', ['{d.items[i].x} {d.items[i]..title}','{d.items[i+1].x}'], {'title':'T','items':[{'x':1},{'x':2}]}, '1 T\n2 T')
P('{d.text:convCRLF}', {'text':'строка1\nстрока2'}, 'строка1 / строка2 (line break)', sec='1', name='multiline :convCRLF')
P('{d.text}', {'text':'строка1\nстрока2'}, '?', sec='1', name='multiline without convCRLF')
# ---------- 2 formatting
CUR='2'
for f, v, e in [
 ("formatD('DD MMMM YYYY')", '2026-03-08', '08 марта 2026'),
 ("formatD('D MMMM YYYY г.')", '2026-03-08', '8 марта 2026 г.'),
 ("formatD('MMMM YYYY')", '2026-03-08', 'март 2026'),
 ("formatD('DD.MM.YYYY')", '2026-03-08', '08.03.2026'),
 ("formatD('L')", '2026-03-08', '08.03.2026'),
 ("formatD('LL')", '2026-03-08', '8 марта 2026 г.'),
 ("formatD('LLLL')", '2026-03-08T10:00:00Z', 'воскресенье, 8 марта 2026 г., 13:00'),
 ("formatD('dddd, D MMM')", '2026-03-08', 'воскресенье, 8 мар.'),
 ("formatD('DD.MM.YYYY HH:mm')", '2026-03-08T22:30:00Z', '09.03.2026 01:30'),
 ("formatD('DD.MM.YYYY HH:mm')", '2026-03-08T22:30:00', '08.03.2026 22:30?'),
 ("formatD('DD.MM.YYYY')", '2026-03-08 00:00:00', '08.03.2026'),
 ("formatD('DD.MM.YYYY', 'YYYYMMDD')", '20260308', '08.03.2026'),
 ("formatD('DD.MM.YYYY', 'X')", 1772928000, '08.03.2026'),
 ("formatD('DD.MM.YYYY')", None, ''),
 ("formatD('DD.MM.YYYY')", 'не дата', '?'),
 ("addD(1, 'month'):formatD('DD.MM.YYYY')", '2026-01-31', '28.02.2026'),
 ("subD(7, 'day'):formatD('DD.MM.YYYY')", '2026-03-08', '01.03.2026'),
 ("startOfD('month'):formatD('DD.MM.YYYY')", '2026-03-08', '01.03.2026'),
 ("endOfD('month'):formatD('DD.MM.YYYY')", '2026-03-08', '31.03.2026'),
 ("diffD('2026-12-31', 'days')", '2026-03-08', '298'),
 ("convDate('YYYY-MM-DD', 'DD.MM.YYYY')", '2026-03-08', '08.03.2026'),
 ("formatI('human')", 7200000, '2 часа'),
 ("formatI('human+')", 7200000, 'через 2 часа'),
 ("formatI('days', 'hours')", 48, '2'),
 ("formatN()", 1234567.891, '1 234 567,891'),
 ("formatN(2)", 1234567.891, '1 234 567,89'),
 ("formatN(0)", 1234567.5, '1 234 568'),
 ("formatN(2)", '1234.5', '1 234,50 (string input)'),
 ("formatN(2)", None, ''),
 ("round(2)", 10.055, '10.06'),
 ("add(2)", 1000.4, '1002.4'),
 ("sub(.b)", 10, '7'),
 ("mul(.b):formatN(2)", 10, '30,00'),
 ("div(3):round(2)", 10, '3.33'),
 ("div(0)", 10, '?'),
 ("mod(3)", 10, '1'),
 ("abs()", -5.5, '5.5'),
 ("ceil()", 10.1, '11'),
 ("floor()", 10.9, '10'),
 ("toFixed(2)", 10.1, '10.10'),
 ("add(.b * 2 - 1)", 10, '15'),
 ("formatC()", 1234567.891, '1 234 567,89 ₽'),
 ("formatC(0)", 1234.5, '1 235 ₽'),
 ("formatC('M')", 5, 'рублей'),
 ("formatC('LL')", 5, '5,00 рублей'),
 ("formatC(2, 'USD')", 1000, '?'),
 ("formatC(2, 'EUR')", 1000, '?'),
 ("convCurr('USD')", 1000, '1000 without rates'),
 ("lowerCase()", 'ПРИВЕТ Мир', 'привет мир'),
 ("upperCase()", 'привет ёж', 'ПРИВЕТ ЁЖ'),
 ("ucFirst()", 'иванов иван', 'Иванов иван'),
 ("ucWords()", 'иванов иван', 'Иванов Иван'),
 ("substr(0, 5)", 'Длинная строка', 'Длинн'),
 ("substr(0, 10, true)", 'Длинная строка текста', 'Длинная (word mode)'),
 ("padl(6, '0')", '42', '000042'),
 ("padr(6, '.')", 'ab', 'ab....'),
 ("ellipsis(7)", 'Длинная строка', 'Длинная...'),
 ("prepend('№ ')", '15', '№ 15'),
 ("append(' руб.')", '15', '15 руб.'),
 ("replace('-', '/')", '2026-03-08', '2026/03/08'),
 ("len()", 'Привет', '6'),
 ("print('X')", 'anything', 'X'),
 ("unaccent()", 'café ёлка', 'cafe ёлка?'),
 ("printJSON()", {'a':1}, '{"a":1}'),
 ("split(',')", 'a,b', '?'),
 ("formatR()", 'RU', 'Россия'),
 ("arrayJoin()", ['a','b','c'], 'a, b, c'),
 ("arrayJoin('; ', 1, 1)", ['a','b','c'], 'b'),
 ("arrayMap(', ', ':', 'name')", [{'name':'a','x':1},{'name':'b','x':2}], 'a, b'),
 ("len()", [1,2,3], '3'),
 ("defaultURL('https://example.com')", 'not a url', 'https://example.com'),
 ("lowerCase:upperCase:prepend('<'):append('>')", 'Аб', '<АБ> (chaining)'),
]:
    P('{d.v:'+f+'}', {'v':v,'b':3}, e, name=f+' ← '+json.dumps(v, ensure_ascii=False))
P("{o.useHighPrecisionArithmetic=true}{d.a:add(.b)}", {'a':0.1,'b':0.2}, '0.3', name='useHighPrecisionArithmetic 0.1+0.2')
P("{d.a:add(.b)}", {'a':0.1,'b':0.2}, '0.30000000000000004', name='plain float 0.1+0.2')
P("{d.v:formatN(2)}", {'v':1234.5}, '1,234.50', name='formatN with lang en-us', opts={'lang':'en-us'})
P("{d.v:formatD('DD MMMM YYYY')}", {'v':'2026-03-08'}, '08 March 2026', name='formatD with lang en-us', opts={'lang':'en-us'})
P("{d.v:formatN(2)}", {'v':1234.5}, '?', name='formatN with lang ru (not ru-ru)', opts={'lang':'ru'})
P("{d.v:formatC(2)}", {'v':1000}, '? USD', name='formatC currency opts target USD + rates', opts={'currency':{'source':'RUB','target':'USD','rates':{'RUB':1,'USD':0.011}}})
P("{d.v:convCurr('USD', 'RUB')}", {'v':1000}, '11', name='convCurr with rates', opts={'currency':{'source':'RUB','target':'USD','rates':{'RUB':1,'USD':0.011}}})
P("{d.v:formatC(2)}", {'v':1000}, '?', name='formatC with currency source only', opts={'currency':{'source':'RUB'}})
P("{d.v:formatD('DD.MM.YYYY HH:mm')}", {'v':'2026-03-08T22:30:00Z'}, '08.03.2026 22:30', name='timezone UTC option', opts={'timezone':'UTC'})
# ---------- 3 conditions & filters
CUR='3'
for f, v, e in [
 ("ifEQ('paid'):show('Оплачен'):elseShow('Не оплачен')", 'paid', 'Оплачен'),
 ("ifEQ('paid'):show('Оплачен'):elseShow('Не оплачен')", 'new', 'Не оплачен'),
 ("ifEQ(1):show('один')", 2, '2 (value passes through when no elseShow)'),
 ("ifNE(0):show('ненулевой')", 5, 'ненулевой'),
 ("ifGT(100):show('>100'):elseShow('<=100')", 150, '>100'),
 ("ifGTE(100):show('ok')", 100, 'ok'),
 ("ifLT(0):show('минус'):elseShow('плюс')", -1, 'минус'),
 ("ifLTE(0):show('<=0')", 0, '<=0'),
 ("ifIN('Лада'):show('есть')", 'Лада, БМВ', '? (ifIN tests if value contains arg)'),
 ("ifIN('Лада'):show('есть'):elseShow('нет')", ['Лада','БМВ'], 'есть'),
 ("ifNIN('X'):show('нет X')", ['Лада'], 'нет X'),
 ("ifEM():show('пусто'):elseShow('не пусто')", '', 'пусто'),
 ("ifEM():show('пусто'):elseShow('не пусто')", None, 'пусто'),
 ("ifEM():show('пусто'):elseShow('не пусто')", [], 'пусто'),
 ("ifNEM():show('есть')", 'x', 'есть'),
 ("ifTE('number'):show('число'):elseShow('не число')", 5, 'число'),
 ("ifTE('string'):show('строка')", 'x', 'строка'),
 ("ifGT(0):and(.b):ifEQ(3):show('оба'):elseShow('нет')", 1, 'оба'),
 ("ifEQ(0):or(.b):ifEQ(3):show('хотя бы одно'):elseShow('нет')", 1, 'хотя бы одно'),
 ("ifEQ(true):show('да'):elseShow('нет')", True, 'да'),
 ("ifEQ('true'):show('да'):elseShow('нет')", True, '?'),
 ("ifEmpty('—')", None, '—'),
 ("ifEmpty('—')", '', '—'),
 ("ifEmpty('—')", 0, '0?'),
 ("ifEmpty('—')", [], '—'),
 ("ifEmpty('—')", 'текст', 'текст'),
 ("ifEM():show('—'):elseShow(.v)", 'x', 'x? (dynamic elseShow)'),
 ("ifEQ(.b):show('равно')", 3, 'равно (dynamic param)'),
 ("ifEQ(1):show({t(hello)})", 1, 'Здравствуйте'),
]:
    P('{d.v:'+f+'}', {'v':v,'b':3}, e, name=f+' ← '+json.dumps(v, ensure_ascii=False), opts={'translations':{'ru-ru':{'hello':'Здравствуйте'}}} if 't(' in f else None)
P("{d.missing:ifEmpty('—')}", {}, '—', name="ifEmpty on missing field")
t('3','showBegin/showEnd true', ['A{d.f:ifEQ(true):showBegin}B{d.f:showEnd}C'], {'f':True}, 'ABC')
t('3','showBegin/showEnd false', ['A{d.f:ifEQ(true):showBegin}B{d.f:showEnd}C'], {'f':False}, 'AC')
t('3','hideBegin/hideEnd paragraphs', ['до','{d.f:ifEQ(true):hideBegin}','скрыто1','скрыто2','{d.f:hideEnd}','после'], {'f':True}, 'до\nпосле (maybe empty paras)')
t('3','drop(p)', ['до','{d.f:ifEQ(true):drop(p)}удалить абзац','после'], {'f':True}, 'до\nпосле')
t('3','drop(p) false', ['до','{d.f:ifEQ(true):drop(p)}остаётся','после'], {'f':False}, 'до\nостаётся\nпосле')
t('3','keep(p)', ['до','{d.f:ifEQ(true):keep(p)}оставить','после'], {'f':False}, 'до\nпосле')
t('3','drop(row) in loop', [[['H'],['{d.cars[i].brand}{d.cars[i].ok:ifEQ(false):drop(row)}'],['{d.cars[i+1].brand}']]], {'cars':cars}, 'H Лада Лада БМВ')
t('3','drop(table)', ['до',[['{d.f:ifEQ(true):drop(table)}x']],'после'], {'f':True}, 'до\nпосле')
t('3','hide row via hideBegin/hideEnd in row', [[['H',''],['{d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand}','{d.cars[i].qty}{d.cars[i].ok:hideEnd}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, 'row Тесла hidden?')
t('3','hide static row via showBegin across rows', [[['A'],['{d.f:ifEQ(true):showBegin}скрытая строка'],['{d.f:showEnd}B']]], {'f':False}, '?')
t('3','filter number [i, qty > 1]', ['{d.cars[i, qty > 1].brand}','{d.cars[i+1, qty > 1].brand}'], {'cars':cars}, 'Лада БМВ Лада? order Лада Лада БМВ')
t('3','filter v5 single [i+1] filter', ['{d.cars[i, qty > 1].brand}','{d.cars[i+1].brand}'], {'cars':cars}, 'Лада Лада БМВ')
t('3','filter string [i, brand=Лада]', ["{d.cars[i, brand='Лада'].qty}","{d.cars[i+1, brand='Лада'].qty}"], {'cars':cars}, '3 2')
t('3','filter string unquoted', ["{d.cars[i, brand=Лада].qty}","{d.cars[i+1, brand=Лада].qty}"], {'cars':cars}, '3 2')
t('3','filter bool [i, ok=true]', ["{d.cars[i, ok=true].brand}","{d.cars[i+1, ok=true].brand}"], {'cars':cars}, 'Лада Лада БМВ')
t('3','filter multi AND', ["{d.cars[i, qty > 1, qty < 5].brand}","{d.cars[i+1, qty > 1, qty < 5].brand}"], {'cars':cars}, 'Лада Лада')
t('3','filter index [i, i < 2]', ["{d.cars[i, i < 2].brand}","{d.cars[i+1, i < 2].brand}"], {'cars':cars}, 'Лада Тесла')
t('3','filter exclude last [i, i!=-1]', ["{d.cars[i, i!=-1].brand}","{d.cars[i+1, i!=-1].brand}"], {'cars':cars}, 'Лада Тесла Лада')
t('3','filter in table row', [[['{d.cars[i, ok=true].brand}'],['{d.cars[i+1, ok=true].brand}']]], {'cars':cars}, 'Тесла row hidden')
t('3','sort [qty, i]', ['{d.cars[qty, i].brand}','{d.cars[qty+1, i+1].brand}'], {'cars':cars}, 'Тесла Лада Лада БМВ')
t('3','sort multi [brand, qty, i]', ['{d.cars[brand, qty, i].brand}{d.cars[brand, qty, i].qty}','{d.cars[brand+1, qty+1, i+1].brand}'], {'cars':cars}, 'БМВ5 Лада2 Лада3 Тесла1')
t('3','sort desc [-qty, i]?', ['{d.cars[-qty, i].brand}','{d.cars[-qty+1, i+1].brand}'], {'cars':cars}, '? (docs: not available)')
t('3','distinct [brand]', ['{d.cars[brand].brand}','{d.cars[brand+1].brand}'], {'cars':cars}, 'БМВ Лада Тесла (sorted?)')
t('3','translations {t()}', ['{t(Итого)}: {d.v:t}'], {'v':'apple'}, 'Total: яблоко', opts={'translations':{'ru-ru':{'Итого':'Total','apple':'яблоко'}}})
t('3','translations missing key', ['{t(Итого)}'], {}, 'Итого')
# ---------- 4 totals & grouping
CUR='4'
P('{d.cars[].qty:aggSum}', {'cars':cars}, '11', name='aggSum')
P('{d.cars[].qty:aggSum:formatN(2)}', {'cars':cars}, '11,00', name='aggSum:formatN')
P('{d.cars[].price:aggSum:formatC()}', {'cars':cars}, '3 720,50 ₽', name='aggSum:formatC')
P('{d.cars[].qty:mul(.price):aggSum:formatN(2)}', {'cars':cars}, '10 041,50', name='aggSum of qty*price')
P('{d.cars[].qty:aggAvg}', {'cars':cars}, '2.75', name='aggAvg')
P('{d.cars[].qty:aggMin} {d.cars[].qty:aggMax}', {'cars':cars}, '1 5', name='aggMin/aggMax')
P('{d.cars[].qty:aggCount}', {'cars':cars}, '4', name='aggCount')
P('{d.cars[].brand:aggCountD}', {'cars':cars}, '3', name='aggCountD')
P("{d.cars[].brand:aggStr(', ')}", {'cars':cars}, 'Лада, Тесла, Лада, БМВ', name='aggStr')
P("{d.cars[].brand:aggStrD(' | ')}", {'cars':cars}, 'Лада | Тесла | БМВ', name='aggStrD')
P('{d.cars[ok=true].qty:aggSum}', {'cars':cars}, '10', name='aggSum with filter')
P('{d.cars[].qty:aggSum}', {'cars':[]}, '0?', name='aggSum empty array')
P('{d.groups[].items[].q:aggSum}', {'groups':[{'items':[{'q':1},{'q':2}]},{'items':[{'q':10}]}]}, '13', name='aggSum nested arrays')
P('{d.cars.length}', {'cars':cars}, '4?', name='.length property')
P('{d.cars:len()}', {'cars':cars}, '4', name='array:len()')
t('4','cumSum in loop', [[['{d.cars[i].brand}','{d.cars[i].qty:cumSum}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, '3 4 6 11')
t('4','cumCountD', [[['{d.cars[i].brand}','{d.cars[i].brand:cumCountD}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, '1 2 2 3')
t('4','total row after table', [[['{d.cars[i].brand}','{d.cars[i].qty}'],['{d.cars[i+1].brand}',''],['Итого','{d.cars[].qty:aggSum}']]], {'cars':cars}, 'rows + Итого 11')
t('4','aggSum inside loop (per-group subtotal)', [[['{d.groups[i].name}','{d.groups[i].items[].q:aggSum}'],['{d.groups[i+1].name}','']]], {'groups':[{'name':'A','items':[{'q':1},{'q':2}]},{'name':'B','items':[{'q':10}]}]}, 'A 3 / B 10')
t('4','group-by [brand] + aggSum(.brand)', [[['{d.cars[brand].brand}','{d.cars[brand].qty:aggSum(.brand)}'],['{d.cars[brand+1].brand}','']]], {'cars':cars}, 'БМВ 5 / Лада 5 / Тесла 1')
t('4','group-by + aggCount(.brand)', [[['{d.cars[brand].brand}','{d.cars[brand].qty:aggCount(.brand)}'],['{d.cars[brand+1].brand}','']]], {'cars':cars}, 'БМВ 1 / Лада 2 / Тесла 1')
t('4','partition aggSum(.brand) in plain loop', [[['{d.cars[i].brand}','{d.cars[i].qty:aggSum(.brand)}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, 'Лада 5, Тесла 1, Лада 5, БМВ 5')
t('4','cumCount(.brand) partition', [[['{d.cars[i].brand}','{d.cars[i].qty:cumCount(.brand)}'],['{d.cars[i+1].brand}','']]], {'cars':cars}, '1 1 2 1')
t('4','group header + detail rows (nested filter by parent)', [[['{d.cars[brand].brand}',''],['','{d.cars[brand].brand:print(..)}'],['{d.cars[brand+1].brand}','']]], {'cars':cars}, '? (no native)')
t('4','grouping via :set (v5 enterprise)', ['{d.cars[].brand:set(c.g[id=.brand].rows[].brand)}{d.cars[].qty:set(c.g[id=.brand].rows[].qty)}','{c.g[i].id}','- {c.g[i].rows[i].qty}','- {c.g[i].rows[i+1].qty}','{c.g[i+1].id}'], {'cars':cars}, 'Лада: 3 2 ...')
t('4','grouping with pre-grouped JSON', [[['{d.groups[i].name}','{d.groups[i].items[].q:aggSum}'],['  {d.groups[i].items[i].x}','{d.groups[i].items[i].q}'],['  {d.groups[i].items[i+1].x}',''],['{d.groups[i+1].name}','']]], {'groups':[{'name':'A','items':[{'x':'a1','q':1},{'x':'a2','q':2}]},{'name':'B','items':[{'x':'b1','q':10}]}]}, 'A 3 / a1 1 / a2 2 / B 10 / b1 10')
# ---------- 5 enterprise candidates
CUR='5'
P('{d.h:html}', {'h':'<b>жирный</b> текст'}, 'жирный текст (bold)', name=':html')
P('{d.c:color(p)}цветной', {'c':'#FF0000'}, 'цветной (red)', name=':color(p)')
P('{bindColor(ff0000, #hexa) = d.c}текст ff0000', {'c':'00FF00'}, '?', name='bindColor legacy')
P('{d.v:barcode(qrcode)}', {'v':'123'}, '?', name=':barcode in text')
P('{d.v:barcode(ean13)}', {'v':'5901234123457'}, '?', name=':barcode ean13 text (font mode)')
P('{d.u:defaultURL(\'https://carbone.io\')}', {'u':'bad'}, 'https://carbone.io', name='defaultURL text')
P('{o.preReleaseFeatureIn=5002000}{d.v}', {'v':'ok'}, 'ok', name='o.preReleaseFeatureIn')
P('{d.v:set(c.x)}{c.x}', {'v':'stored'}, 'stored', name=':set store value')
P('{d.v:t}', {'v':'apple'}, 'яблоко', name=':t formatter', opts={'translations':{'ru-ru':{'apple':'яблоко'}}})
