import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API message for a disabled formatter (apps/api/src/modules/carbone/community.ts, errors catalog). */
const community = (name: string) =>
  `la plantilla usa ${name}, que no está disponible en la versión gratuita de Carbone; consulte «Ayuda sobre plantillas»`;

const CARS = [
  { brand: 'Seat', qty: 3, ok: true },
  { brand: 'Tesla', qty: 1, ok: false },
  { brand: 'Seat', qty: 2, ok: true },
  { brand: 'Cupra', qty: 5, ok: true },
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
  'Esta página describe solo lo que se ha comprobado en nuestro Carbone: la versión gratuita (Community Edition). Todo lo que le falta se reúne en la última sección, junto con alternativas. Los mensajes de error del propio motor Carbone (imágenes, códigos de barras, colores, gráficos, HTML) se muestran en ruso después de «error de la plantilla:»; esta ayuda explica qué significan.',
  'Los datos del informe son el objeto `d`. El resultado de cada consulta SQL de la plantilla se guarda bajo su clave: en el modo «Lista de filas» es un array; en el modo «Una fila», un objeto (o un valor vacío). Los parámetros del informe están en `d.params`.',
  'Las etiquetas y las «Construcciones» del panel derecho de la pestaña «Documento» se pueden arrastrar con el ratón directamente al documento: la etiqueta se inserta donde se suelta el botón. En las «Construcciones», sustituya `campo` y `array` por sus propios nombres.',
  'En los ejemplos, una línea que empieza por «|» es una fila de una tabla de Word, cuyas celdas están separadas por «|». Las demás líneas son párrafos independientes.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Conceptos básicos',
    intro: [
      'La etiqueta `{d.field}` inserta un valor de los datos. Una ruta con puntos lleva a los objetos anidados, `[número]` a un elemento de un array (contando desde cero) y `[campo=valor]` a un elemento según una condición.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Valor de un campo',
        template: 'Cliente: {d.name}',
        data: j({ name: 'Juan' }),
        result: 'Cliente: Juan',
        note: 'Si el campo no está en los datos, se inserta una cadena vacía; no hay error.',
      },
      {
        id: 'basics-nested',
        title: 'Objeto anidado',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Sevilla' } } }),
        result: 'Sevilla',
      },
      {
        id: 'basics-search',
        title: 'Elemento de un array según una condición',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "Un valor de tipo cadena se escribe entre comillas simples: `{d.items[code='X'].name}`. Un elemento por su número: `{d.items[0].name}` (contando desde cero).",
      },
      {
        id: 'basics-params',
        title: 'Parámetro del informe',
        template: "Período desde el {d.params.from:formatD('DD/MM/YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Período desde el 01/03/2026',
        note: "Los parámetros del informe están en `d.params` con su nombre. El sistema no rellena por sí mismo las etiquetas `{c.…}`, salvo `{c.now}`, el momento en que se genera el informe: `{c.now:formatD('DD/MM/YYYY')}`. Solo puede guardar sus propios valores en `c` con `:set` (consulte la sección «Totales y agrupación»).",
      },
      {
        id: 'basics-ifempty',
        title: 'Valor por defecto',
        template: "Pagado el: {d.paid_on:formatD('DD/MM/YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Pagado el: —',
        note: "`ifEmpty` va al final de la cadena: `{d.paid_on:ifEmpty('—'):formatD('DD/MM/YYYY')}` muestra «Invalid Date». Se consideran vacíos: null, una cadena vacía, un array vacío y un campo ausente; 0 sigue siendo 0.",
      },
      {
        id: 'basics-alias',
        title: 'Alias',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Pedro' } }),
        result: 'Pedro',
        note: 'Un alias se declara con la etiqueta `{#nombre = ruta}`; esta etiqueta no muestra nada. Después, escriba `{$nombre…}` en lugar de la ruta.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Tablas',
    intro: [
      'Una fila de tabla se repite para cada elemento del array de datos: contiene etiquetas con `[i]`, y la fila siguiente contiene al menos una etiqueta con `[i+1]`. La fila `[i+1]` no aparece en el resultado. Sin `[i+1]`, Carbone devuelve el error «has no corresponding [i+1]». En la fila `[i+1]` coloque solo etiquetas `[i+1]` y deje vacías las demás celdas: una etiqueta `[i]` en esa fila provoca el error «is in the [i+1] row».',
      'Los párrafos se repiten de la misma manera: un párrafo con `[i]`, seguido de un párrafo con `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Filas de tabla a partir de un array',
        template: L(
          '| Marca | Cant. |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Cant. |',
          '| Seat | 3 |',
          '| Tesla | 1 |',
          '| Seat | 2 |',
          '| Cupra | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: 'Bucle anidado',
        template: L(
          '{d.groups[i].name}:',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1:', '- a', '- b', 'G2:', '- c', 'G3:'),
        note: 'Un array anidado vacío no produce ninguna línea: «G3» no tiene ninguna, y tampoco hay error.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Bucle anidado en las filas de una tabla',
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
        title: 'Array de datos vacío',
        template: L(
          'antes',
          '| Marca |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'después',
          "{d.cars:ifEM():show('No hay datos'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('antes', '| Marca |', 'después', 'No hay datos'),
        note: "Las filas del bucle desaparecen y el encabezado se mantiene; la clave puede incluso faltar por completo: el resultado es el mismo. Sin `elseShow('')`, `ifEM` muestra el propio valor cuando el array no está vacío.",
      },
      {
        id: 'tables-numbering',
        title: 'Número de fila',
        template: L(
          '| N.º | Marca |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| N.º | Marca |',
          '| 1 | Seat |',
          '| 2 | Tesla |',
          '| 3 | Seat |',
          '| 4 | Cupra |',
        ),
        note: 'Los números van 1, 2, 3… en las filas mostradas, también en un bucle filtrado, sin huecos. La etiqueta `{d.cars[i].i}` no muestra nada. El método antiguo, `{d.cars[i].brand:print(.i):add(1)}`, también funciona, pero `.i` es la posición en el array de origen: con un filtro de bucle, la numeración tiene huecos. Un número entre paréntesis, como en la versión antigua de Carbone (`count(0)`), se ignora: la numeración siempre empieza en 1. Repita el filtro y el orden del bucle en la propia etiqueta `count()` (`{d.cars[i, ok=true].brand:count()}`); de lo contrario, la fila numera su propio conjunto. Las filas eliminadas con `drop(row)` también reciben un número, así que la numeración tendrá huecos; seleccione las filas con un filtro de bucle. Numeración, totales y subtotales: la sección «Totales y numeración».',
      },
      {
        id: 'tables-filter',
        title: 'Filtrar filas',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Seat |', '| Seat |', '| Cupra |'),
        note: "Las comparaciones `[i, qty > 1]`, las cadenas `[i, brand='Seat']` y varias condiciones separadas por comas funcionan igual: se combinan con Y; no hay O, así que añada un indicador en SQL. Una fila de tabla se puede ocultar así o con una etiqueta `drop(row)`; `hideBegin`/`hideEnd` en una tabla dejan una fila vacía (la sección «Condiciones»).",
      },
      {
        id: 'tables-sort',
        title: 'Ordenación',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Tesla', 'Seat', 'Seat', 'Cupra'),
        note: 'Solo en orden ascendente. `[-qty, i]` mantiene en silencio el orden original: ordene de forma descendente en SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Formato',
    intro: [
      "Un formateador se escribe después de dos puntos: `{d.field:formatD('DD/MM/YYYY')}`. Los formateadores se pueden encadenar y se aplican de izquierda a derecha.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Fecha con el nombre del mes',
        template: "{d.date:formatD('D [de] MMMM [de] YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '8 de marzo de 2026',
        note: "El texto entre corchetes (`[de]`) se imprime tal cual. `formatD('dddd, D [de] MMMM [de] YYYY')` da «domingo, 8 de marzo de 2026», y `formatD('MMMM [de] YYYY')` da «marzo de 2026».",
      },
      {
        id: 'fmt-date-short',
        title: 'Fecha en cifras',
        template: "{d.date:formatD('DD/MM/YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08/03/2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Fecha y hora',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '08/03/2026 23:30',
        note: 'La hora se muestra en la zona horaria del servidor (`TZ`, Europe/Moscow por defecto). Pase las horas con desfase (`+03:00`) o en UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Hora sin desfase',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '09/03/2026 02:30',
        note: 'Una hora sin desfase se considera UTC y se desplaza 3 horas. Pase las horas con desfase, o una fecha sin hora.',
      },
      {
        id: 'fmt-number',
        title: 'Número',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1.234.567,89',
        note: 'Los separadores de miles y decimal dependen del idioma del informe: en español, el punto separa los miles y la coma, los decimales. `formatN(0)` redondea al entero: 1234567.5 → «1.234.568».',
      },
      {
        id: 'fmt-money',
        title: 'Importe en euros',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '1.234.567,89 €',
        note: "`formatC()` muestra la moneda del idioma del informe: el euro para el español; si cambia el idioma del informe de la plantilla, la moneda cambia con él. `formatC(0)` omite los céntimos: 1234.5 → «1.235 €». `formatC('LL')` escribe el nombre de la moneda con letras: «1.234.567,89 euros». Ese nombre siempre está en inglés: para el euro coincide con el español («1,00 euro», «1,50 euros»), pero no para otras monedas («pounds» para la libra esterlina); con ellas, no utilice `formatC('M')` ni `formatC('LL')`.",
      },
      {
        id: 'fmt-convcurr',
        title: 'Conversión a otra moneda',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '1140.3000000000002',
        note: "Carbone convierte desde la moneda del idioma del informe (el euro para el español) con tipos de cambio integrados: no se actualizan, y nuestro sistema no le pasa sus propios tipos. `formatC(2, 'USD')` convierte en silencio de la misma manera: 1000 → «1.140,30 $». Calcule los importes en otras monedas en SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Mayúsculas y minúsculas',
        template: '{d.name:ucWords()}',
        data: j({ name: 'juan pérez' }),
        result: 'Juan Pérez',
        note: 'También `ucFirst()` → «Juan pérez», `upperCase()`, `lowerCase()`. Las letras acentuadas, la ñ y las letras de otros alfabetos, como el cirílico, se procesan correctamente.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Acortar una cadena',
        template: '{d.title:ellipsis(7)}',
        data: j({ title: 'Factura mensual' }),
        result: 'Factura...',
        note: "También `substr(0, 5)` → «Factu», `padl(6, '0')` para «42» → «000042», `prepend('N.º ')`, `append(' EUR')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Aritmética',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` aceptan un número o un campo vecino (`.b`); las expresiones no admiten paréntesis. El resultado se muestra sin formato: añada `formatN` para mostrarlo. La división por cero devuelve en silencio el número original.',
      },
      {
        id: 'fmt-array-join',
        title: 'Lista separada por comas',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "Para un array de objetos: `{d.items:arrayMap(', ', ':', 'name')}`: los valores del campo name separados por comas.",
      },
      {
        id: 'fmt-multiline',
        title: 'Texto de varias líneas',
        template: '{d.text:convCRLF}',
        data: j({ text: 'línea1\nlínea2' }),
        result: L('línea1', 'línea2'),
        note: 'Sin `convCRLF`, un salto de línea de los datos no se ve en Word.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Condiciones',
    intro: [
      'Una condición comprueba un valor (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) y muestra `show(…)` o `elseShow(…)`. Las condiciones se combinan con `and(.field)` y `or(.field)`.',
      'Los párrafos y las partes de un texto se ocultan con `showBegin`/`showEnd` y `hideBegin`/`hideEnd`. Una fila de tabla se oculta con un filtro de bucle (la sección «Tablas») o con `drop(row)`; un párrafo, una tabla o una imagen completos se eliminan con `drop`/`keep`.',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Texto según una condición',
        template: "{d.status:ifEQ('paid'):show('Pagada'):elseShow('No pagada')}",
        data: j({ status: 'new' }),
        result: 'No pagada',
        note: "Sin `elseShow`, una condición falsa muestra el propio valor: `{d.v:ifEQ(1):show('uno')}` da «2» para 2. Añada `elseShow('')`.",
      },
      {
        id: 'cond-and',
        title: 'Dos condiciones',
        template:
          "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('listo para enviar'):elseShow('en espera')}",
        data: j({ qty: 2, paid: true }),
        result: 'listo para enviar',
        note: 'Puede usar `or` en lugar de `and`: `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Parte del texto según una condición',
        template: 'Total{d.vat:ifEQ(true):showBegin}, IVA incluido{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Total.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Ocultar párrafos',
        template: L(
          'Factura',
          '{d.paid:ifEQ(true):hideBegin}',
          'Le rogamos que pague en un plazo de 5 días.',
          '{d.paid:hideEnd}',
          '¡Gracias!',
        ),
        data: j({ paid: true }),
        result: L('Factura', '¡Gracias!'),
        note: 'Los párrafos que contienen las etiquetas `hideBegin`/`hideEnd` también desaparecen.',
      },
      {
        id: 'cond-drop-p',
        title: 'Eliminar un párrafo (drop)',
        template: L('antes', '{d.f:ifEQ(true):drop(p)}párrafo que se eliminará', 'después'),
        data: j({ f: true }),
        result: L('antes', 'después'),
        note: 'Coloque la etiqueta en el propio párrafo y al final de la cadena de formateadores. La condición es el resultado de `ifEQ`, `ifGT` y similares. Sin condición, decide el propio valor: `true`, un número distinto de cero, un texto no vacío distinto de `"0"` y `"false"`, y una lista no vacía eliminan el párrafo; `false`, `0`, un texto vacío, `"0"`, `"false"`, y un valor vacío o ausente no lo eliminan: los indicadores 0/1 de la base de datos funcionan tal cual. Funciona en DOCX, ODT, PPTX, ODP; XLSX y ODS no tienen párrafos.',
      },
      {
        id: 'cond-keep-p',
        title: 'Conservar un párrafo solo si una condición es verdadera (keep)',
        template: L('antes', '{d.f:ifEQ(true):keep(p)}párrafo que se conservará', 'después'),
        data: j({ f: false }),
        result: L('antes', 'después'),
        note: '`keep` es lo contrario de `drop`: el párrafo solo se mantiene si la condición es verdadera. `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)` funcionan de la misma manera; en ODS también `drop(sheet)`, y en ODP `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Eliminar una fila de tabla (drop(row))',
        template: L(
          '| Marca | Cant. |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marca | Cant. |', '| Seat | 3 |', '| Seat | 2 |', '| Cupra | 5 |'),
        note: 'La fila «Tesla» se elimina por completo, y el formato de la tabla no se rompe. A diferencia de `hideBegin`, `drop(row)` funciona en un bucle. Si se eliminan todas las filas de una tabla, la tabla también desaparece. `drop(col)` elimina una columna; en XLSX, las celdas combinadas y el filtro automático no se recalculan, y en una hoja con una tabla con formato («Dar formato como tabla») `drop(col)` no está disponible. También funciona un indicador sin condición: `{d.cars[i].archived:drop(row)}` elimina las filas en las que `archived` = 1 y conserva las que tienen 0. Los acumulados, `:count()` y los totales `aggSum` sobre `[]` también cuentan las filas eliminadas: para excluir una fila tanto de la tabla como del total, seleccione las filas con un filtro de bucle y el mismo filtro en el total (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin en una fila de tabla (no lo haga)',
        template: L(
          '| Marca | Cant. |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marca | Cant. |', '| Seat | 3 |', '| |', '| Seat | 2 |', '| Cupra | 5 |'),
        note: 'En lugar de la fila «Tesla» queda una fila vacía de una sola celda, y el formato de la tabla se rompe. Oculte las filas con un filtro de bucle (`{d.cars[i, ok=true].brand}`) o con `drop(row)`.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Totales y numeración',
    intro: [
      'Los agregadores trabajan sobre todo el conjunto: `aggSum`, la suma; `aggAvg`, la media; `aggMin`/`aggMax`, el valor menor y el mayor; `aggCount`, el número de elementos; `aggCountD`, el número de valores distintos; `aggStr`/`aggStrD`, los valores separados por comas (`D`: sin repeticiones). Las versiones `cum…` (`cumSum`, `cumCount`, `cumCountD`) dan un acumulado por las filas del bucle, y `:count()` da el número de fila.',
      'Los corchetes de la ruta eligen el modo. `[]` es un total único sobre todo el array (en cualquier lugar del documento, también después de la tabla); `[sort>1]` o `[ok=true]` es un total solo sobre los elementos seleccionados. `[i]` en un bucle es un valor para cada fila; precisamente `[i]` es lo que necesitan los acumulados, `:count()` y la agrupación con `aggSum(.brand)`.',
      'El resultado es un número sin redondear: dele formato con un formateador después del agregador, por ejemplo `:aggAvg:formatN(2)`. Los valores no numéricos (texto, vacío, `null`) se omiten en las sumas; un número en una cadena (`"2"`) cuenta como número. Un array vacío o una clave ausente no provocan error: `aggSum`, `aggCount`, `aggCountD`, `cumSum` dan 0; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` dan un valor vacío.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Total fuera de un bucle',
        template: 'Total: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Total: 11',
        note: 'El total no depende del lugar de la etiqueta en el documento ni de si el mismo array se muestra con un bucle.',
      },
      {
        id: 'agg-filter',
        title: 'Total con un filtro',
        template: 'Pagado: {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Pagado: 10',
        note: "Las condiciones entre corchetes son las mismas que en un bucle: `[qty>1]`, `[brand='Seat']`, varias separadas por comas. Un filtro de bucle en el documento no afecta al total, pero un filtro en la propia etiqueta sí.",
      },
      {
        id: 'agg-others',
        title: 'Media, máximo, número',
        template: L(
          'Elementos: {d.cars[].qty:aggCount}, media {d.cars[].qty:aggAvg:formatN(2)}',
          'Mayor {d.cars[].qty:aggMax}, menor {d.cars[].qty:aggMin}',
          'Marcas distintas: {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L('Elementos: 4, media 2,75', 'Mayor 5, menor 1', 'Marcas distintas: 3'),
        note: '`aggCount` cuenta todos los elementos, y `aggCountD`, los valores distintos. Un formateador también puede ir antes del agregador: `{d.cars[].qty:mul(2):aggSum}` suma los valores duplicados.',
      },
      {
        id: 'agg-str',
        title: 'Valores en una línea',
        template: L(
          "Marcas: {d.cars[].brand:aggStrD(', ')}",
          "Todas: {d.cars[].brand:aggStr(' | ')}",
        ),
        data: j({ cars: CARS }),
        result: L('Marcas: Tesla, Seat, Cupra', 'Todas: Seat | Tesla | Seat | Cupra'),
        note: 'Sin argumento, el separador es una coma seguida de un espacio. `aggStrD` ordena los valores según su última aparición.',
      },
      {
        id: 'agg-total-row',
        title: 'Fila «Total» debajo de una tabla',
        template: L(
          '| Marca | Cant. |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Total | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Cant. |',
          '| Seat | 3 |',
          '| Tesla | 1 |',
          '| Seat | 2 |',
          '| Cupra | 5 |',
          '| Total | 11 |',
        ),
        note: 'Haga de la fila «Total» una fila normal de Word debajo de la fila `[i+1]`. Si escribe `{d.cars[i].qty:aggSum}` en la fila del bucle, cada fila muestra el mismo total general: `[i]` abarca todo el conjunto, no las filas de arriba.',
      },
      {
        id: 'agg-cum',
        title: 'Acumulado',
        template: L(
          '| Marca | Cant. | Acumulado |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Cant. | Acumulado |',
          '| Seat | 3 | 3 |',
          '| Tesla | 1 | 4 |',
          '| Seat | 2 | 6 |',
          '| Cupra | 5 | 11 |',
        ),
        note: 'El acumulado sigue el orden y el conjunto de filas que indican los corchetes de la propia etiqueta `cumSum`. Si el bucle está filtrado u ordenado (`[i, ok=true]`, `[qty, i]`), repita las mismas condiciones, incluida la ordenación, en los corchetes de la etiqueta del acumulado: la ordenación del bucle no se le aplica. Con `[]` en lugar de `[i]` se produce un error de la plantilla.',
      },
      {
        id: 'agg-partition',
        title: 'Total del grupo en una fila',
        template: L(
          '| Marca | Cant. | Por marca | N.º en la marca |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marca | Cant. | Por marca | N.º en la marca |',
          '| Seat | 3 | 5 | 1 |',
          '| Tesla | 1 | 1 | 1 |',
          '| Seat | 2 | 5 | 2 |',
          '| Cupra | 5 | 5 | 1 |',
        ),
        note: 'El argumento `(.brand)` es una ruta desde el elemento del bucle: el agregador cuenta por separado para cada valor. Solo funciona en un bucle `[i]`; los valores se comparan de forma estricta: el número 1 y la cadena "1" son grupos distintos. El argumento debe ser una ruta con punto; `aggSum(brand)` es un error.',
      },
      {
        id: 'agg-nested',
        title: 'Subtotal sobre un array anidado',
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
        note: '`[i]` en el array externo y `[]` en el anidado dan un subtotal en cada grupo; un grupo vacío da 0. Dos `[]` seguidos dan el total general de todos los grupos. No se puede agrupar para subtotales con un bucle externo sobre un campo como `[brand]`: agrupe con `:set` y calcule `aggSum` por grupo (el ejemplo «Subtotales por grupo (:set)» de la sección «Totales y agrupación») o en SQL. Si la ruta anidada pasa por un objeto (`{d.items[].sub.qty:aggSum}`), hay un error con `[]`: suba el campo con `print(.sub.qty)` o use `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Totales y agrupación',
    intro: [
      'Los totales, los subtotales y la numeración también se pueden hacer en la plantilla: consulte la sección «Totales y numeración». Los grupos con subtotales también se construyen en la plantilla (`:set` + `aggSum`). SQL hace falta donde la plantilla no basta: filtrar con una condición O y ordenar de forma descendente; en conjuntos muy grandes (decenas de miles de filas), los totales con un filtro entre corchetes se calculan más rápido en SQL.',
      'Los números de PostgreSQL (`numeric`, `bigint`) llegan a los datos como números, `date` como una cadena YYYY-MM-DD y `json` como objetos y arrays.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Total en una consulta aparte',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Artículos: {d.totals.positions}, importe total {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Artículos: 3, importe total 13.775,00 €',
        note: 'El número de elementos de un array también se puede obtener en la plantilla: `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Número de fila desde SQL',
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
          '| N.º | Artículo | Cant. |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Papel para fotocopiadora', qty: 10 },
            { n: 2, name: 'Cartucho de tóner', qty: 2 },
            { n: 3, name: 'Bolígrafos', qty: 50 },
          ],
        }),
        result: L(
          '| N.º | Artículo | Cant. |',
          '| 1 | Papel para fotocopiadora | 10 |',
          '| 2 | Cartucho de tóner | 2 |',
          '| 3 | Bolígrafos | 50 |',
        ),
        note: 'Seleccione las filas en `where` y no con un filtro de la plantilla: así la numeración no tiene huecos.',
      },
      {
        id: 'totals-groups',
        title: 'Grupos con subtotales (json_agg)',
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
              company: 'García S.L.',
              subtotal: 13775,
              items: [
                { name: 'Papel para fotocopiadora', qty: 10 },
                { name: 'Cartucho de tóner', qty: 2 },
                { name: 'Bolígrafos', qty: 50 },
              ],
            },
            {
              company: 'Ejemplo S.A.',
              subtotal: 34300,
              items: [
                { name: 'Escritorio', qty: 1 },
                { name: 'Silla', qty: 2 },
                { name: 'Lámpara de escritorio', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'García S.L. — 13.775,00 €',
          '- Papel para fotocopiadora: 10',
          '- Cartucho de tóner: 2',
          '- Bolígrafos: 50',
          'Ejemplo S.A. — 34.300,00 €',
          '- Escritorio: 1',
          '- Silla: 2',
          '- Lámpara de escritorio: 3',
        ),
        note: 'El subtotal del grupo lo calcula `sum(…)`, y el contenido del grupo lo reúne `json_agg`. El total general es una consulta aparte en el modo «Una fila».',
      },
      {
        id: 'totals-set-group',
        title: 'Agrupación en la plantilla (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('Seat', '- Seat 3', '- Seat 2', 'Tesla', '- Tesla 1', 'Cupra', '- Cupra 5'),
        note: 'Los grupos siguen el orden de primera aparición; la etiqueta `:set` no muestra nada. Guarde el objeto completo (`d.cars[]:set(…rows[])`), no campos sueltos. El subtotal del grupo es `aggSum` sobre sus filas: consulte el ejemplo siguiente.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Subtotales por grupo (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id} — cant. {c.g[i].rows[].qty:aggSum}',
          '{c.g[i+1].id}',
          'Cantidad total: {d.cars[].qty:aggSum}',
        ),
        data: j({ cars: CARS }),
        result: L('Seat — cant. 5', 'Tesla — cant. 1', 'Cupra — cant. 5', 'Cantidad total: 11'),
        note: '`:set` reúne las filas por marca, y `{c.g[i].rows[].qty:aggSum}` es el subtotal de cada grupo. `aggCount`, `aggAvg` y los demás agregadores funcionan de la misma manera, y las filas del grupo se pueden mostrar con un bucle anidado, como en el ejemplo anterior.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Suma con :set (incorrecto)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Total: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Total: 14',
        note: 'El total correcto es 11: el primer elemento se cuenta dos veces. Calcule las sumas con el agregador `aggSum` (la sección «Totales y numeración») o en SQL.',
      },
    ],
  },
  {
    id: 'media',
    title: 'Imágenes, códigos de barras, colores, enlaces',
    intro: [
      'Una imagen o un código de barras de los datos sustituye a una imagen de marcador de posición. Inserte en la plantilla cualquier imagen del tamaño adecuado y escriba la etiqueta en su texto alternativo: en Word, «Formato de imagen» → «Texto alternativo» (o clic derecho → «Ver texto alternativo»); en LibreOffice, «Propiedades» → pestaña «Opciones» → el campo de texto alternativo o «Descripción»; en el editor de plantillas, «Ajustes avanzados» → «Texto alternativo» → «Descripción». La etiqueta debe ocupar todo el texto alternativo: un texto mixto («Foto {d.name}») se muestra tal cual, y la imagen se mantiene. La misma etiqueta en un párrafo normal simplemente muestra el valor.',
      'Una imagen en los datos es un data URI (`data:image/png;base64,…`; PNG, JPEG o GIF) o una dirección `https://…`. Las direcciones solo se cargan desde los hosts del parámetro `IMAGE_URL_ALLOWLIST`; por defecto está vacío, y una dirección da un error de la plantilla. SVG no es compatible. Un valor vacío elimina la imagen de marcador de posición. Límites: 10 MB por imagen y 50 MB por informe. Funciona en DOCX, XLSX, PPTX, ODT, ODS, ODP; varias imágenes en un bucle funcionan en DOCX (imagen «En línea con el texto») y en ODT (anclada «Como carácter»).',
      'Un valor de texto simple (ni `data:` ni `http(s)://`) se escribe en el texto alternativo, y la imagen se mantiene; un valor vacío elimina la imagen. Una imagen no válida (data URI dañado, host que no está en la lista, etiqueta incorrecta) es un error de la plantilla con la etiqueta en su texto, y el informe no se genera. Si no se pudo cargar una imagen desde una dirección (tiempo de espera agotado, respuesta distinta de 2xx), se elimina y el informe se genera.',
    ],
    examples: [
      {
        id: 'media-image',
        title: 'Imagen de los datos',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result:
          'La imagen de marcador de posición se sustituye por la imagen: el ancho es el del marcador de posición, y el alto sigue las proporciones de la imagen.',
        note: 'La etiqueta va en el texto alternativo de la imagen, no en un párrafo. En lugar de un data URI, puede pasar una dirección `https://…` si su host figura en `IMAGE_URL_ALLOWLIST`.',
      },
      {
        id: 'media-image-fit',
        title: 'Ajustar una imagen al marco (imageFit)',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result:
          'La imagen completa cabe en el marco de la imagen de marcador de posición, con sus proporciones.',
        note: '`fillWidth` (por defecto): el ancho del marco, el alto según las proporciones; `contain`: encajar la imagen completa; `fill`: estirarla a todo el marco.',
      },
      {
        id: 'media-qrcode',
        title: 'Código QR',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'FAC-2026-0042' }),
        result:
          'La imagen de marcador de posición se sustituye por un código QR con el valor FAC-2026-0042.',
        note: 'Otros tipos: `ean13`, `code128`, `datamatrix`, `pdf417` y los demás de la documentación de Carbone. Las opciones se separan con comas: `{d.v:barcode(ean13, includetext:true, scale:2)}`; `width` y `height` están en mm, `scale` va de 1 a 10 (3 por defecto), los colores `barcolor`, `textcolor`, `backgroundcolor` tienen el formato `#RRGGBB`, y `eclevel:H` es para QR. Un valor que no se puede codificar (letras en `ean13`) es un error de la plantilla. `barcode` en un texto normal es un error de la plantilla que indica que un código de barras va en el texto alternativo de una imagen; las fuentes de códigos de barras no son compatibles.',
      },
      {
        id: 'media-color-cell',
        title: 'Color de celda desde los datos (:color)',
        template: L(
          '| Tarea | Estado |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: 'Informe', status: 'completada', color: '#C6EFCE' },
            { name: 'Conciliación', status: 'con retraso', color: 'FFC7CE' },
          ],
        }),
        result: L(
          '| Tarea | Estado |',
          '| Informe | completada |',
          '| Conciliación | con retraso |',
        ),
        note: 'La etiqueta no muestra nada; colorea el elemento en el que se encuentra: `color(p)`, el párrafo (por defecto); `cell`, la celda; `row`, la fila de la tabla; `shape`, la forma (PPTX, ODP, ODT); `part`, un fragmento de texto (solo ODT). El segundo argumento indica qué colorear: `text` (por defecto), `background`, `highlight` (no en DOCX), `border`: el contorno de la forma (PPTX). En DOCX, solo `text` y `background`, y `shape` no es compatible; en PPTX, `p` con `background` no es compatible. El color se escribe con 6 dígitos hexadecimales, con o sin `#`; cualquier otro valor da gris `#888888`. En XLSX y ODS es un error de la plantilla.',
      },
      {
        id: 'media-default-url',
        title: 'Enlace de reserva (:defaultURL)',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: 'no es una dirección' }),
        result: 'https://example.com',
        note: "Normalmente, la etiqueta sirve como dirección de un hipervínculo: en Word, «Insertar» → «Vínculo», y en el campo «Dirección», `{d.site:defaultURL('https://example.com')}`. Una dirección de enlace de los datos se comprueba: se añade `https://` si no hay esquema; se permiten `http`, `https`, `mailto`, `tel`. Una dirección no válida (`javascript:`, `localhost`, una dirección IP o un nombre sin dominio de nivel superior, como `http://server:8080`) se sustituye por el valor de `:defaultURL` (puede ser un campo: `:defaultURL(.fallback)`), o por `#` si no lo hay. Las direcciones relativas y los anclajes (`#section`, `../file.pdf`) también se convierten en `#`. En una dirección con una parte fija (`https://site.com/?id={d.id}`), el valor de la etiqueta se codifica y se comprueba toda la dirección; una etiqueta al principio de la dirección (`{d.base}/items/{d.id}`) se inserta tal cual.",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Gráficos de Word y Excel',
    intro: [
      'Los gráficos de Word y Excel se rellenan con los datos del informe. Dibuje el gráfico como de costumbre y escriba etiquetas en sus datos como filas de bucle, igual que en una tabla: una fila con `[i]` y, debajo, una fila con `[i+1]`. En Word, las etiquetas van en la hoja de datos del gráfico: clic derecho en el gráfico → «Editar datos». En Excel, van en las celdas de la hoja a las que hace referencia el gráfico.',
      'Una vez generado el informe, las series del gráfico abarcan todas las filas de datos, y los valores guardados en el gráfico se recalculan: el gráfico es correcto tanto en PDF como al abrirlo en Word o Excel. En Word, «Editar datos» muestra los datos del informe. Las filas debajo del bucle se desplazan junto con las referencias que apuntan a ellas. Un array vacío da un gráfico sin puntos. Funcionan todos los tipos habituales: columnas y barras, líneas, áreas, circulares y de anillos, dispersión y burbujas, gráficos combinados, 2D y 3D.',
      'Números: una celda de una serie de valores se convierte en número si el valor parece un número. Se eliminan los espacios y los espacios de no separación, y una coma o un punto sirven de separador decimal: `1234,5`, `1 234,5`, `-3`, `1e3`. Cualquier otro valor (`10%`, `abc`, vacío) queda como texto y no tiene punto en el gráfico. Las etiquetas de categoría no cambian. En Excel, `:formatN` funciona como siempre.',
      'No es compatible: los nuevos tipos de Office 2016 (Rectángulos, Proyección solar, Histograma, Cajas y bigotes, etc.), los bucles por columnas y un número de series tomado de los datos (las series las define la plantilla), las etiquetas de categoría de varios niveles, las tablas de Excel («Dar formato como tabla») y los rangos con nombre (no se amplían), los gráficos vinculados a un archivo externo, los gráficos en PPTX, ODT, ODS, ODP. Los gráficos ECharts (`:chart`) se describen en la sección «Gráficos ECharts».',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Gráfico en Word',
        template: L(
          '| | Importe |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: 'Ene', sum: 10 },
            { month: 'Feb', sum: 25 },
            { month: 'Mar', sum: 7 },
          ],
        }),
        result: L('| | Importe |', '| Ene | 10 |', '| Feb | 25 |', '| Mar | 7 |'),
        note: 'La tabla es la hoja «Editar datos» de un gráfico de Word tal como queda una vez generado el informe. El gráfico muestra la serie «Importe» con tres columnas: Ene, Feb, Mar. La celda encima de las etiquetas puede quedar vacía; el nombre de la serie está en la primera fila.',
      },
      {
        id: 'chart-excel',
        title: 'Gráfico en Excel: dos series, números a partir de texto',
        template: L(
          '| Mes | Previsto | Real |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: 'Ene', plan: 100, fact: '98,5' },
            { month: 'Feb', plan: 120, fact: '1 250' },
            { month: 'Mar', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| Mes | Previsto | Real |',
          '| Ene | 100 | 98,5 |',
          '| Feb | 120 | 1 250 |',
          '| Mar | 150 | |',
        ),
        note: 'La tabla representa las celdas de la hoja de Excel a las que hace referencia el gráfico. Las series «Previsto» y «Real» abarcan tres filas. El texto `98,5` y `1 250` de los datos se convierte en los números 98,5 y 1250, y «Real» no tiene punto para marzo. Un punto también cuenta como separador decimal: `1.250` se convierte en 1,25, y `1.234,5` queda como texto; pase los números sin puntos de miles.',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'Gráficos ECharts',
    intro: [
      'Un gráfico ECharts se dibuja en lugar de una imagen de marcador de posición, en DOCX, XLSX, PPTX, ODT, ODS, ODP. Inserte en el documento cualquier imagen del tamaño adecuado y escriba la etiqueta `{d.charts.sales:chart}` en su texto alternativo, igual que con las imágenes: en Word, «Formato de imagen» → «Texto alternativo»; en Excel, «Formato de imagen» → «Texto alternativo»; en LibreOffice, «Propiedades» → «Opciones» → el campo de texto alternativo (en Calc e Impress, «Título»). Sin `width`/`height` en la definición, el gráfico toma el tamaño de la imagen; con ellos, la imagen conserva el ancho del marcador de posición, y el alto sigue las proporciones del gráfico. `:imageFit(contain)` y `:imageFit(fill)` funcionan como con las imágenes.',
      'Lo más sencillo es el editor de gráficos: la pestaña «Gráficos» del editor de plantillas. Elija una consulta en el modo «Lista de filas», la columna de etiquetas y las columnas de las series (o «Series de los datos»: la columna que reparte las filas en series), el tipo, el título, la leyenda, la paleta y el formato de los números; la vista previa se construye con datos de prueba. La definición del gráfico se guarda en los datos del informe bajo la clave `d.charts.<clave>`; la etiqueta se copia con el botón «Copiar» y se ve en la pestaña «Documento».',
      'Puede pasar una definición de ECharts 5 ya preparada desde SQL: el valor de la etiqueta es `{ "type": "echarts@v5", "option": { … } }` o la propia definición con `series`; también funciona una cadena con JSON. `width` y `height` (100–4000) fijan el tamaño lógico del lienzo: las fuentes de ECharts se miden en esos píxeles, así que un tamaño mayor da un texto más pequeño; sin ellos se usa el tamaño de la imagen. `theme` es `"dark"` o un objeto de tema. El fondo es blanco por defecto.',
      'Límites: la definición ocupa como máximo 1 MB, como máximo 20 series y 10 000 puntos, y se dibuja en 5 s como máximo; las funciones en la definición no funcionan (solo JSON); la fuente es siempre Noto Sans, y las demás fuentes de la definición se sustituyen por ella. Las imágenes en la definición (`graphic`, `symbol: "image://…"`, patrones, claves `image`) solo pueden ser `data:image/png|jpeg|gif;base64,…`; una dirección, una ruta de archivo o SVG es un error de la plantilla. En los gráficos del editor, las etiquetas de fecha se muestran con el formato DD.MM.YYYY a partir de la fecha de los datos, sin conversión de zona horaria: para agrupar por día, convierta la hora en fecha en SQL (`created::date`). Un valor vacío elimina la imagen de marcador de posición. Una definición no válida es un error de la plantilla con la etiqueta; una etiqueta `:chart` en un texto normal es un error de la plantilla que indica que un gráfico va en el texto alternativo de una imagen.',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: 'Gráfico del editor de gráficos',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['Ene', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: 'Importe', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result:
          'La imagen de marcador de posición se sustituye por un gráfico de columnas «Importe» para los meses Ene, Feb, Mar; el tamaño es el del marcador de posición.',
        note: 'Así son los datos que prepara el editor de gráficos (la pestaña «Gráficos»): `d.charts.<clave>` se construye a partir de las filas de la consulta en cada generación del informe y en la vista previa.',
      },
      {
        id: 'echarts-sql',
        title: 'Definición ya preparada desde SQL',
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
                    { name: 'Sur', value: 80 },
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
          'La imagen de marcador de posición se sustituye por un gráfico circular: Norte, 120; Sur, 80.',
        note: 'Una definición sin `type` ni `option` pero con `series` se trata como una definición de ECharts. En una consulta en el modo «Una fila», la columna `chart` se convierte en `d.report.chart`.',
      },
      {
        id: 'echarts-size',
        title: 'Tamaño del lienzo y tema oscuro',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['Lun', 'Mar', 'Mié'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          'La imagen de marcador de posición se sustituye por un gráfico de líneas sobre fondo oscuro; el ancho es el del marcador de posición, y el alto sigue las proporciones 800×400.',
        note: 'Sin `width`/`height`, el lienzo coincide con la imagen de marcador de posición. El tipo `echarts@v5a` también se dibuja con ECharts 5.',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.field:html}` inserta HTML con formato desde los datos: párrafos, títulos, listas, tablas, enlaces, imágenes. Funciona en DOCX y ODT (en el texto, las celdas de tabla, los encabezados y los pies de página) y en el PDF generado a partir de ellos. En una plantilla HTML, el valor se inserta tal cual. En XLSX, PPTX, ODS, ODP es un error de la plantilla que indica que html no es compatible con ese formato.',
      'La etiqueta va en el texto de un párrafo: en un texto alternativo, una dirección de enlace o el nombre del informe es un error de la plantilla que indica que html va en el texto de un párrafo. `:html` es el último formateador de la etiqueta: no puede ir ningún otro formateador después. Sin opciones, el HTML se inserta como párrafos independientes en lugar de la etiqueta; el texto del párrafo antes y después de la etiqueta queda en sus propios párrafos. Después de cada párrafo, título, lista y tabla se añade un párrafo vacío. La fuente, el tamaño, el color y la alineación los toma de la etiqueta: dé formato a la etiqueta en la plantilla, y el HTML recibe el mismo formato. Si el HTML define la misma propiedad, prevalece la etiqueta.',
      'Etiquetas de texto: `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`, `mark` (resaltado amarillo), `code`/`kbd`/`samp` (Courier New). Bloques: `p`, `br`, `pre`, `hr`, `blockquote`, títulos `h1`–`h6` (los estilos «Título 1»–«Título 6»), listas `ul`/`ol`/`li` con anidamiento, tablas `table`/`tr`/`th`/`td` con `colspan` y `rowspan`, enlaces `a href`, imágenes `img`, casillas de verificación `<input type="checkbox" checked>`. De CSS, solo el atributo `style` con las propiedades `color`, `background-color`, `break-before: page` y `break-after: page`. Las demás etiquetas, clases y estilos se eliminan, y el texto se mantiene; `script` y `style` se eliminan junto con su contenido.',
      'Opciones, separadas por comas: `inline`, dentro del párrafo actual; `nospace`, sin párrafos vacíos; `headingtheme:<prefijo>`, estilos de título `<prefijo>1`…`<prefijo>6`; `tabletheme:<estilo>`, estilo de tabla (solo DOCX); `quotetheme:<estilo>`, estilo de cita. Por ejemplo, `{d.h:html(nospace, tabletheme:TableGrid)}`. Una opción desconocida es un error de la plantilla.',
      'La imagen `img`: `src` es un data URI (PNG, JPEG, GIF) o una dirección en un host de `IMAGE_URL_ALLOWLIST`, como en la sección «Imágenes, códigos de barras, colores, enlaces». El tamaño se indica con `width` y `height` en píxeles; sin ellos, el ancho es de 5 cm, con las proporciones conservadas. Una imagen no válida o un fallo de carga hace que se omita la imagen con una advertencia en el registro de la API, y el informe se genera; una imagen de más de 10 MB es un error de la plantilla.',
      'Un valor vacío no inserta nada. Un valor de más de 1 MB, un anidamiento de etiquetas de más de 32 niveles o más de 4096 etiquetas sin cerrar es un error de la plantilla. Una tabla tiene como máximo 63 columnas: el contenido de las celdas sobrantes va a la última. Con `inline` dentro de un hipervínculo de la plantilla, los enlaces del HTML se convierten en texto simple. En ODT, las casillas de verificación son los caracteres ☒ y ☐ (en DOCX son casillas de verificación de Word), `tabletheme` no tiene efecto, y un título dentro de un elemento de lista se convierte en un texto de elemento grande y en negrita.',
    ],
    examples: [
      {
        id: 'html-text',
        title: 'Párrafos y formato del texto',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>La factura está <b>pagada</b>.</p><p>Plazo: <i>5 días</i>, <span style="color:#C00000">sin anticipo</span>.</p>',
        }),
        result: L(
          'Dos párrafos, cada uno seguido de un párrafo vacío:',
          'La factura está pagada.',
          'Plazo: 5 días, sin anticipo.',
          '«pagada» está en negrita, «5 días» en cursiva y «sin anticipo» en rojo.',
        ),
        note: 'La etiqueta está en un párrafo aparte: todo el HTML recibe su formato (fuente, tamaño, alineación). La opción `nospace` elimina los párrafos vacíos.',
      },
      {
        id: 'html-list',
        title: 'Listas',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>Entrega</li><li>Instalación<ul><li>planta 1</li><li>planta 2</li></ul></li></ul><ol><li>Firmar el acta de recepción</li><li>Pagar</li></ol>',
        }),
        result: L(
          '• Entrega',
          '• Instalación',
          '    ◦ planta 1',
          '    ◦ planta 2',
          '1. Firmar el acta de recepción',
          '2. Pagar',
        ),
        note: 'Viñetas por nivel: •, ◦, ▪; números: 1., a., i. Cada lista se numera de nuevo, también en cada fila de un bucle. El elemento `<li><input type="checkbox" checked> hecho</li>` se muestra como una casilla de verificación sin viñeta.',
      },
      {
        id: 'html-table',
        title: 'Tabla',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>Producto</th><th>Cant.</th></tr><tr><td>Cable</td><td>10</td></tr><tr><td colspan="2">Total: 10</td></tr></table>',
        }),
        result: L('| Producto | Cant. |', '| Cable | 10 |', '| Total: 10 |'),
        note: 'La tabla ocupa todo el ancho del texto con columnas iguales, `th` en negrita, y «Total» abarca dos columnas. En DOCX, el estilo `tabletheme`; si no, el estilo de tabla predeterminado del documento (salvo «Tabla normal» sin bordes); si no, «Tabla con cuadrícula» (bordes continuos); en ODT, bordes finos. Un `caption` se convierte en un párrafo encima de la tabla.',
      },
      {
        id: 'html-link',
        title: 'Enlaces y dirección de reserva',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>El contrato está <a href="site.com/doc">en el sitio web</a>, la guía está <a href="javascript:alert(1)">aquí</a>.</p>',
        }),
        result: L(
          'El contrato está en el sitio web, la guía está aquí.',
          '«en el sitio web» lleva a https://site.com/doc, y «aquí», a https://example.com.',
        ),
        note: 'Las direcciones se comprueban igual que los enlaces de la plantilla: se añade `https://` si no hay esquema; se permiten `http`, `https`, `mailto`, `tel`. Una dirección no válida (`javascript:`, `localhost`, un anclaje `#section`) se sustituye por el valor de `:defaultURL`, o por `#` si no lo hay.',
      },
      {
        id: 'html-inline',
        title: 'Dentro de un párrafo (inline)',
        rich: true,
        template: 'Estado: {d.status:html(inline)}, véase más arriba.',
        data: j({ status: '<b>pagada</b> <i>en parte</i>' }),
        result: L(
          'Estado: pagada en parte, véase más arriba.',
          'Un solo párrafo; «pagada» en negrita, «en parte» en cursiva.',
        ),
        note: 'En el modo `inline` solo funcionan `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u`. Las demás etiquetas se eliminan y el texto se mantiene; `br` y los límites de párrafo se convierten en espacios.',
      },
      {
        id: 'html-nospace',
        title: 'Títulos sin párrafos vacíos (nospace)',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>Condiciones</h2><p>Pago en un plazo de 5 días.</p>' }),
        result: L(
          'Condiciones: estilo «Título 2»',
          'Pago en un plazo de 5 días.',
          'No hay ningún párrafo vacío entre ellos ni después.',
        ),
        note: 'Un estilo de título que no existe en la plantilla se crea de forma sencilla: negrita, 20/16/14/13/12/11 pt para `h1`–`h6`. Use sus propios estilos con la opción `headingtheme:<prefijo>`: `{d.terms:html(headingtheme:Report)}` toma los estilos `Report1`…`Report6`.',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF: PDF/A, marca de agua, números de página, archivos adjuntos, contraseña',
    intro: [
      'La configuración del PDF se define en la pestaña «PDF» del editor de plantillas y se aplica al PDF del informe: en la vista previa, al generarlo y al descargarlo. «Guardar como» DOCX/XLSX… da un archivo sin ella.',
      'PDF/A-2b es un formato para el archivo y el intercambio electrónico de documentos. Cuando PDF/A está activado, los archivos adjuntos también deben estar en formato PDF/A (se lee en los metadatos del archivo).',
      'La marca de agua y los metadatos (título, autor, asunto, palabras clave) pueden contener etiquetas `{d.field}` y `{d.list[0].field}`, sin formateadores ni bucles. Un valor de etiqueta vacío en la marca de agua elimina la marca de agua: así, «BORRADOR» solo aparece en los documentos que aún no se han aprobado. Los caracteres de los datos que no están en la fuente del PDF (por ejemplo, emoji) se sustituyen por «?».',
      'La numeración de páginas abarca todo el documento con los archivos adjuntos: `{page}` es el número de página y `{pages}`, el número total de páginas; la primera página puede quedar sin número. Los PDF adjuntos (hasta 10 archivos de 20 MB cada uno, 500 páginas en total) se añaden al principio o al final del informe; no se aceptan archivos protegidos con contraseña.',
      'Protección: una contraseña de apertura (una por plantilla, de 4 a 64 caracteres, que no empiece por «-») y restricciones de impresión, de copia del texto y de modificación. Las restricciones sin contraseña no bloquean el documento: las aplican los lectores de PDF. La protección se aplica a los informes generados; la vista previa se muestra sin ella. PDF/A y la protección son incompatibles. La contraseña se guarda cifrada, no se muestra en el cuadro de diálogo y no se transfiere al mover la plantilla a otro entorno: defínala allí de nuevo.',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'Número del documento en el título del PDF',
        template: 'Factura N.º {d.number}',
        data: j({ number: '42', status: 'BORRADOR' }),
        result: 'Factura N.º 42',
        note: 'La misma etiqueta en el campo «Título» de la pestaña «PDF» da el título de documento «Factura N.º 42», y `{d.status}` en el campo de la marca de agua da la marca de agua «BORRADOR». Los formateadores (`{d.sum:formatC}`) no son compatibles en los campos del PDF.',
      },
    ],
  },
  {
    id: 'signature',
    title: 'Firma electrónica',
    intro: [
      'La firma del PDF tiene el formato PAdES con el certificado del usuario de un archivo `.p12` (`.pfx`). Según la ley federal rusa n.º 63-FZ, es una firma electrónica avanzada no cualificada: su validez jurídica dentro de la organización y con los socios se deriva de un acuerdo entre las partes.',
      'Método de firma: en la pestaña «PDF», el campo «Método de firma» ofrece «Certificado .p12 (firma en el PDF)» o «GOST, CryptoPro (archivo .sig)». Con GOST, la clave permanece en el ordenador del usuario: se necesitan CryptoPro CSP 5.0, CryptoPro CAdES Browser plug-in con la extensión del navegador y un certificado GOST R 34.10-2012 en el almacén «Personal»; el resultado es un PDF con sello y una firma `.sig` separada. El administrador coloca el script `cadesplugin_api.js` (no lo suministramos); los detalles están en `docs/operations/gost-signature.md`; sin él, el cuadro de diálogo de firma indica que no se encuentra el complemento. El servidor comprueba la firma, pero no la cadena de certificados ni la revocación: compruébelas en el portal ruso de servicios públicos Gosuslugi (gosuslugi.ru/pgu/eds).',
      'Activación: la pestaña «PDF» del editor de plantillas → «Firma electrónica» → «Permitir la firma del PDF», y después la posición del sello (abajo a la izquierda, abajo en el centro, abajo a la derecha). La firma es incompatible con la contraseña y las restricciones del bloque «Protección»; es compatible con PDF/A. La configuración se aplica a los informes nuevos; las ejecuciones anteriores no cambian.',
      'Firmar: el usuario carga su certificado en la página «Mi firma», genera el informe y hace clic en «Firmar PDF» (o en «Firmar…» en el historial). La contraseña de la clave se introduce en cada firma y nunca se guarda; tras cinco contraseñas incorrectas en 15 minutos, la firma se bloquea hasta que termina ese período. Solo el usuario que generó una ejecución puede firmarla; una ejecución no se puede firmar dos veces. El archivo firmado: «Descargar PDF firmado», o «PDF firmado» en el historial.',
      'El sello es un marco de 250 × 80 pt en la parte inferior de la última página (a la izquierda, en el centro o a la derecha), encima del contenido: número de serie, propietario, período de validez del certificado, hora de la firma. La zona de la página que queda debajo no se borra: deje 110 pt libres en la parte inferior de la última página.',
      'Sello de tiempo: si el administrador ha configurado un servicio de sellos de tiempo (`SIGN_TSA_URL`), este confirma la hora de la firma; si el servicio no está disponible, el informe no se firma: el error «el servicio de sellos de tiempo no está disponible».',
      'Verificación: Adobe Acrobat Reader muestra la firma en el panel «Firmas». Es «válida» si el destinatario confía en el certificado de la autoridad de certificación; para los certificados autofirmados e internos, añada el certificado raíz a los certificados de confianza.',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: 'No disponible en la versión gratuita',
    intro: [
      'Estas etiquetas están desactivadas en la versión gratuita de Carbone. Si una de ellas está en la plantilla, el informe y la vista previa no se generan, y se muestra el error del ejemplo.',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: 'Nombres de regiones (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'ES' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Tome el nombre de una tabla de referencia en SQL.',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead:
          'Desactivado; una plantilla que lo usa no se genera. Una imagen de los datos se inserta tal cual: gírela antes de pasarla al informe.',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          'El antiguo `bindColor` no provoca error, pero tampoco cambia el color. Use `:color` (la sección «Imágenes, códigos de barras, colores, enlaces»).',
      },
      {
        id: 'na-svg',
        title: 'SVG y fuentes de códigos de barras',
        instead:
          'Una imagen SVG de los datos es un error de la plantilla que indica que SVG no es compatible: pase PNG, JPEG o GIF. Las fuentes de códigos de barras no son compatibles: use `:barcode` en una imagen de marcador de posición.',
      },
      {
        id: 'na-sort-desc',
        title: 'Orden descendente',
        instead:
          '`[-qty, i]` mantiene en silencio el orden original: Carbone todavía no sabe hacerlo. Ordene en SQL: `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'Salida TXT',
        instead:
          'El texto en cirílico se convierte en «??????». Nuestro sistema no tiene formato TXT: use PDF o DOCX.',
      },
    ],
  },
];
