import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API message for a disabled formatter (apps/api/src/modules/carbone/community.ts, errors catalog). */
const community = (name: string) =>
  `o modelo usa ${name} — não disponível na versão gratuita do Carbone, consulte “Ajuda sobre modelos”`;

const CARS = [
  { brand: 'Fiat', qty: 3, ok: true },
  { brand: 'Tesla', qty: 1, ok: false },
  { brand: 'Fiat', qty: 2, ok: true },
  { brand: 'Jeep', qty: 5, ok: true },
];
/** 1×1 PNG — a real image for the examples (`pnpm help:check` decodes it). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GROUPS = [
  { name: 'G1', items: [{ x: 'a' }, { x: 'b' }] },
  { name: 'G2', items: [{ x: 'c' }] },
  { name: 'G3', items: [] },
];

export const HELP_INTRO: string[] = [
  'Esta página descreve apenas o que foi verificado no nosso Carbone: a versão gratuita (Community Edition). Tudo o que falta nela está reunido na última seção, junto com alternativas. As mensagens de erro do próprio motor Carbone (imagens, códigos de barras, cores, gráficos, HTML) são exibidas em russo depois de “erro no modelo:”; esta ajuda explica o que elas significam.',
  'Os dados do relatório são o objeto `d`. O resultado de cada consulta SQL do modelo fica sob a sua chave: no modo “Lista de linhas” é um array; no modo “Uma linha”, um objeto (ou um valor vazio). Os parâmetros do relatório ficam em `d.params`.',
  'As tags e as “Construções” do painel direito da aba “Documento” podem ser arrastadas com o mouse diretamente para o documento: a tag é inserida onde o botão é solto. Nas “Construções”, substitua `campo` e `array` pelos seus próprios nomes.',
  'Nos exemplos, uma linha que começa com “|” é uma linha de uma tabela do Word, com as células separadas por “|”. As demais linhas são parágrafos independentes.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Conceitos básicos',
    intro: [
      'A tag `{d.field}` insere um valor dos dados. Um caminho com pontos leva a objetos aninhados, `[número]` a um elemento de um array (contando a partir de zero) e `[campo=valor]` a um elemento por uma condição.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Valor de um campo',
        template: 'Cliente: {d.name}',
        data: j({ name: 'João' }),
        result: 'Cliente: João',
        note: 'Se o campo não estiver nos dados, é inserida uma string vazia; não há erro.',
      },
      {
        id: 'basics-nested',
        title: 'Objeto aninhado',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Curitiba' } } }),
        result: 'Curitiba',
      },
      {
        id: 'basics-search',
        title: 'Elemento de um array por uma condição',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "Um valor do tipo string é escrito entre aspas simples: `{d.items[code='X'].name}`. Um elemento pelo seu número: `{d.items[0].name}` (contando a partir de zero).",
      },
      {
        id: 'basics-params',
        title: 'Parâmetro do relatório',
        template: "Período a partir de {d.params.from:formatD('DD/MM/YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Período a partir de 01/03/2026',
        note: "Os parâmetros do relatório ficam em `d.params` com o seu nome. O sistema não preenche sozinho as tags `{c.…}`, exceto `{c.now}`, o momento em que o relatório é gerado: `{c.now:formatD('DD/MM/YYYY')}`. Você só pode guardar os seus próprios valores em `c` com `:set` (veja a seção “Totais e agrupamento”).",
      },
      {
        id: 'basics-ifempty',
        title: 'Valor padrão',
        template: "Pago em: {d.paid_on:formatD('DD/MM/YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Pago em: —',
        note: "`ifEmpty` fica no fim da cadeia: `{d.paid_on:ifEmpty('—'):formatD('DD/MM/YYYY')}` mostra “Invalid Date”. São considerados vazios: null, uma string vazia, um array vazio e um campo ausente; 0 continua sendo 0.",
      },
      {
        id: 'basics-alias',
        title: 'Alias',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Pedro' } }),
        result: 'Pedro',
        note: 'Um alias é declarado com a tag `{#nome = caminho}`; essa tag não mostra nada. Depois, escreva `{$nome…}` no lugar do caminho.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Tabelas',
    intro: [
      'Uma linha de tabela se repete para cada elemento do array de dados: ela contém tags com `[i]`, e a linha seguinte contém pelo menos uma tag com `[i+1]`. A linha `[i+1]` não aparece no resultado. Sem `[i+1]`, o Carbone retorna o erro “has no corresponding [i+1]”. Na linha `[i+1]`, coloque apenas tags `[i+1]` e deixe as demais células vazias: uma tag `[i]` nessa linha provoca o erro “is in the [i+1] row”.',
      'Os parágrafos se repetem da mesma forma: um parágrafo com `[i]`, seguido de um parágrafo com `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Linhas de tabela a partir de um array',
        template: L(
          '| Marca | Qtd. |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Qtd. |',
          '| Fiat | 3 |',
          '| Tesla | 1 |',
          '| Fiat | 2 |',
          '| Jeep | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: 'Loop aninhado',
        template: L(
          '{d.groups[i].name}:',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1:', '- a', '- b', 'G2:', '- c', 'G3:'),
        note: 'Um array aninhado vazio não gera nenhuma linha: “G3” não tem nenhuma, e também não há erro.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Loop aninhado nas linhas de uma tabela',
        template: L(
          '| {d.groups[i].name} | |',
          '| | {d.groups[i].items[i].x} |',
          '| | {d.groups[i].items[i+1].x} |',
          '| {d.groups[i+1].name} | |',
        ),
        data: j({ groups: GROUPS }),
        result: L('| G1 | |', '| | a |', '| | b |', '| G2 | |', '| | c |', '| G3 | |'),
      },
      {
        id: 'tables-empty',
        title: 'Array de dados vazio',
        template: L(
          'antes',
          '| Marca |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'depois',
          "{d.cars:ifEM():show('Não há dados'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('antes', '| Marca |', 'depois', 'Não há dados'),
        note: "As linhas do loop desaparecem e o cabeçalho permanece; a chave pode até faltar por completo: o resultado é o mesmo. Sem `elseShow('')`, `ifEM` mostra o próprio valor quando o array não está vazio.",
      },
      {
        id: 'tables-numbering',
        title: 'Número da linha',
        template: L(
          '| Nº | Marca |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Nº | Marca |',
          '| 1 | Fiat |',
          '| 2 | Tesla |',
          '| 3 | Fiat |',
          '| 4 | Jeep |',
        ),
        note: 'Os números seguem 1, 2, 3… nas linhas exibidas, também em um loop filtrado, sem lacunas. A tag `{d.cars[i].i}` não mostra nada. O método antigo, `{d.cars[i].brand:print(.i):add(1)}`, também funciona, mas `.i` é a posição no array de origem: com um filtro de loop, a numeração tem lacunas. Um número entre parênteses, como na versão antiga do Carbone (`count(0)`), é ignorado: a numeração sempre começa em 1. Repita o filtro e a ordenação do loop na própria tag `count()` (`{d.cars[i, ok=true].brand:count()}`); caso contrário, a linha numera o seu próprio conjunto. As linhas removidas com `drop(row)` também recebem um número, e a numeração fica com lacunas; selecione as linhas com um filtro de loop. Numeração, totais e subtotais: a seção “Totais e numeração”.',
      },
      {
        id: 'tables-filter',
        title: 'Filtrar linhas',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Fiat |', '| Fiat |', '| Jeep |'),
        note: "As comparações `[i, qty > 1]`, as strings `[i, brand='Fiat']` e várias condições separadas por vírgulas funcionam da mesma forma: elas são combinadas com E; não há OU, então adicione um indicador no SQL. Uma linha de tabela pode ser ocultada assim ou com uma tag `drop(row)`; `hideBegin`/`hideEnd` em uma tabela deixam uma linha vazia (a seção “Condições”).",
      },
      {
        id: 'tables-sort',
        title: 'Ordenação',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Tesla', 'Fiat', 'Fiat', 'Jeep'),
        note: 'Somente em ordem crescente. `[-qty, i]` mantém silenciosamente a ordem original: ordene de forma decrescente no SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Formatação',
    intro: [
      "Um formatador é escrito depois de dois-pontos: `{d.field:formatD('DD/MM/YYYY')}`. Os formatadores podem ser encadeados e são aplicados da esquerda para a direita.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Data com o nome do mês',
        template: "{d.date:formatD('D [de] MMMM [de] YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '8 de março de 2026',
        note: "O texto entre colchetes (`[de]`) é impresso como está. `formatD('dddd, D [de] MMMM [de] YYYY')` dá “domingo, 8 de março de 2026”, e `formatD('MMMM [de] YYYY')` dá “março de 2026”.",
      },
      {
        id: 'fmt-date-short',
        title: 'Data em números',
        template: "{d.date:formatD('DD/MM/YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08/03/2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Data e hora',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '08/03/2026 23:30',
        note: 'A hora é exibida no fuso horário do servidor (`TZ`, Europe/Moscow por padrão). Passe as horas com deslocamento (`+03:00`) ou em UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Hora sem deslocamento',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '09/03/2026 02:30',
        note: 'Uma hora sem deslocamento é considerada UTC e deslocada em 3 horas. Passe as horas com deslocamento, ou uma data sem hora.',
      },
      {
        id: 'fmt-number',
        title: 'Número',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1.234.567,89',
        note: 'Os separadores de milhares e de decimais dependem do idioma do relatório: em português (Brasil), o ponto separa os milhares e a vírgula separa as casas decimais. `formatN(0)` arredonda para o inteiro: 1234567.5 → “1.234.568”.',
      },
      {
        id: 'fmt-money',
        title: 'Valor em reais',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: 'R$ 1.234.567,89',
        note: "`formatC()` mostra a moeda do idioma do relatório: o real para o português (Brasil); se o idioma do relatório do modelo mudar, a moeda muda junto. `formatC(0)` omite os centavos: 1234.5 → “R$ 1.235”. `formatC('LL')` escreve o nome da moeda por extenso: “1.234.567,89 reals”. Esse nome é sempre em inglês: no singular coincide com o português (“1,00 real”), mas o plural é “reals”, e não “reais” (“1,50 reals”); por isso, não use `formatC('M')` nem `formatC('LL')` com o real.",
      },
      {
        id: 'fmt-convcurr',
        title: 'Conversão para outra moeda',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '265.8723682063',
        note: "O Carbone converte a partir da moeda do idioma do relatório (o real para o português (Brasil)) por taxas de câmbio embutidas: elas não são atualizadas, e o nosso sistema não passa as suas próprias taxas. `formatC(2, 'USD')` converte silenciosamente da mesma forma: 1000 → “$ 265,87”. Calcule os valores em outras moedas no SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Maiúsculas e minúsculas',
        template: '{d.name:ucWords()}',
        data: j({ name: 'joão silva' }),
        result: 'João Silva',
        note: 'Também `ucFirst()` → “João silva”, `upperCase()`, `lowerCase()`. As letras acentuadas, o ç e as letras de outros alfabetos, como o cirílico, são processadas corretamente.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Encurtar uma string',
        template: '{d.title:ellipsis(6)}',
        data: j({ title: 'Fatura mensal' }),
        result: 'Fatura...',
        note: "Também `substr(0, 5)` → “Fatur”, `padl(6, '0')` para “42” → “000042”, `prepend('Nº ')`, `append(' BRL')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Aritmética',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` aceitam um número ou um campo vizinho (`.b`); as expressões não aceitam parênteses. O resultado é exibido sem formatação: adicione `formatN` para exibi-lo. A divisão por zero retorna silenciosamente o número original.',
      },
      {
        id: 'fmt-array-join',
        title: 'Lista separada por vírgulas',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "Para um array de objetos: `{d.items:arrayMap(', ', ':', 'name')}` — os valores do campo name separados por vírgulas.",
      },
      {
        id: 'fmt-multiline',
        title: 'Texto de várias linhas',
        template: '{d.text:convCRLF}',
        data: j({ text: 'linha1\nlinha2' }),
        result: L('linha1', 'linha2'),
        note: 'Sem `convCRLF`, uma quebra de linha dos dados não aparece no Word.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Condições',
    intro: [
      'Uma condição verifica um valor (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) e mostra `show(…)` ou `elseShow(…)`. As condições são combinadas com `and(.field)` e `or(.field)`.',
      'Parágrafos e partes de um texto são ocultados com `showBegin`/`showEnd` e `hideBegin`/`hideEnd`. Uma linha de tabela é ocultada com um filtro de loop (a seção “Tabelas”) ou com `drop(row)`; um parágrafo, uma tabela ou uma imagem inteiros são removidos com `drop`/`keep`.',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Texto conforme uma condição',
        template: "{d.status:ifEQ('paid'):show('Paga'):elseShow('Não paga')}",
        data: j({ status: 'new' }),
        result: 'Não paga',
        note: "Sem `elseShow`, uma condição falsa mostra o próprio valor: `{d.v:ifEQ(1):show('um')}` dá “2” para 2. Adicione `elseShow('')`.",
      },
      {
        id: 'cond-and',
        title: 'Duas condições',
        template:
          "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('pronto para envio'):elseShow('aguardando')}",
        data: j({ qty: 2, paid: true }),
        result: 'pronto para envio',
        note: 'Você pode usar `or` no lugar de `and`: `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Parte do texto conforme uma condição',
        template: 'Total{d.vat:ifEQ(true):showBegin}, impostos incluídos{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Total.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Ocultar parágrafos',
        template: L(
          'Fatura',
          '{d.paid:ifEQ(true):hideBegin}',
          'Pedimos que o pagamento seja feito em até 5 dias.',
          '{d.paid:hideEnd}',
          'Obrigado!',
        ),
        data: j({ paid: true }),
        result: L('Fatura', 'Obrigado!'),
        note: 'Os parágrafos que contêm as tags `hideBegin`/`hideEnd` também desaparecem.',
      },
      {
        id: 'cond-drop-p',
        title: 'Remover um parágrafo (drop)',
        template: L('antes', '{d.f:ifEQ(true):drop(p)}parágrafo que será removido', 'depois'),
        data: j({ f: true }),
        result: L('antes', 'depois'),
        note: 'Coloque a tag no próprio parágrafo e no fim da cadeia de formatadores. A condição é o resultado de `ifEQ`, `ifGT` e similares. Sem condição, decide o próprio valor: `true`, um número diferente de zero, um texto não vazio diferente de `"0"` e `"false"`, e uma lista não vazia removem o parágrafo; `false`, `0`, um texto vazio, `"0"`, `"false"`, e um valor vazio ou ausente não o removem: os indicadores 0/1 do banco de dados funcionam como estão. Funciona em DOCX, ODT, PPTX, ODP; XLSX e ODS não têm parágrafos.',
      },
      {
        id: 'cond-keep-p',
        title: 'Manter um parágrafo só se uma condição for verdadeira (keep)',
        template: L('antes', '{d.f:ifEQ(true):keep(p)}parágrafo que será mantido', 'depois'),
        data: j({ f: false }),
        result: L('antes', 'depois'),
        note: '`keep` é o contrário de `drop`: o parágrafo só é mantido se a condição for verdadeira. `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)` funcionam da mesma forma; no ODS também `drop(sheet)`, e no ODP `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Remover uma linha de tabela (drop(row))',
        template: L(
          '| Marca | Qtd. |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marca | Qtd. |', '| Fiat | 3 |', '| Fiat | 2 |', '| Jeep | 5 |'),
        note: 'A linha “Tesla” é removida por completo, e a formatação da tabela não se quebra. Ao contrário de `hideBegin`, `drop(row)` funciona em um loop. Se todas as linhas de uma tabela forem removidas, a tabela também desaparece. `drop(col)` remove uma coluna; no XLSX, as células mescladas e o filtro automático não são recalculados, e em uma planilha com uma tabela formatada (“Formatar como Tabela”) `drop(col)` não está disponível. Um indicador sem condição também funciona: `{d.cars[i].archived:drop(row)}` remove as linhas em que `archived` = 1 e mantém as que têm 0. Os acumulados, `:count()` e os totais `aggSum` sobre `[]` também contam as linhas removidas: para excluir uma linha tanto da tabela quanto do total, selecione as linhas com um filtro de loop e o mesmo filtro no total (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin em uma linha de tabela (não faça isso)',
        template: L(
          '| Marca | Qtd. |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marca | Qtd. |', '| Fiat | 3 |', '| |', '| Fiat | 2 |', '| Jeep | 5 |'),
        note: 'No lugar da linha “Tesla” fica uma linha vazia de uma única célula, e a formatação da tabela se quebra. Oculte as linhas com um filtro de loop (`{d.cars[i, ok=true].brand}`) ou com `drop(row)`.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Totais e numeração',
    intro: [
      'Os agregadores trabalham sobre todo o conjunto: `aggSum`, a soma; `aggAvg`, a média; `aggMin`/`aggMax`, o menor e o maior valor; `aggCount`, o número de elementos; `aggCountD`, o número de valores distintos; `aggStr`/`aggStrD`, os valores separados por vírgulas (`D`: sem repetições). As versões `cum…` (`cumSum`, `cumCount`, `cumCountD`) dão um acumulado pelas linhas do loop, e `:count()` dá o número da linha.',
      'Os colchetes do caminho escolhem o modo. `[]` é um total único sobre todo o array (em qualquer lugar do documento, também depois da tabela); `[sort>1]` ou `[ok=true]` é um total apenas sobre os elementos selecionados. `[i]` em um loop é um valor para cada linha; é justamente `[i]` que os acumulados, `:count()` e o agrupamento com `aggSum(.brand)` precisam.',
      'O resultado é um número sem arredondamento: formate-o com um formatador depois do agregador, por exemplo `:aggAvg:formatN(2)`. Os valores não numéricos (texto, vazio, `null`) são ignorados nas somas; um número em uma string (`"2"`) conta como número. Um array vazio ou uma chave ausente não causam erro: `aggSum`, `aggCount`, `aggCountD`, `cumSum` dão 0; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` dão um valor vazio.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Total fora de um loop',
        template: 'Total: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Total: 11',
        note: 'O total não depende do lugar da tag no documento nem de o mesmo array ser exibido com um loop.',
      },
      {
        id: 'agg-filter',
        title: 'Total com um filtro',
        template: 'Pago: {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Pago: 10',
        note: "As condições entre colchetes são as mesmas de um loop: `[qty>1]`, `[brand='Fiat']`, várias separadas por vírgulas. Um filtro de loop no documento não afeta o total, mas um filtro na própria tag, sim.",
      },
      {
        id: 'agg-others',
        title: 'Média, máximo, quantidade',
        template: L(
          'Elementos: {d.cars[].qty:aggCount}, média {d.cars[].qty:aggAvg:formatN(2)}',
          'Maior {d.cars[].qty:aggMax}, menor {d.cars[].qty:aggMin}',
          'Marcas distintas: {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L('Elementos: 4, média 2,75', 'Maior 5, menor 1', 'Marcas distintas: 3'),
        note: '`aggCount` conta todos os elementos, e `aggCountD`, os valores distintos. Um formatador também pode vir antes do agregador: `{d.cars[].qty:mul(2):aggSum}` soma os valores dobrados.',
      },
      {
        id: 'agg-str',
        title: 'Valores em uma linha',
        template: L(
          "Marcas: {d.cars[].brand:aggStrD(', ')}",
          "Todas: {d.cars[].brand:aggStr(' | ')}",
        ),
        data: j({ cars: CARS }),
        result: L('Marcas: Tesla, Fiat, Jeep', 'Todas: Fiat | Tesla | Fiat | Jeep'),
        note: 'Sem argumento, o separador é uma vírgula seguida de um espaço. `aggStrD` ordena os valores pela sua última ocorrência.',
      },
      {
        id: 'agg-total-row',
        title: 'Linha “Total” abaixo de uma tabela',
        template: L(
          '| Marca | Qtd. |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Total | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Qtd. |',
          '| Fiat | 3 |',
          '| Tesla | 1 |',
          '| Fiat | 2 |',
          '| Jeep | 5 |',
          '| Total | 11 |',
        ),
        note: 'Faça da linha “Total” uma linha normal do Word abaixo da linha `[i+1]`. Se você escrever `{d.cars[i].qty:aggSum}` na linha do loop, cada linha mostra o mesmo total geral: `[i]` abrange todo o conjunto, não as linhas de cima.',
      },
      {
        id: 'agg-cum',
        title: 'Acumulado',
        template: L(
          '| Marca | Qtd. | Acumulado |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Qtd. | Acumulado |',
          '| Fiat | 3 | 3 |',
          '| Tesla | 1 | 4 |',
          '| Fiat | 2 | 6 |',
          '| Jeep | 5 | 11 |',
        ),
        note: 'O acumulado segue a ordem e o conjunto de linhas indicados pelos colchetes da própria tag `cumSum`. Se o loop estiver filtrado ou ordenado (`[i, ok=true]`, `[qty, i]`), repita as mesmas condições, incluindo a ordenação, nos colchetes da tag do acumulado: a ordenação do loop não se aplica a ela. Com `[]` no lugar de `[i]` ocorre um erro no modelo.',
      },
      {
        id: 'agg-partition',
        title: 'Total do grupo em uma linha',
        template: L(
          '| Marca | Qtd. | Por marca | Nº na marca |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Qtd. | Por marca | Nº na marca |',
          '| Fiat | 3 | 5 | 1 |',
          '| Tesla | 1 | 1 | 1 |',
          '| Fiat | 2 | 5 | 2 |',
          '| Jeep | 5 | 5 | 1 |',
        ),
        note: 'O argumento `(.brand)` é um caminho a partir do elemento do loop: o agregador conta separadamente para cada valor. Só funciona em um loop `[i]`; os valores são comparados de forma estrita: o número 1 e a string "1" são grupos diferentes. O argumento deve ser um caminho com ponto; `aggSum(brand)` é um erro.',
      },
      {
        id: 'agg-nested',
        title: 'Subtotal sobre um array aninhado',
        template: L(
          '{d.groups[i].name}: {d.groups[i].items[].qty:aggSum}',
          '- {d.groups[i].items[i].x} {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
          'Total: {d.groups[].items[].qty:aggSum}',
        ),
        data: j({
          groups: [
            {
              name: 'G1',
              items: [
                { x: 'a', qty: 2 },
                { x: 'b', qty: 3 },
              ],
            },
            { name: 'G2', items: [{ x: 'c', qty: 4 }] },
            { name: 'G3', items: [] },
          ],
        }),
        result: L('G1: 5', '- a 2', '- b 3', 'G2: 4', '- c 4', 'G3: 0', 'Total: 9'),
        note: '`[i]` no array externo e `[]` no aninhado dão um subtotal em cada grupo; um grupo vazio dá 0. Dois `[]` seguidos dão o total geral de todos os grupos. Não é possível agrupar para subtotais com um loop externo sobre um campo como `[brand]`: agrupe com `:set` e calcule `aggSum` por grupo (o exemplo “Subtotais por grupo (:set)” da seção “Totais e agrupamento”) ou no SQL. Se o caminho aninhado passar por um objeto (`{d.items[].sub.qty:aggSum}`), há um erro com `[]`: traga o campo para cima com `print(.sub.qty)` ou use `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Totais e agrupamento',
    intro: [
      'Os totais, os subtotais e a numeração também podem ser feitos no modelo: veja a seção “Totais e numeração”. Os grupos com subtotais também são construídos no modelo (`:set` + `aggSum`). O SQL é necessário onde o modelo não basta: filtrar com uma condição OU e ordenar de forma decrescente; em conjuntos muito grandes (dezenas de milhares de linhas), os totais com um filtro entre colchetes são calculados mais rápido no SQL.',
      'Os números do PostgreSQL (`numeric`, `bigint`) chegam aos dados como números, `date` como uma string YYYY-MM-DD e `json` como objetos e arrays.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Total em uma consulta separada',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Itens: {d.totals.positions}, valor total {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Itens: 3, valor total R$ 13.775,00',
        note: 'O número de elementos de um array também pode ser obtido no modelo: `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Número da linha a partir do SQL',
        sql: {
          key: 'items',
          mode: 'list',
          text: L(
            'select row_number() over (order by id) as n, name, qty',
            'from invoice_items',
            'where invoice_id = :invoiceId',
            'order by id',
          ),
        },
        template: L(
          '| Nº | Item | Qtd. |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Papel sulfite', qty: 10 },
            { n: 2, name: 'Cartucho de toner', qty: 2 },
            { n: 3, name: 'Canetas', qty: 50 },
          ],
        }),
        result: L(
          '| Nº | Item | Qtd. |',
          '| 1 | Papel sulfite | 10 |',
          '| 2 | Cartucho de toner | 2 |',
          '| 3 | Canetas | 50 |',
        ),
        note: 'Selecione as linhas no `where`, e não com um filtro do modelo: assim a numeração não tem lacunas.',
      },
      {
        id: 'totals-groups',
        title: 'Grupos com subtotais (json_agg)',
        sql: {
          key: 'groups',
          mode: 'list',
          text: L(
            'select c.name as company,',
            '       sum(it.qty * it.price) as subtotal,',
            "       json_agg(json_build_object('name', it.name, 'qty', it.qty) order by it.id) as items",
            'from invoice_items it',
            'join invoices i on i.id = it.invoice_id',
            'join company c on c.id = i.company_id',
            'group by c.id, c.name',
            'order by c.id',
          ),
        },
        template: L(
          '{d.groups[i].company} — {d.groups[i].subtotal:formatC()}',
          '- {d.groups[i].items[i].name}: {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].name}',
          '{d.groups[i+1].company}',
        ),
        data: j({
          groups: [
            {
              company: 'Silva Ltda.',
              subtotal: 13775,
              items: [
                { name: 'Papel sulfite', qty: 10 },
                { name: 'Cartucho de toner', qty: 2 },
                { name: 'Canetas', qty: 50 },
              ],
            },
            {
              company: 'Exemplo S.A.',
              subtotal: 34300,
              items: [
                { name: 'Escrivaninha', qty: 1 },
                { name: 'Cadeira', qty: 2 },
                { name: 'Luminária de mesa', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'Silva Ltda. — R$ 13.775,00',
          '- Papel sulfite: 10',
          '- Cartucho de toner: 2',
          '- Canetas: 50',
          'Exemplo S.A. — R$ 34.300,00',
          '- Escrivaninha: 1',
          '- Cadeira: 2',
          '- Luminária de mesa: 3',
        ),
        note: 'O subtotal do grupo é calculado por `sum(…)`, e o conteúdo do grupo é reunido por `json_agg`. O total geral é uma consulta separada no modo “Uma linha”.',
      },
      {
        id: 'totals-set-group',
        title: 'Agrupamento no modelo (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('Fiat', '- Fiat 3', '- Fiat 2', 'Tesla', '- Tesla 1', 'Jeep', '- Jeep 5'),
        note: 'Os grupos seguem a ordem da primeira ocorrência; a tag `:set` não mostra nada. Guarde o objeto inteiro (`d.cars[]:set(…rows[])`), não campos soltos. O subtotal do grupo é `aggSum` sobre as suas linhas: veja o exemplo seguinte.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Subtotais por grupo (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id} — qtd. {c.g[i].rows[].qty:aggSum}',
          '{c.g[i+1].id}',
          'Quantidade total: {d.cars[].qty:aggSum}',
        ),
        data: j({ cars: CARS }),
        result: L('Fiat — qtd. 5', 'Tesla — qtd. 1', 'Jeep — qtd. 5', 'Quantidade total: 11'),
        note: '`:set` reúne as linhas por marca, e `{c.g[i].rows[].qty:aggSum}` é o subtotal de cada grupo. `aggCount`, `aggAvg` e os demais agregadores funcionam da mesma forma, e as linhas do grupo podem ser exibidas com um loop aninhado, como no exemplo anterior.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Soma com :set (incorreto)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Total: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Total: 14',
        note: 'O total correto é 11: o primeiro elemento é contado duas vezes. Calcule as somas com o agregador `aggSum` (a seção “Totais e numeração”) ou no SQL.',
      },
    ],
  },
  {
    id: 'media',
    title: 'Imagens, códigos de barras, cores, links',
    intro: [
      'Uma imagem ou um código de barras dos dados substitui uma imagem de espaço reservado. Insira no modelo qualquer imagem do tamanho adequado e escreva a tag no texto alternativo dela: no Word, pelo texto alternativo da imagem (clique com o botão direito na imagem → “Exibir Texto Alt”); no LibreOffice, “Propriedades” → aba “Opções” → o campo de texto alternativo ou “Descrição”; no editor de modelos, as configurações avançadas da imagem → “Texto alternativo” → “Descrição”. A tag deve ocupar todo o texto alternativo: um texto misto (“Foto {d.name}”) é exibido como está, e a imagem permanece. A mesma tag em um parágrafo normal simplesmente mostra o valor.',
      'Uma imagem nos dados é um data URI (`data:image/png;base64,…`; PNG, JPEG ou GIF) ou um endereço `https://…`. Os endereços só são carregados dos hosts do parâmetro `IMAGE_URL_ALLOWLIST`; por padrão ele está vazio, e um endereço dá um erro no modelo. SVG não é suportado. Um valor vazio remove a imagem de espaço reservado. Limites: 10 MB por imagem e 50 MB por relatório. Funciona em DOCX, XLSX, PPTX, ODT, ODS, ODP; várias imagens em um loop funcionam no DOCX (imagem “Alinhado com o Texto”) e no ODT (ancorada “Como caractere”).',
      'Um valor de texto simples (nem `data:` nem `http(s)://`) é escrito no texto alternativo, e a imagem permanece; um valor vazio remove a imagem. Uma imagem inválida (data URI corrompido, host que não está na lista, tag incorreta) é um erro no modelo com a tag no texto, e o relatório não é gerado. Se não foi possível carregar uma imagem de um endereço (tempo esgotado, resposta diferente de 2xx), ela é removida e o relatório é gerado.',
    ],
    examples: [
      {
        id: 'media-image',
        title: 'Imagem dos dados',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result:
          'A imagem de espaço reservado é substituída pela imagem: a largura é a do espaço reservado, e a altura segue as proporções da imagem.',
        note: 'A tag fica no texto alternativo da imagem, não em um parágrafo. No lugar de um data URI, você pode passar um endereço `https://…` se o host dele estiver em `IMAGE_URL_ALLOWLIST`.',
      },
      {
        id: 'media-image-fit',
        title: 'Ajustar uma imagem ao quadro (imageFit)',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result:
          'A imagem inteira cabe no quadro da imagem de espaço reservado, com as suas proporções.',
        note: '`fillWidth` (padrão): a largura do quadro, a altura pelas proporções; `contain`: encaixar a imagem inteira; `fill`: esticá-la para todo o quadro.',
      },
      {
        id: 'media-qrcode',
        title: 'Código QR',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'FAT-2026-0042' }),
        result:
          'A imagem de espaço reservado é substituída por um código QR com o valor FAT-2026-0042.',
        note: 'Outros tipos: `ean13`, `code128`, `datamatrix`, `pdf417` e os demais da documentação do Carbone. As opções são separadas por vírgulas: `{d.v:barcode(ean13, includetext:true, scale:2)}`; `width` e `height` estão em mm, `scale` vai de 1 a 10 (3 por padrão), as cores `barcolor`, `textcolor`, `backgroundcolor` têm o formato `#RRGGBB`, e `eclevel:H` é para QR. Um valor que não pode ser codificado (letras em `ean13`) é um erro no modelo. `barcode` em um texto normal é um erro no modelo que indica que um código de barras vai no texto alternativo de uma imagem; as fontes de códigos de barras não são compatíveis.',
      },
      {
        id: 'media-color-cell',
        title: 'Cor da célula a partir dos dados (:color)',
        template: L(
          '| Tarefa | Status |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: 'Relatório', status: 'concluída', color: '#C6EFCE' },
            { name: 'Conciliação', status: 'atrasada', color: 'FFC7CE' },
          ],
        }),
        result: L('| Tarefa | Status |', '| Relatório | concluída |', '| Conciliação | atrasada |'),
        note: 'A tag não mostra nada; ela colore o elemento em que está: `color(p)`, o parágrafo (padrão); `cell`, a célula; `row`, a linha da tabela; `shape`, a forma (PPTX, ODP, ODT); `part`, um trecho de texto (só ODT). O segundo argumento indica o que colorir: `text` (padrão), `background`, `highlight` (não no DOCX), `border`: o contorno da forma (PPTX). No DOCX, só `text` e `background`, e `shape` não é suportado; no PPTX, `p` com `background` não é suportado. A cor é escrita com 6 dígitos hexadecimais, com ou sem `#`; qualquer outro valor dá cinza `#888888`. No XLSX e no ODS é um erro no modelo.',
      },
      {
        id: 'media-default-url',
        title: 'Link de reserva (:defaultURL)',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: 'não é um endereço' }),
        result: 'https://example.com',
        note: "Normalmente, a tag serve como endereço de um hiperlink: no Word, “Inserir” → “Link”, e no campo “Endereço”, `{d.site:defaultURL('https://example.com')}`. Um endereço de link dos dados é verificado: `https://` é adicionado se não houver esquema; são permitidos `http`, `https`, `mailto`, `tel`. Um endereço inválido (`javascript:`, `localhost`, um endereço IP ou um nome sem domínio de nível superior, como `http://server:8080`) é substituído pelo valor de `:defaultURL` (pode ser um campo: `:defaultURL(.fallback)`), ou por `#` se não houver. Os endereços relativos e as âncoras (`#section`, `../file.pdf`) também viram `#`. Em um endereço com uma parte fixa (`https://site.com/?id={d.id}`), o valor da tag é codificado e o endereço inteiro é verificado; uma tag no início do endereço (`{d.base}/items/{d.id}`) é inserida como está.",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Gráficos do Word e do Excel',
    intro: [
      'Os gráficos do Word e do Excel são preenchidos com os dados do relatório. Desenhe o gráfico como de costume e escreva tags nos dados dele como linhas de loop, como em uma tabela: uma linha com `[i]` e, abaixo, uma linha com `[i+1]`. No Word, as tags ficam na planilha de dados do gráfico: clique com o botão direito no gráfico → “Editar Dados”. No Excel, elas ficam nas células da planilha a que o gráfico se refere.',
      'Depois que o relatório é gerado, as séries do gráfico abrangem todas as linhas de dados, e os valores guardados no gráfico são recalculados: o gráfico fica correto tanto no PDF quanto ao abri-lo no Word ou no Excel. No Word, “Editar Dados” mostra os dados do relatório. As linhas abaixo do loop se deslocam junto com as referências a elas. Um array vazio dá um gráfico sem pontos. Todos os tipos habituais funcionam: colunas e barras, linhas, áreas, pizza e rosca, dispersão e bolhas, gráficos de combinação, 2D e 3D.',
      'Números: uma célula de uma série de valores vira número se o valor parecer um número. Os espaços e os espaços não separáveis são removidos, e uma vírgula ou um ponto servem de separador decimal: `1234,5`, `1 234,5`, `-3`, `1e3`. Qualquer outro valor (`10%`, `abc`, vazio) fica como texto e não tem ponto no gráfico. Os rótulos de categoria não mudam. No Excel, `:formatN` funciona como sempre.',
      'Não é compatível: os novos tipos do Office 2016 (Treemap, Explosão Solar, histograma de distribuição, Caixa e Caixa Estreita etc.), os loops por colunas e um número de séries tirado dos dados (as séries são definidas pelo modelo), os rótulos de categoria de vários níveis, as tabelas do Excel (“Formatar como Tabela”) e os intervalos nomeados (não se expandem), os gráficos vinculados a um arquivo externo, os gráficos em PPTX, ODT, ODS, ODP. Os gráficos ECharts (`:chart`) são descritos na seção “Gráficos ECharts”.',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Gráfico no Word',
        template: L(
          '| | Valor |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', sum: 10 },
            { month: 'Fev', sum: 25 },
            { month: 'Mar', sum: 7 },
          ],
        }),
        result: L('| | Valor |', '| Jan | 10 |', '| Fev | 25 |', '| Mar | 7 |'),
        note: 'A tabela é a planilha “Editar Dados” de um gráfico do Word como fica depois que o relatório é gerado. O gráfico mostra a série “Valor” com três colunas: Jan, Fev, Mar. A célula acima das tags pode ficar vazia; o nome da série fica na primeira linha.',
      },
      {
        id: 'chart-excel',
        title: 'Gráfico no Excel: duas séries, números a partir de texto',
        template: L(
          '| Mês | Previsto | Realizado |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', plan: 100, fact: '98,5' },
            { month: 'Fev', plan: 120, fact: '1 250' },
            { month: 'Mar', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| Mês | Previsto | Realizado |',
          '| Jan | 100 | 98,5 |',
          '| Fev | 120 | 1 250 |',
          '| Mar | 150 | |',
        ),
        note: 'A tabela representa as células da planilha do Excel a que o gráfico se refere. As séries “Previsto” e “Realizado” abrangem três linhas. O texto `98,5` e `1 250` dos dados vira os números 98,5 e 1250, e “Realizado” não tem ponto para março. Um ponto também conta como separador decimal: `1.250` vira 1,25, e `1.234,5` fica como texto; passe os números sem pontos de milhar.',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'Gráficos ECharts',
    intro: [
      'Um gráfico ECharts é desenhado no lugar de uma imagem de espaço reservado, em DOCX, XLSX, PPTX, ODT, ODS, ODP. Insira no documento qualquer imagem do tamanho adequado e escreva a tag `{d.charts.sales:chart}` no texto alternativo dela, como com as imagens: no Word e no Excel, pelo texto alternativo da imagem (clique com o botão direito → “Exibir Texto Alt”); no LibreOffice, “Propriedades” → “Opções” → o campo de texto alternativo (no Calc e no Impress, “Título”). Sem `width`/`height` na definição, o gráfico assume o tamanho da imagem; com eles, a imagem mantém a largura do espaço reservado, e a altura segue as proporções do gráfico. `:imageFit(contain)` e `:imageFit(fill)` funcionam como com as imagens.',
      'O mais simples é o editor de gráficos: a aba “Gráficos” do editor de modelos. Escolha uma consulta no modo “Lista de linhas”, a coluna de rótulos e as colunas das séries (ou “Séries a partir dos dados”: a coluna que distribui as linhas em séries), o tipo, o título, a legenda, a paleta e o formato dos números; a pré-visualização é construída com dados de teste. A definição do gráfico é guardada nos dados do relatório sob a chave `d.charts.<chave>`; a tag é copiada com o botão “Copiar” e aparece na aba “Documento”.',
      'Você pode passar uma definição do ECharts 5 já pronta a partir do SQL: o valor da tag é `{ "type": "echarts@v5", "option": { … } }` ou a própria definição com `series`; uma string com JSON também funciona. `width` e `height` (100–4000) definem o tamanho lógico da tela: as fontes do ECharts são medidas nesses pixels, então um tamanho maior dá um texto menor; sem eles, é usado o tamanho da imagem. `theme` é `"dark"` ou um objeto de tema. O fundo é branco por padrão.',
      'Limites: a definição ocupa no máximo 1 MB, no máximo 20 séries e 10.000 pontos, e é desenhada em no máximo 5 s; as funções na definição não funcionam (só JSON); a fonte é sempre Noto Sans, e as demais fontes da definição são substituídas por ela. As imagens na definição (`graphic`, `symbol: "image://…"`, padrões, chaves `image`) só podem ser `data:image/png|jpeg|gif;base64,…`; um endereço, um caminho de arquivo ou SVG é um erro no modelo. Nos gráficos do editor, os rótulos de data são exibidos no formato DD.MM.YYYY a partir da data dos dados, sem conversão de fuso horário: para agrupar por dia, converta a hora em data no SQL (`created::date`). Um valor vazio remove a imagem de espaço reservado. Uma definição inválida é um erro no modelo com a tag; uma tag `:chart` em um texto normal é um erro no modelo que indica que um gráfico vai no texto alternativo de uma imagem.',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: 'Gráfico do editor de gráficos',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['Jan', 'Fev', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: 'Valor', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result:
          'A imagem de espaço reservado é substituída por um gráfico de colunas “Valor” para os meses Jan, Fev, Mar; o tamanho é o do espaço reservado.',
        note: 'Assim são os dados que o editor de gráficos prepara (a aba “Gráficos”): `d.charts.<chave>` é construído a partir das linhas da consulta a cada geração do relatório e na pré-visualização.',
      },
      {
        id: 'echarts-sql',
        title: 'Definição pronta a partir do SQL',
        picture: true,
        template: '{d.report.chart:chart}',
        data: j({
          report: {
            chart: {
              series: [
                {
                  type: 'pie',
                  radius: '70%',
                  data: [
                    { name: 'Norte', value: 120 },
                    { name: 'Sul', value: 80 },
                  ],
                },
              ],
            },
          },
        }),
        sql: {
          key: 'report',
          mode: 'single',
          text: L(
            'select json_build_object(',
            "  'series', json_build_array(json_build_object(",
            "    'type', 'pie',",
            "    'radius', '70%',",
            "    'data', (select json_agg(json_build_object('name', region, 'value', total)) from sales)",
            '  ))',
            ') as chart',
          ),
        },
        result:
          'A imagem de espaço reservado é substituída por um gráfico de pizza: Norte, 120; Sul, 80.',
        note: 'Uma definição sem `type` nem `option`, mas com `series`, é tratada como uma definição do ECharts. Em uma consulta no modo “Uma linha”, a coluna `chart` vira `d.report.chart`.',
      },
      {
        id: 'echarts-size',
        title: 'Tamanho da tela e tema escuro',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['Seg', 'Ter', 'Qua'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          'A imagem de espaço reservado é substituída por um gráfico de linhas sobre fundo escuro; a largura é a do espaço reservado, e a altura segue as proporções 800×400.',
        note: 'Sem `width`/`height`, a tela coincide com a imagem de espaço reservado. O tipo `echarts@v5a` também é desenhado com o ECharts 5.',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.field:html}` insere HTML formatado a partir dos dados: parágrafos, títulos, listas, tabelas, links, imagens. Funciona em DOCX e ODT (no texto, nas células de tabela, nos cabeçalhos e nos rodapés) e no PDF gerado a partir deles. Em um modelo HTML, o valor é inserido como está. Em XLSX, PPTX, ODS, ODP é um erro no modelo que indica que html não é compatível com esse formato.',
      'A tag fica no texto de um parágrafo: em um texto alternativo, um endereço de link ou o nome do relatório, é um erro no modelo que indica que html vai no texto de um parágrafo. `:html` é o último formatador da tag: nenhum outro formatador pode vir depois dele. Sem opções, o HTML é inserido como parágrafos independentes no lugar da tag; o texto do parágrafo antes e depois da tag fica em parágrafos próprios. Depois de cada parágrafo, título, lista e tabela é adicionado um parágrafo vazio. A fonte, o tamanho, a cor e o alinhamento vêm da tag: formate a tag no modelo, e o HTML recebe a mesma formatação. Se o HTML definir a mesma propriedade, prevalece a tag.',
      'Tags de texto: `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`, `mark` (realce amarelo), `code`/`kbd`/`samp` (Courier New). Blocos: `p`, `br`, `pre`, `hr`, `blockquote`, títulos `h1`–`h6` (os estilos “Título 1”–“Título 6”), listas `ul`/`ol`/`li` com aninhamento, tabelas `table`/`tr`/`th`/`td` com `colspan` e `rowspan`, links `a href`, imagens `img`, caixas de seleção `<input type="checkbox" checked>`. Do CSS, só o atributo `style` com as propriedades `color`, `background-color`, `break-before: page` e `break-after: page`. As demais tags, classes e estilos são removidos, e o texto permanece; `script` e `style` são removidos junto com o seu conteúdo.',
      'Opções, separadas por vírgulas: `inline`, dentro do parágrafo atual; `nospace`, sem parágrafos vazios; `headingtheme:<prefixo>`, estilos de título `<prefixo>1`…`<prefixo>6`; `tabletheme:<estilo>`, estilo de tabela (só DOCX); `quotetheme:<estilo>`, estilo de citação. Por exemplo, `{d.h:html(nospace, tabletheme:TableGrid)}`. Uma opção desconhecida é um erro no modelo.',
      'A imagem `img`: `src` é um data URI (PNG, JPEG, GIF) ou um endereço em um host de `IMAGE_URL_ALLOWLIST`, como na seção “Imagens, códigos de barras, cores, links”. O tamanho é indicado com `width` e `height` em pixels; sem eles, a largura é de 5 cm, com as proporções mantidas. Uma imagem inválida ou uma falha de carregamento faz com que a imagem seja omitida com um aviso no log da API, e o relatório é gerado; uma imagem de mais de 10 MB é um erro no modelo.',
      'Um valor vazio não insere nada. Um valor de mais de 1 MB, um aninhamento de tags de mais de 32 níveis ou mais de 4096 tags não fechadas é um erro no modelo. Uma tabela tem no máximo 63 colunas: o conteúdo das células excedentes vai para a última. Com `inline` dentro de um hiperlink do modelo, os links do HTML viram texto simples. No ODT, as caixas de seleção são os caracteres ☒ e ☐ (no DOCX são caixas de seleção do Word), `tabletheme` não tem efeito, e um título dentro de um item de lista vira um texto de item grande e em negrito.',
    ],
    examples: [
      {
        id: 'html-text',
        title: 'Parágrafos e formatação do texto',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>A fatura está <b>paga</b>.</p><p>Prazo: <i>5 dias</i>, <span style="color:#C00000">sem adiantamento</span>.</p>',
        }),
        result: L(
          'Dois parágrafos, cada um seguido de um parágrafo vazio:',
          'A fatura está paga.',
          'Prazo: 5 dias, sem adiantamento.',
          '“paga” está em negrito, “5 dias” em itálico e “sem adiantamento” em vermelho.',
        ),
        note: 'A tag está em um parágrafo separado: todo o HTML recebe a formatação dela (fonte, tamanho, alinhamento). A opção `nospace` remove os parágrafos vazios.',
      },
      {
        id: 'html-list',
        title: 'Listas',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>Entrega</li><li>Instalação<ul><li>andar 1</li><li>andar 2</li></ul></li></ul><ol><li>Assinar o termo de recebimento</li><li>Pagar</li></ol>',
        }),
        result: L(
          '• Entrega',
          '• Instalação',
          '    ◦ andar 1',
          '    ◦ andar 2',
          '1. Assinar o termo de recebimento',
          '2. Pagar',
        ),
        note: 'Marcadores por nível: •, ◦, ▪; números: 1., a., i. Cada lista é numerada de novo, também em cada linha de um loop. O item `<li><input type="checkbox" checked> feito</li>` é exibido como uma caixa de seleção sem marcador.',
      },
      {
        id: 'html-table',
        title: 'Tabela',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>Produto</th><th>Qtd.</th></tr><tr><td>Cabo</td><td>10</td></tr><tr><td colspan="2">Total: 10</td></tr></table>',
        }),
        result: L('| Produto | Qtd. |', '| Cabo | 10 |', '| Total: 10 |'),
        note: 'A tabela ocupa toda a largura do texto com colunas iguais, `th` em negrito, e “Total” abrange duas colunas. No DOCX, o estilo `tabletheme`; senão, o estilo de tabela padrão do documento (exceto a tabela normal sem bordas); senão, uma tabela com grade (bordas contínuas); no ODT, bordas finas. Um `caption` vira um parágrafo acima da tabela.',
      },
      {
        id: 'html-link',
        title: 'Links e endereço de reserva',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>O contrato está <a href="site.com/doc">no site</a>, o guia está <a href="javascript:alert(1)">aqui</a>.</p>',
        }),
        result: L(
          'O contrato está no site, o guia está aqui.',
          '“no site” leva a https://site.com/doc, e “aqui”, a https://example.com.',
        ),
        note: 'Os endereços são verificados como os links do modelo: `https://` é adicionado se não houver esquema; são permitidos `http`, `https`, `mailto`, `tel`. Um endereço inválido (`javascript:`, `localhost`, uma âncora `#section`) é substituído pelo valor de `:defaultURL`, ou por `#` se não houver.',
      },
      {
        id: 'html-inline',
        title: 'Dentro de um parágrafo (inline)',
        rich: true,
        template: 'Status: {d.status:html(inline)}, veja acima.',
        data: j({ status: '<b>paga</b> <i>em parte</i>' }),
        result: L(
          'Status: paga em parte, veja acima.',
          'Um único parágrafo; “paga” em negrito, “em parte” em itálico.',
        ),
        note: 'No modo `inline` só funcionam `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u`. As demais tags são removidas e o texto permanece; `br` e os limites de parágrafo viram espaços.',
      },
      {
        id: 'html-nospace',
        title: 'Títulos sem parágrafos vazios (nospace)',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>Condições</h2><p>Pagamento em até 5 dias.</p>' }),
        result: L(
          'Condições: estilo “Título 2”',
          'Pagamento em até 5 dias.',
          'Não há nenhum parágrafo vazio entre eles nem depois.',
        ),
        note: 'Um estilo de título que não existe no modelo é criado de forma simples: negrito, 20/16/14/13/12/11 pt para `h1`–`h6`. Use os seus próprios estilos com a opção `headingtheme:<prefixo>`: `{d.terms:html(headingtheme:Report)}` usa os estilos `Report1`…`Report6`.',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF: PDF/A, marca-d’água, números de página, anexos, senha',
    intro: [
      'As configurações do PDF são definidas na aba “PDF” do editor de modelos e se aplicam ao PDF do relatório: na pré-visualização, na geração e no download. “Salvar como” DOCX/XLSX… dá um arquivo sem elas.',
      'PDF/A-2b é um formato para arquivamento e troca eletrônica de documentos. Quando o PDF/A está ativado, os anexos também precisam estar no formato PDF/A (isso é lido nos metadados do arquivo).',
      'A marca-d’água e os metadados (título, autor, assunto, palavras-chave) podem conter tags `{d.field}` e `{d.list[0].field}`, sem formatadores nem loops. Um valor de tag vazio na marca-d’água remove a marca-d’água: assim, “RASCUNHO” só aparece nos documentos que ainda não foram aprovados. Os caracteres dos dados que não estão na fonte do PDF (por exemplo, emoji) são substituídos por “?”.',
      'A numeração de páginas abrange todo o documento com os anexos: `{page}` é o número da página e `{pages}`, o número total de páginas; a primeira página pode ficar sem número. Os PDFs anexos (até 10 arquivos de 20 MB cada, 500 páginas no total) são adicionados no início ou no fim do relatório; arquivos protegidos por senha não são aceitos.',
      'Proteção: uma senha de abertura (uma por modelo, de 4 a 64 caracteres, que não comece com “-”) e restrições de impressão, de cópia do texto e de alteração. As restrições sem senha não bloqueiam o documento: quem as aplica são os leitores de PDF. A proteção se aplica aos relatórios gerados; a pré-visualização é exibida sem ela. PDF/A e a proteção são incompatíveis. A senha é guardada criptografada, não é exibida na caixa de diálogo e não é transferida ao mover o modelo para outro ambiente: defina-a lá novamente.',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'Número do documento no título do PDF',
        template: 'Fatura nº {d.number}',
        data: j({ number: '42', status: 'RASCUNHO' }),
        result: 'Fatura nº 42',
        note: 'A mesma tag no campo “Título” da aba “PDF” dá o título de documento “Fatura nº 42”, e `{d.status}` no campo da marca-d’água dá a marca-d’água “RASCUNHO”. Os formatadores (`{d.sum:formatC}`) não são compatíveis nos campos do PDF.',
      },
    ],
  },
  {
    id: 'signature',
    title: 'Assinatura eletrônica',
    intro: [
      'A assinatura do PDF tem o formato PAdES com o certificado do usuário a partir de um arquivo `.p12` (`.pfx`). Pela lei federal russa nº 63-FZ, é uma assinatura eletrônica avançada não qualificada: a sua validade jurídica dentro da organização e com os parceiros decorre de um acordo entre as partes.',
      'Método de assinatura: na aba “PDF”, o campo “Método de assinatura” oferece “Certificado .p12 (assinatura no PDF)” ou “GOST, CryptoPro (arquivo .sig)”. Com GOST, a chave permanece no computador do usuário: são necessários o CryptoPro CSP 5.0, o CryptoPro CAdES Browser plug-in com a extensão do navegador e um certificado GOST R 34.10-2012 no repositório “Pessoal”; o resultado é um PDF com carimbo e uma assinatura `.sig` separada. O administrador coloca o script `cadesplugin_api.js` (não o fornecemos); os detalhes estão em `docs/operations/gost-signature.md`; sem ele, a caixa de diálogo de assinatura informa que o plug-in não foi encontrado. O servidor verifica a assinatura, mas não a cadeia de certificados nem a revogação: verifique-as no portal russo de serviços públicos Gosuslugi (gosuslugi.ru/pgu/eds).',
      'Ativação: a aba “PDF” do editor de modelos → “Assinatura eletrônica” → “Permitir a assinatura do PDF”, e depois a posição do carimbo (embaixo à esquerda, embaixo no centro, embaixo à direita). A assinatura é incompatível com a senha e as restrições do bloco “Proteção”; é compatível com PDF/A. As configurações se aplicam aos relatórios novos; as execuções anteriores não mudam.',
      'Assinar: o usuário carrega o seu certificado na página “Minha assinatura”, gera o relatório e clica em “Assinar PDF” (ou em “Assinar…” no histórico). A senha da chave é digitada a cada assinatura e nunca é guardada; após cinco senhas incorretas em 15 minutos, a assinatura fica bloqueada até o fim desse período. Só o usuário que gerou uma execução pode assiná-la; uma execução não pode ser assinada duas vezes. O arquivo assinado: “Baixar PDF assinado”, ou “PDF assinado” no histórico.',
      'O carimbo é um quadro de 250 × 80 pt na parte inferior da última página (à esquerda, no centro ou à direita), sobre o conteúdo: número de série, titular, período de validade do certificado, hora da assinatura. A área da página que fica embaixo dele não é apagada: deixe 110 pt livres na parte inferior da última página.',
      'Carimbo de tempo: se o administrador configurou um serviço de carimbo de tempo (`SIGN_TSA_URL`), ele confirma a hora da assinatura; se o serviço estiver indisponível, o relatório não é assinado: o erro “o serviço de carimbo de tempo está indisponível”.',
      'Verificação: o Adobe Acrobat Reader mostra a assinatura no painel “Assinaturas”. Ela é “válida” se o destinatário confiar no certificado da autoridade certificadora; para os certificados autoassinados e internos, adicione o certificado raiz aos certificados confiáveis.',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: 'Não disponível na versão gratuita',
    intro: [
      'Estas tags estão desativadas na versão gratuita do Carbone. Se uma delas estiver no modelo, o relatório e a pré-visualização não são gerados, e é exibido o erro do exemplo.',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: 'Nomes de regiões (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'BR' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Obtenha o nome de uma tabela de referência no SQL.',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead:
          'Desativado; um modelo que o usa não é gerado. Uma imagem dos dados é inserida como está: gire-a antes de passá-la ao relatório.',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          'O antigo `bindColor` não causa erro, mas também não muda a cor. Use `:color` (a seção “Imagens, códigos de barras, cores, links”).',
      },
      {
        id: 'na-svg',
        title: 'SVG e fontes de códigos de barras',
        instead:
          'Uma imagem SVG dos dados é um erro no modelo que indica que SVG não é suportado: passe PNG, JPEG ou GIF. As fontes de códigos de barras não são suportadas: use `:barcode` em uma imagem de espaço reservado.',
      },
      {
        id: 'na-sort-desc',
        title: 'Ordem decrescente',
        instead:
          '`[-qty, i]` mantém silenciosamente a ordem original: o Carbone ainda não sabe fazer isso. Ordene no SQL: `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'Saída TXT',
        instead:
          'O texto em cirílico vira “??????”. O nosso sistema não tem o formato TXT: use PDF ou DOCX.',
      },
    ],
  },
];
