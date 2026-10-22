import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API message for a disabled formatter (apps/api/src/modules/carbone/community.ts, errors catalog). */
const community = (name: string) =>
  `the template uses ${name} — not available in the free edition of Carbone, see “Template help”`;

const CARS = [
  { brand: 'Ford', qty: 3, ok: true },
  { brand: 'Tesla', qty: 1, ok: false },
  { brand: 'Ford', qty: 2, ok: true },
  { brand: 'BMW', qty: 5, ok: true },
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
  'This page covers only what has been checked on our Carbone — the free edition (Community Edition). Everything it lacks is collected in the last section, together with alternatives.',
  'The report data is the `d` object. The result of each template SQL query is stored under its key: in “List of rows” mode it is an array, in “Single row” mode an object (or empty). Report parameters are in `d.params`.',
  'Tags and “Constructs” from the panel on the right of the “Document” tab can be dragged with the mouse straight into the document — the tag lands where you release the button. In “Constructs”, replace `field` and `array` with your own names.',
  'In the examples, a line that starts with “|” is a Word table row, with cells separated by “|”. Other lines are separate paragraphs.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Basics',
    intro: [
      'The tag `{d.field}` inserts a value from the data. A dotted path leads into nested objects, `[number]` to an array element (counting from zero), `[field=value]` to an element by condition.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Field value',
        template: 'Customer: {d.name}',
        data: j({ name: 'John' }),
        result: 'Customer: John',
        note: 'If the field is missing from the data, an empty string is inserted; there is no error.',
      },
      {
        id: 'basics-nested',
        title: 'Nested object',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Boston' } } }),
        result: 'Boston',
      },
      {
        id: 'basics-search',
        title: 'Array element by condition',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "A string value goes in quotes: `{d.items[code='X'].name}`. An element by number: `{d.items[0].name}` (counting from zero).",
      },
      {
        id: 'basics-params',
        title: 'Report parameter',
        template: "Period from {d.params.from:formatD('MM/DD/YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Period from 03/01/2026',
        note: "Report parameters are in `d.params` under their names. The system does not fill `{c.…}` tags itself, except `{c.now}` — the time the report is generated: `{c.now:formatD('MM/DD/YYYY')}`. You can store your own values in `c` only with `:set` (see the “Totals and grouping” section).",
      },
      {
        id: 'basics-ifempty',
        title: 'Default value',
        template: "Paid on: {d.paid_on:formatD('MM/DD/YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Paid on: —',
        note: "`ifEmpty` goes last in the chain: `{d.paid_on:ifEmpty('—'):formatD('MM/DD/YYYY')}` prints “Invalid Date”. Empty means null, an empty string, an empty array and a missing field; 0 stays 0.",
      },
      {
        id: 'basics-alias',
        title: 'Alias',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Peter' } }),
        result: 'Peter',
        note: 'An alias is declared with the tag `{#name = path}`; this tag prints nothing itself. After it, write `{$name…}` instead of the path.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Tables',
    intro: [
      'A table row is repeated for each array element: it holds tags with `[i]`, and the next row holds at least one tag with `[i+1]`. The `[i+1]` row does not appear in the result. Without `[i+1]`, Carbone returns the error “has no corresponding [i+1]”. Put only `[i+1]` tags in the `[i+1]` row and leave the other cells empty: an `[i]` tag there causes the error “is in the [i+1] row”.',
      'Paragraphs repeat the same way: a paragraph with `[i]`, followed by a paragraph with `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Table rows from an array',
        template: L(
          '| Brand | Qty |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Brand | Qty |',
          '| Ford | 3 |',
          '| Tesla | 1 |',
          '| Ford | 2 |',
          '| BMW | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: 'Nested loop',
        template: L(
          '{d.groups[i].name}:',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1:', '- a', '- b', 'G2:', '- c', 'G3:'),
        note: 'An empty nested array produces no rows — “G3” has none, and there is no error either.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Nested loop in table rows',
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
        title: 'Empty array',
        template: L(
          'before',
          '| Brand |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'after',
          "{d.cars:ifEM():show('No data'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('before', '| Brand |', 'after', 'No data'),
        note: "The loop rows disappear and the header stays; the key may be missing altogether — the result is the same. Without `elseShow('')`, `ifEM` prints the value itself when the array is not empty.",
      },
      {
        id: 'tables-numbering',
        title: 'Row number',
        template: L(
          '| No. | Brand |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| No. | Brand |',
          '| 1 | Ford |',
          '| 2 | Tesla |',
          '| 3 | Ford |',
          '| 4 | BMW |',
        ),
        note: 'Numbers go 1, 2, 3… over the printed rows, including in a filtered loop — without gaps. The tag `{d.cars[i].i}` prints nothing. The old way, `{d.cars[i].brand:print(.i):add(1)}`, also works, but `.i` is the position in the source array, so with a loop filter the numbers have gaps. A number in the parentheses, as in the old Carbone version (`count(0)`), is ignored: numbering always starts at 1. Repeat the loop’s filter and sorting in the `count()` tag itself (`{d.cars[i, ok=true].brand:count()}`), otherwise the row numbers its own set. Rows removed by `drop(row)` still get a number, so the numbering will have gaps; select rows with a loop filter instead. Numbering, totals and subtotals: the “Totals and numbering” section.',
      },
      {
        id: 'tables-filter',
        title: 'Filtering rows',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Ford |', '| Ford |', '| BMW |'),
        note: "Comparisons `[i, qty > 1]`, strings `[i, brand='Ford']` and several conditions separated by commas work the same way — they are combined with AND; there is no OR, so add a flag in SQL. You can hide a table row this way or with a `drop(row)` tag; `hideBegin`/`hideEnd` in a table leave an empty row (the “Conditions” section).",
      },
      {
        id: 'tables-sort',
        title: 'Sorting',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Tesla', 'Ford', 'Ford', 'BMW'),
        note: 'Ascending only. `[-qty, i]` silently keeps the original order — sort in descending order in SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Formatting',
    intro: [
      "A formatter goes after a colon: `{d.field:formatD('MM/DD/YYYY')}`. Formatters can be chained and are applied from left to right.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Date with the month name',
        template: "{d.date:formatD('MMMM D, YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: 'March 8, 2026',
        note: "`formatD('dddd, MMMM D, YYYY')` gives “Sunday, March 8, 2026”, `formatD('MMMM YYYY')` gives “March 2026”.",
      },
      {
        id: 'fmt-date-short',
        title: 'Date in digits',
        template: "{d.date:formatD('MM/DD/YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '03/08/2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Date and time',
        template: "{d.at:formatD('MM/DD/YYYY h:mm A')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '03/08/2026 11:30 PM',
        note: 'The time is shown in the server’s time zone (`TZ`, Europe/Moscow by default). Pass times with an offset (`+03:00`) or in UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Time without an offset',
        template: "{d.at:formatD('MM/DD/YYYY h:mm A')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '03/09/2026 2:30 AM',
        note: 'A time without an offset is treated as UTC and shifted by 3 hours. Pass times with an offset, or a date without a time.',
      },
      {
        id: 'fmt-number',
        title: 'Number',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1,234,567.89',
        note: 'The thousands separator and the decimal mark follow the report language: in English, a comma and a period. `formatN(0)` rounds to a whole number: 1234567.5 → “1,234,568”.',
      },
      {
        id: 'fmt-money',
        title: 'Amount in dollars',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '$1,234,567.89',
        note: "`formatC()` prints the currency of the report language — US dollars for English; if the template’s report language changes, the currency changes with it. `formatC(0)` drops the cents: 1234.5 → “$1,235”. `formatC('LL')` spells out the currency name: “1,234,567.89 dollars”.",
      },
      {
        id: 'fmt-convcurr',
        title: 'Converting to another currency',
        template: "{d.sum:convCurr('EUR')}",
        data: j({ sum: 1000 }),
        result: '876.9622029290537',
        note: "Carbone converts from the currency of the report language (US dollars for English) at built-in rates: they are not updated, and our system does not pass its own rates. `formatC(2, 'EUR')` converts silently in the same way: 1000 → “€876.96”. Calculate amounts in other currencies in SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Letter case',
        template: '{d.name:ucWords()}',
        data: j({ name: 'john smith' }),
        result: 'John Smith',
        note: 'Also `ucFirst()` → “John smith”, `upperCase()`, `lowerCase()`. Letters of other alphabets, such as Cyrillic, are handled correctly.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Truncating a string',
        template: '{d.title:ellipsis(7)}',
        data: j({ title: 'Account statement' }),
        result: 'Account...',
        note: "Also `substr(0, 5)` → “Accou”, `padl(6, '0')` for “42” → “000042”, `prepend('No. ')`, `append(' USD')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Arithmetic',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` take a number or a sibling field (`.b`); expressions have no parentheses. The result is printed unformatted — add `formatN` for display. Division by zero silently returns the original number.',
      },
      {
        id: 'fmt-array-join',
        title: 'Comma-separated list',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "For an array of objects: `{d.items:arrayMap(', ', ':', 'name')}` — the values of the name field separated by commas.",
      },
      {
        id: 'fmt-multiline',
        title: 'Multi-line text',
        template: '{d.text:convCRLF}',
        data: j({ text: 'line1\nline2' }),
        result: L('line1', 'line2'),
        note: 'Without `convCRLF`, a line break from the data is not visible in Word.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Conditions',
    intro: [
      'A condition checks a value (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) and prints `show(…)` or `elseShow(…)`. Conditions are combined with `and(.field)` and `or(.field)`.',
      'Paragraphs and parts of text are hidden with `showBegin`/`showEnd` and `hideBegin`/`hideEnd`. A table row is hidden with a loop filter (the “Tables” section) or `drop(row)`; a whole paragraph, table or picture is removed with `drop`/`keep`.',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Text by condition',
        template: "{d.status:ifEQ('paid'):show('Paid'):elseShow('Not paid')}",
        data: j({ status: 'new' }),
        result: 'Not paid',
        note: "Without `elseShow`, a false condition prints the value itself: `{d.v:ifEQ(1):show('one')}` gives “2” for 2. Add `elseShow('')`.",
      },
      {
        id: 'cond-and',
        title: 'Two conditions',
        template: "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('ready to ship'):elseShow('on hold')}",
        data: j({ qty: 2, paid: true }),
        result: 'ready to ship',
        note: 'You can use `or` instead of `and`: `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Part of the text by condition',
        template: 'Total{d.vat:ifEQ(true):showBegin}, including VAT{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Total.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Hiding paragraphs',
        template: L(
          'Invoice',
          '{d.paid:ifEQ(true):hideBegin}',
          'Please pay within 5 days.',
          '{d.paid:hideEnd}',
          'Thank you!',
        ),
        data: j({ paid: true }),
        result: L('Invoice', 'Thank you!'),
        note: 'The paragraphs with the `hideBegin`/`hideEnd` tags disappear too.',
      },
      {
        id: 'cond-drop-p',
        title: 'Removing a paragraph (drop)',
        template: L('before', '{d.f:ifEQ(true):drop(p)}paragraph to remove', 'after'),
        data: j({ f: true }),
        result: L('before', 'after'),
        note: 'Put the tag in the paragraph itself and last in the formatter chain. The condition is the result of `ifEQ`, `ifGT` and the like. Without a condition, the value itself decides: `true`, a non-zero number, non-empty text other than `"0"` and `"false"`, and a non-empty list remove the paragraph; `false`, `0`, empty text, `"0"`, `"false"`, and an empty or missing value do not — 0/1 flags from the database work as they are. Works in DOCX, ODT, PPTX, ODP; XLSX and ODS have no paragraphs.',
      },
      {
        id: 'cond-keep-p',
        title: 'Keeping a paragraph only if a condition holds (keep)',
        template: L('before', '{d.f:ifEQ(true):keep(p)}paragraph to keep', 'after'),
        data: j({ f: false }),
        result: L('before', 'after'),
        note: '`keep` is the opposite of `drop`: the paragraph stays only if the condition is true. `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)` work the same way; in ODS also `drop(sheet)`, in ODP `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Removing a table row (drop(row))',
        template: L(
          '| Brand | Qty |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Brand | Qty |', '| Ford | 3 |', '| Ford | 2 |', '| BMW | 5 |'),
        note: 'The “Tesla” row is removed entirely, and the table formatting is not broken. Unlike `hideBegin`, `drop(row)` works in a loop. If all rows of a table are removed, the table disappears too. `drop(col)` removes a column; in XLSX, merged cells and the AutoFilter are not recalculated, and on a sheet with a formatted table (“Format as Table”) `drop(col)` is not available. A flag without a condition works too: `{d.cars[i].archived:drop(row)}` removes the rows where `archived` = 1 and keeps those with 0. Running totals, `:count()` and `aggSum` totals over `[]` also count removed rows — to keep a row out of both the table and the total, select rows with a loop filter and the same filter in the total (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin in a table row (do not do this)',
        template: L(
          '| Brand | Qty |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Brand | Qty |', '| Ford | 3 |', '| |', '| Ford | 2 |', '| BMW | 5 |'),
        note: 'Instead of the “Tesla” row, an empty one-cell row remains, and the table formatting breaks. Hide rows with a loop filter (`{d.cars[i, ok=true].brand}`) or `drop(row)`.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Totals and numbering',
    intro: [
      'Aggregators work over the whole set: `aggSum` — sum, `aggAvg` — average, `aggMin`/`aggMax` — smallest and largest, `aggCount` — number of elements, `aggCountD` — number of distinct values, `aggStr`/`aggStrD` — values separated by commas (`D` — without repeats). The `cum…` versions (`cumSum`, `cumCount`, `cumCountD`) give a running total over the loop rows, `:count()` gives the row number.',
      'The brackets in the path choose the mode. `[]` is one total over the whole array (anywhere in the document, including after the table), `[sort>1]` or `[ok=true]` is a total over the selected elements only. `[i]` in a loop is a value for each row; `[i]` is exactly what running totals, `:count()` and grouping with `aggSum(.brand)` need.',
      'The result is an unrounded number: format it with a formatter after the aggregator, for example `:aggAvg:formatN(2)`. Non-numeric values (text, empty, `null`) are skipped in sums; a number in a string (`"2"`) counts as a number. An empty array or a missing key gives no error: `aggSum`, `aggCount`, `aggCountD`, `cumSum` give 0; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` give an empty value.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Total outside a loop',
        template: 'Total: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Total: 11',
        note: 'The total does not depend on where the tag is in the document or on whether the same array is printed by a loop.',
      },
      {
        id: 'agg-filter',
        title: 'Total with a filter',
        template: 'Paid: {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Paid: 10',
        note: "The conditions in brackets are the same as in a loop: `[qty>1]`, `[brand='Ford']`, several separated by commas. A loop filter in the document does not affect the total, but a filter in the tag itself does.",
      },
      {
        id: 'agg-others',
        title: 'Average, maximum, count',
        template: L(
          'Items: {d.cars[].qty:aggCount}, average {d.cars[].qty:aggAvg:formatN(2)}',
          'Largest {d.cars[].qty:aggMax}, smallest {d.cars[].qty:aggMin}',
          'Distinct brands: {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L('Items: 4, average 2.75', 'Largest 5, smallest 1', 'Distinct brands: 3'),
        note: '`aggCount` counts all elements, and `aggCountD` counts distinct values. A formatter can also go before the aggregator: `{d.cars[].qty:mul(2):aggSum}` sums the doubled values.',
      },
      {
        id: 'agg-str',
        title: 'Values in one line',
        template: L(
          "Brands: {d.cars[].brand:aggStrD(', ')}",
          "All: {d.cars[].brand:aggStr(' | ')}",
        ),
        data: j({ cars: CARS }),
        result: L('Brands: Tesla, Ford, BMW', 'All: Ford | Tesla | Ford | BMW'),
        note: 'Without an argument, the separator is a comma and a space. `aggStrD` orders values by their last occurrence.',
      },
      {
        id: 'agg-total-row',
        title: '“Total” row under a table',
        template: L(
          '| Brand | Qty |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Total | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Brand | Qty |',
          '| Ford | 3 |',
          '| Tesla | 1 |',
          '| Ford | 2 |',
          '| BMW | 5 |',
          '| Total | 11 |',
        ),
        note: 'Make the “Total” row an ordinary Word row under the `[i+1]` row. If you write `{d.cars[i].qty:aggSum}` in the loop row, every row shows the same grand total: `[i]` covers the whole set, not the rows above.',
      },
      {
        id: 'agg-cum',
        title: 'Running total',
        template: L(
          '| Brand | Qty | So far |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Brand | Qty | So far |',
          '| Ford | 3 | 3 |',
          '| Tesla | 1 | 4 |',
          '| Ford | 2 | 6 |',
          '| BMW | 5 | 11 |',
        ),
        note: 'The running total follows the order and the set of rows given by the brackets of the `cumSum` tag itself. If the loop is filtered or sorted (`[i, ok=true]`, `[qty, i]`), repeat the same conditions, including sorting, in the brackets of the running-total tag: the loop’s sorting does not apply to it. With `[]` instead of `[i]`, it is a template error.',
      },
      {
        id: 'agg-partition',
        title: 'Group total in a row',
        template: L(
          '| Brand | Qty | Per brand | No. in brand |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Brand | Qty | Per brand | No. in brand |',
          '| Ford | 3 | 5 | 1 |',
          '| Tesla | 1 | 1 | 1 |',
          '| Ford | 2 | 5 | 2 |',
          '| BMW | 5 | 5 | 1 |',
        ),
        note: 'The argument `(.brand)` is a path from the loop element: the aggregator counts separately for each value. It works only in an `[i]` loop; values are compared strictly: the number 1 and the string "1" are different groups. The argument must be a path with a dot; `aggSum(brand)` is an error.',
      },
      {
        id: 'agg-nested',
        title: 'Subtotal over a nested array',
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
        note: '`[i]` on the outer array and `[]` on the nested one give a subtotal within each group; an empty group gives 0. Two `[]` in a row give the grand total over all groups. You cannot group for subtotals with an outer loop over a field such as `[brand]` — group with `:set` and compute `aggSum` per group (the “Group subtotals (:set)” example in the “Totals and grouping” section) or in SQL. If the nested path goes through an object (`{d.items[].sub.qty:aggSum}`), there is an error under `[]`: bring the field up with `print(.sub.qty)` or use `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Totals and grouping',
    intro: [
      'Totals, subtotals and numbering can also be done in the template — see the “Totals and numbering” section. Groups with subtotals are also built in the template (`:set` + `aggSum`). SQL is needed where the template cannot cope: filtering with an OR condition and sorting in descending order; on very large sets (tens of thousands of rows), totals with a filter in brackets are faster to compute in SQL.',
      'Numbers from PostgreSQL (`numeric`, `bigint`) arrive in the data as numbers, `date` as a YYYY-MM-DD string, `json` as objects and arrays.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Total as a separate query',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Items: {d.totals.positions}, total amount {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Items: 3, total amount $13,775.00',
        note: 'The number of array elements can also be taken in the template: `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Row number from SQL',
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
          '| No. | Item | Qty |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Copy paper', qty: 10 },
            { n: 2, name: 'Toner cartridge', qty: 2 },
            { n: 3, name: 'Ballpoint pens', qty: 50 },
          ],
        }),
        result: L(
          '| No. | Item | Qty |',
          '| 1 | Copy paper | 10 |',
          '| 2 | Toner cartridge | 2 |',
          '| 3 | Ballpoint pens | 50 |',
        ),
        note: 'Select rows in `where` rather than with a template filter — then the numbers have no gaps.',
      },
      {
        id: 'totals-groups',
        title: 'Groups with subtotals (json_agg)',
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
              company: 'Acme Corp.',
              subtotal: 13775,
              items: [
                { name: 'Copy paper', qty: 10 },
                { name: 'Toner cartridge', qty: 2 },
                { name: 'Ballpoint pens', qty: 50 },
              ],
            },
            {
              company: 'Globex Inc.',
              subtotal: 34300,
              items: [
                { name: 'Office desk', qty: 1 },
                { name: 'Chair', qty: 2 },
                { name: 'Desk lamp', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'Acme Corp. — $13,775.00',
          '- Copy paper: 10',
          '- Toner cartridge: 2',
          '- Ballpoint pens: 50',
          'Globex Inc. — $34,300.00',
          '- Office desk: 1',
          '- Chair: 2',
          '- Desk lamp: 3',
        ),
        note: 'The group subtotal is computed by `sum(…)`, and the group’s contents are collected by `json_agg`. The grand total is a separate query in “Single row” mode.',
      },
      {
        id: 'totals-set-group',
        title: 'Grouping in the template (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('Ford', '- Ford 3', '- Ford 2', 'Tesla', '- Tesla 1', 'BMW', '- BMW 5'),
        note: 'Groups follow the order of first appearance; the `:set` tag prints nothing. Store the whole object (`d.cars[]:set(…rows[])`), not individual fields. The group subtotal is `aggSum` over its rows — see the next example.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Group subtotals (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id} — qty {c.g[i].rows[].qty:aggSum}',
          '{c.g[i+1].id}',
          'Total qty: {d.cars[].qty:aggSum}',
        ),
        data: j({ cars: CARS }),
        result: L('Ford — qty 5', 'Tesla — qty 1', 'BMW — qty 5', 'Total qty: 11'),
        note: '`:set` collects the rows by brand, and `{c.g[i].rows[].qty:aggSum}` is the subtotal within each group. `aggCount`, `aggAvg` and the other aggregators work the same way, and the group’s rows can be printed with a nested loop, as in the example above.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Sum via :set (wrong)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Total: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Total: 14',
        note: 'The correct total is 11: the first element is counted twice. Compute sums with the `aggSum` aggregator (the “Totals and numbering” section) or in SQL.',
      },
    ],
  },
  {
    id: 'media',
    title: 'Images, barcodes, colors, links',
    intro: [
      'An image or a barcode from the data replaces a placeholder picture. Insert any picture of the right size into the template and write the tag in its alt text: in Word — “Format Picture” → “Alt Text” (or right-click → “Edit Alt Text”), in LibreOffice — “Properties” → “Options” tab → “Text Alternative” or “Description”, in the template editor — “Image Advanced Settings” → “Alternative Text” → “Description”. The tag must take up the whole alt text: mixed text (“Photo {d.name}”) is printed as is, and the picture stays. The same tag in an ordinary paragraph simply prints the value.',
      'An image in the data is a data URI (`data:image/png;base64,…`; PNG, JPEG or GIF) or an `https://…` address. Addresses are loaded only from hosts in the `IMAGE_URL_ALLOWLIST` setting; it is empty by default, and an address gives a template error. SVG is not supported. An empty value removes the placeholder picture. Limits: 10 MB per image and 50 MB per report. Works in DOCX, XLSX, PPTX, ODT, ODS, ODP; several pictures in a loop work in DOCX (picture “In Line with Text”) and ODT (anchored “As Character”).',
      'A plain-text value (not `data:` and not `http(s)://`) is printed in the alt text, and the picture stays; an empty value removes the picture. An invalid image (a broken data URI, a host not on the list, a wrong tag) is a template error with the tag in its text, and the report is not generated. If a picture at an address could not be loaded (timeout, non-2xx response), it is removed and the report is generated.',
    ],
    examples: [
      {
        id: 'media-image',
        title: 'Image from the data',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result:
          'The placeholder picture is replaced with the image: the width is that of the placeholder, the height follows the image’s proportions.',
        note: 'The tag goes in the picture’s alt text, not in a paragraph. Instead of a data URI you can pass an `https://…` address if its host is listed in `IMAGE_URL_ALLOWLIST`.',
      },
      {
        id: 'media-image-fit',
        title: 'Fitting an image into the frame (imageFit)',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result: 'The whole image fits inside the placeholder’s frame, proportions preserved.',
        note: '`fillWidth` (the default) — the frame’s width, the height by proportions; `contain` — fit the whole image; `fill` — stretch it over the whole frame.',
      },
      {
        id: 'media-qrcode',
        title: 'QR code',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'INV-2026-0042' }),
        result: 'The placeholder picture is replaced with a QR code with the value INV-2026-0042.',
        note: 'Other types: `ean13`, `code128`, `datamatrix`, `pdf417` and the rest from the Carbone documentation. Options are separated by commas: `{d.v:barcode(ean13, includetext:true, scale:2)}`; `width` and `height` are in mm, `scale` is 1 to 10 (3 by default), the colors `barcolor`, `textcolor`, `backgroundcolor` are `#RRGGBB`, `eclevel:H` is for QR. A value that cannot be encoded (letters in `ean13`) is a template error. `barcode` in ordinary text is a template error saying that a barcode goes in a picture’s alt text; barcode fonts are not supported.',
      },
      {
        id: 'media-color-cell',
        title: 'Cell color from the data (:color)',
        template: L(
          '| Task | Status |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: 'Report', status: 'done', color: '#C6EFCE' },
            { name: 'Reconciliation', status: 'overdue', color: 'FFC7CE' },
          ],
        }),
        result: L('| Task | Status |', '| Report | done |', '| Reconciliation | overdue |'),
        note: 'The tag prints nothing; it colors what it stands in: `color(p)` — the paragraph (the default), `cell` — the cell, `row` — the table row, `shape` — the shape (PPTX, ODP, ODT), `part` — a text fragment (ODT only). The second argument is what to color: `text` (the default), `background`, `highlight` (not in DOCX), `border` — the shape outline (PPTX). In DOCX, only `text` and `background`, and `shape` is not supported; in PPTX, `p` with `background` is not supported. The color is 6 hex digits with or without `#`; any other value gives gray `#888888`. In XLSX and ODS it is a template error.',
      },
      {
        id: 'media-default-url',
        title: 'Fallback link (:defaultURL)',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: 'not a url' }),
        result: 'https://example.com',
        note: "Usually the tag is used as a hyperlink address: in Word — “Insert” → “Link”, and in the “Address” field — `{d.site:defaultURL('https://example.com')}`. A link address from the data is checked: `https://` is added if there is no scheme; `http`, `https`, `mailto`, `tel` are allowed. An invalid address — `javascript:`, `localhost`, an IP address or a name without a top-level domain (`http://server:8080`) — is replaced with the `:defaultURL` value (it can be a field: `:defaultURL(.fallback)`), or with `#` if there is none. Relative addresses and anchors (`#section`, `../file.pdf`) also become `#`. In an address with a static part (`https://site.com/?id={d.id}`), the tag value is encoded and the whole address is checked; a tag at the very start of the address (`{d.base}/items/{d.id}`) is inserted as is.",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Word and Excel charts',
    intro: [
      'Word and Excel charts are filled with report data. Draw the chart as usual and write tags into its data as loop rows, as in a table: a row with `[i]`, and under it a row with `[i+1]`. In Word, the tags go in the chart’s data sheet: right-click the chart → “Edit Data”. In Excel, they go in the sheet cells the chart refers to.',
      'After the report is built, the chart series cover all data rows, and the values stored in the chart are recalculated: the chart is correct both in PDF and when opened in Word or Excel. In Word, “Edit Data” shows the report data. Rows below the loop shift together with the references to them. An empty array gives a chart without points. All common types work: column and bar, line, area, pie and doughnut, scatter and bubble, combo, 2-D and 3-D.',
      'Numbers: a cell of a value series becomes a number if the value looks like a number. Spaces and non-breaking spaces are removed, and a comma or a period is the decimal separator: `1234.5`, `1 234,5`, `-3`, `1e3`. Any other value (`10%`, `abc`, empty) stays text, and there is no point for it on the chart. Category labels do not change. In Excel, `:formatN` works as usual.',
      'Not supported: the new Office 2016 types (Treemap, Sunburst, Histogram, Box and Whisker and others), loops over columns and a number of series taken from the data — the template sets the series, multi-level category labels, Excel tables (“Format as Table”) and named ranges (they do not expand), charts linked to an external file, charts in PPTX, ODT, ODS, ODP. ECharts charts (`:chart`) are covered in the “ECharts charts” section.',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Chart in Word',
        template: L(
          '| | Amount |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', sum: 10 },
            { month: 'Feb', sum: 25 },
            { month: 'Mar', sum: 7 },
          ],
        }),
        result: L('| | Amount |', '| Jan | 10 |', '| Feb | 25 |', '| Mar | 7 |'),
        note: 'The table is the “Edit Data” sheet of a Word chart, as it looks after the report is built. The chart shows the “Amount” series with three columns: Jan, Feb, Mar. The cell above the labels can be left empty; the series name is in the first row.',
      },
      {
        id: 'chart-excel',
        title: 'Chart in Excel: two series, numbers from text',
        template: L(
          '| Month | Plan | Actual |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', plan: 100, fact: '98.5' },
            { month: 'Feb', plan: 120, fact: '1 250' },
            { month: 'Mar', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| Month | Plan | Actual |',
          '| Jan | 100 | 98.5 |',
          '| Feb | 120 | 1 250 |',
          '| Mar | 150 | |',
        ),
        note: 'The table is the Excel sheet cells the chart refers to. The “Plan” and “Actual” series cover three rows. The text `98.5` and `1 250` from the data becomes the numbers 98.5 and 1250, and “Actual” has no point for March. A comma is read as a decimal separator: `1,250` becomes 1.25, and `1,234.5` stays text — pass numbers without comma separators.',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'ECharts charts',
    intro: [
      'An ECharts chart is drawn in place of a placeholder picture — in DOCX, XLSX, PPTX, ODT, ODS, ODP. Insert any picture of the right size into the document and write the tag `{d.charts.sales:chart}` in its alt text, just as for images: in Word — “Format Picture” → “Alt Text”, in Excel — “Format Picture” → “Alt Text”, in LibreOffice — “Properties” → “Options” → “Text Alternative” (in Calc and Impress — “Title”). Without `width`/`height` in the definition, the chart takes the picture’s size; with them, the picture keeps the placeholder’s width, and the height follows the chart’s proportions. `:imageFit(contain)` and `:imageFit(fill)` work as for images.',
      'The easiest way is the builder: the “Charts” tab of the template editor. Choose a “List of rows” query, the label column and the series columns (or “Series from data” — the column that splits the rows into series), the type, title, legend, palette and number format; the preview is built on test data. The chart definition goes into the report data under the key `d.charts.<key>`; the tag is copied with the “Copy” button and is visible on the “Document” tab.',
      'You can pass a ready ECharts 5 definition from SQL: the tag value is `{ "type": "echarts@v5", "option": { … } }` or the definition itself with `series`; a string with JSON works too. `width` and `height` (100–4000) set the logical canvas size: ECharts fonts are measured in these pixels, so a larger size means smaller text; without them, the picture’s size is used. `theme` is `"dark"` or a theme object. The background is white by default.',
      'Limits: the definition is up to 1 MB, up to 20 series and 10,000 points, and is drawn in no more than 5 s; functions in the definition do not work (JSON only); the font is always Noto Sans, and other fonts in the definition are replaced with it. Pictures in the definition (`graphic`, `symbol: "image://…"`, patterns, `image` keys) can only be `data:image/png|jpeg|gif;base64,…`; an address, a file path or SVG is a template error. In builder charts, date labels are shown as DD.MM.YYYY from the date in the data, without time zone conversion — to group by day, cast the time to a date in SQL (`created::date`). An empty value removes the placeholder picture. An invalid definition is a template error with the tag; a `:chart` tag in ordinary text is a template error saying that a chart goes in a picture’s alt text.',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: 'Chart from the builder',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: 'Amount', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result:
          'The placeholder picture is replaced with an “Amount” column chart for the months Jan, Feb, Mar; the size is that of the placeholder.',
        note: 'This is what the data prepared by the builder (the “Charts” tab) looks like: `d.charts.<key>` is built from the query rows each time the report is generated and in the preview.',
      },
      {
        id: 'echarts-sql',
        title: 'Ready definition from SQL',
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
                    { name: 'North', value: 120 },
                    { name: 'South', value: 80 },
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
        result: 'The placeholder picture is replaced with a pie chart: North — 120, South — 80.',
        note: 'A definition without `type` and `option` but with `series` is treated as an ECharts definition. In a “Single row” query, the `chart` column becomes `d.report.chart`.',
      },
      {
        id: 'echarts-size',
        title: 'Canvas size and dark theme',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          'The placeholder picture is replaced with a line chart on a dark background; the width is that of the placeholder, the height follows the 800×400 proportions.',
        note: 'Without `width`/`height`, the canvas matches the placeholder picture. The `echarts@v5a` type is also drawn with ECharts 5.',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.field:html}` inserts formatted HTML from the data: paragraphs, headings, lists, tables, links, images. Works in DOCX and ODT — in text, table cells, headers and footers — and in PDF built from them. In an HTML template, the value is inserted as is. In XLSX, PPTX, ODS, ODP it is a template error saying that html is not supported in that format.',
      'The tag goes in paragraph text: in alt text, a link address or the report name it is a template error saying that html goes in paragraph text. `:html` is the last formatter in the tag: no other formatters go after it. Without options, the HTML is inserted as separate paragraphs in place of the tag; the paragraph text before and after the tag stays in its own paragraphs. An empty paragraph is added after each paragraph, heading, list and table. The font, size, color and alignment come from the tag: format the tag in the template, and the HTML gets the same formatting. If the HTML sets the same property, the tag wins.',
      'Text tags: `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`, `mark` (yellow highlight), `code`/`kbd`/`samp` (Courier New). Blocks: `p`, `br`, `pre`, `hr`, `blockquote`, headings `h1`–`h6` (the styles “Heading 1”–“Heading 6”), lists `ul`/`ol`/`li` with nesting, tables `table`/`tr`/`th`/`td` with `colspan` and `rowspan`, links `a href`, images `img`, checkboxes `<input type="checkbox" checked>`. From CSS, only the `style` attribute with the properties `color`, `background-color`, `break-before: page` and `break-after: page`. Other tags, classes and styles are dropped, and the text stays; `script` and `style` are removed together with their contents.',
      'Options, separated by commas: `inline` — inside the current paragraph; `nospace` — without empty paragraphs; `headingtheme:<prefix>` — heading styles `<prefix>1`…`<prefix>6`; `tabletheme:<style>` — table style (DOCX only); `quotetheme:<style>` — quote style. For example, `{d.h:html(nospace, tabletheme:TableGrid)}`. An unknown option is a template error.',
      'The `img` image: `src` is a data URI (PNG, JPEG, GIF) or an address on a host from `IMAGE_URL_ALLOWLIST`, as in the “Images, barcodes, colors, links” section. The size is `width` and `height` in pixels; without them, the width is 5 cm with the proportions preserved. An invalid image or a loading failure skips the picture with a warning in the API log, and the report is generated; an image larger than 10 MB is a template error.',
      'An empty value inserts nothing. A value larger than 1 MB, tag nesting deeper than 32 or more than 4096 unclosed tags is a template error. A table has no more than 63 columns: the contents of extra cells go into the last one. With `inline` inside a template hyperlink, links from the HTML become plain text. In ODT, checkboxes are the characters ☒ and ☐ (in DOCX they are Word checkboxes), `tabletheme` has no effect, and a heading inside a list item is large bold item text.',
    ],
    examples: [
      {
        id: 'html-text',
        title: 'Paragraphs and text formatting',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>The invoice is <b>paid</b>.</p><p>Term: <i>5 days</i>, <span style="color:#C00000">no prepayment</span>.</p>',
        }),
        result: L(
          'Two paragraphs, each followed by an empty one:',
          'The invoice is paid.',
          'Term: 5 days, no prepayment.',
          '“paid” is in bold, “5 days” in italics, “no prepayment” in red.',
        ),
        note: 'The tag stands in a paragraph of its own: all of the HTML gets its formatting (font, size, alignment). The `nospace` option removes the empty paragraphs.',
      },
      {
        id: 'html-list',
        title: 'Lists',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>Delivery</li><li>Installation<ul><li>floor 1</li><li>floor 2</li></ul></li></ul><ol><li>Sign the acceptance form</li><li>Pay</li></ol>',
        }),
        result: L(
          '• Delivery',
          '• Installation',
          '    ◦ floor 1',
          '    ◦ floor 2',
          '1. Sign the acceptance form',
          '2. Pay',
        ),
        note: 'Bullets by level: •, ◦, ▪; numbers: 1., a., i. Each list is numbered afresh, including in each loop row. The item `<li><input type="checkbox" checked> done</li>` is shown as a checkbox without a bullet.',
      },
      {
        id: 'html-table',
        title: 'Table',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>Product</th><th>Qty</th></tr><tr><td>Cable</td><td>10</td></tr><tr><td colspan="2">Total: 10</td></tr></table>',
        }),
        result: L('| Product | Qty |', '| Cable | 10 |', '| Total: 10 |'),
        note: 'The table spans the full text width with equal columns, `th` in bold, and “Total” spans two columns. In DOCX — the `tabletheme` style, otherwise the document’s default table style (except “Normal Table” without borders), otherwise “Table Grid” (solid borders); in ODT — thin borders. A `caption` becomes a paragraph above the table.',
      },
      {
        id: 'html-link',
        title: 'Links and a fallback address',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>The contract is <a href="site.com/doc">on the website</a>, the guide is <a href="javascript:alert(1)">here</a>.</p>',
        }),
        result: L(
          'The contract is on the website, the guide is here.',
          '“on the website” leads to https://site.com/doc, “here” to https://example.com.',
        ),
        note: 'Addresses are checked the same way as template links: `https://` is added if there is no scheme; `http`, `https`, `mailto`, `tel` are allowed. An invalid address (`javascript:`, `localhost`, an anchor `#section`) is replaced with the `:defaultURL` value, or with `#` if there is none.',
      },
      {
        id: 'html-inline',
        title: 'Inside a paragraph (inline)',
        rich: true,
        template: 'Status: {d.status:html(inline)}, see above.',
        data: j({ status: '<b>paid</b> <i>in part</i>' }),
        result: L(
          'Status: paid in part, see above.',
          'One paragraph; “paid” in bold, “in part” in italics.',
        ),
        note: 'In `inline` mode, only `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u` work. Other tags are dropped and the text stays; `br` and paragraph boundaries become spaces.',
      },
      {
        id: 'html-nospace',
        title: 'Headings without empty paragraphs (nospace)',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>Terms</h2><p>Payment within 5 days.</p>' }),
        result: L(
          'Terms — “Heading 2” style',
          'Payment within 5 days.',
          'There is no empty paragraph between or after them.',
        ),
        note: 'A heading style missing from the template is created as a simple one: bold, 20/16/14/13/12/11 pt for `h1`–`h6`. Use your own styles with the `headingtheme:<prefix>` option: `{d.terms:html(headingtheme:Report)}` takes the styles `Report1`…`Report6`.',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF: PDF/A, watermark, page numbers, attachments, password',
    intro: [
      'PDF settings are set on the “PDF” tab of the template editor and apply to the report PDF: in the preview, when generating and when downloading. “Save as” DOCX/XLSX… gives a file without them.',
      'PDF/A-2b is a format for archiving and electronic document exchange. When PDF/A is on, attached files must be PDF/A too (this is read from the file’s metadata).',
      'The watermark and the metadata (title, author, subject, keywords) can contain `{d.field}` and `{d.list[0].field}` tags — without formatters or loops. An empty tag value in the watermark removes the watermark: this way “DRAFT” appears only on documents that are not yet approved. Characters missing from the PDF font (emoji, CJK characters) in the data are replaced with “?”.',
      'Page numbering runs through the whole document together with the attached files: `{page}` is the page number, `{pages}` the total number of pages; the first page can be left unnumbered. Attached PDFs (up to 10 files of 20 MB each, up to 500 pages in total) are added to the start or the end of the report; password-protected files are not accepted.',
      'Protection: a password to open (one per template, 4–64 characters, not starting with “-”) and restrictions on printing, copying text and editing. Restrictions without a password do not lock the document — PDF viewers enforce them. Protection applies to generated reports; the preview is shown without it. PDF/A and protection are incompatible. The password is stored encrypted, is not shown in the dialog, and is not transferred when the template is moved to another environment — set it there again.',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'Document number in the PDF title',
        template: 'Invoice No. {d.number}',
        data: j({ number: '42', status: 'DRAFT' }),
        result: 'Invoice No. 42',
        note: 'The same tag in the “Title” field of the “PDF” tab gives the document title “Invoice No. 42”, and `{d.status}` in the watermark field gives the watermark “DRAFT”. Formatters (`{d.sum:formatC}`) are not supported in PDF fields.',
      },
    ],
  },
  {
    id: 'signature',
    title: 'Electronic signature',
    intro: [
      'The PDF signature is PAdES with the user’s certificate from a `.p12` (`.pfx`) file. Under Russian Federal Law No. 63-FZ, this is an advanced non-qualified electronic signature: its legal force within the organization and with counterparties comes from an agreement between the parties.',
      'Signing method: on the “PDF” tab, the “Signing method” field selects “.p12 certificate (signature in the PDF)” or “GOST, CryptoPro (.sig file)”. With GOST, the key stays on the user’s computer: the user needs CryptoPro CSP 5.0, CryptoPro CAdES Browser plug-in with the browser extension, and a GOST R 34.10-2012 certificate in the “Personal” store; the result is a PDF with a stamp and a detached `.sig` signature. The administrator places the `cadesplugin_api.js` script (we do not ship it), see `docs/operations/gost-signature.md` for details; without it, the signing dialog reports that the plug-in was not found. The server verifies the signature but not the certificate chain or revocation — check those on the Russian public services portal Gosuslugi (gosuslugi.ru/pgu/eds).',
      'How to enable: the “PDF” tab of the template editor → “Electronic signature” → “Allow signing the PDF”, then the stamp position (bottom left, bottom center, bottom right). Signing is incompatible with the password and restrictions in the “Protection” block; it is compatible with PDF/A. The setting applies to new reports; earlier runs do not change.',
      'How to sign: the user uploads their certificate on the “My signature” page, generates the report and clicks “Sign PDF” (or “Sign…” in the history). The key password is entered for each signature and is never stored; after five wrong passwords within 15 minutes, signing is blocked for the rest of that window. Only the user who generated a run can sign it; a run cannot be signed twice. The signed file: “Download signed PDF”, or “Signed PDF” in the history.',
      'The stamp is a 250 × 80 pt frame at the bottom of the last page (left, center or right) on top of the content: serial number, owner, certificate validity period, signing time. The page area under it is not cleared — leave 110 pt free at the bottom of the last page.',
      'Timestamp: if the administrator has configured a timestamp service (`SIGN_TSA_URL`), it confirms the signing time; if the service is unavailable, the report is not signed — the error “the timestamp service is unavailable”.',
      'Verification: Adobe Acrobat Reader shows the signature in the “Signatures” panel. It is “valid” if the recipient trusts the certificate authority’s certificate; for self-signed and internal certificates, add the root certificate to the trusted ones.',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: 'Not available in the free edition',
    intro: [
      'These tags are disabled in the free edition of Carbone. If such a tag is in the template, the report and the preview are not generated, and the error from the example is shown.',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: 'Region names (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'US' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Take the name from a lookup table in SQL.',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead:
          'Disabled; a template with it is not generated. An image from the data is inserted as is — rotate it before passing it to the report.',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          'The old `bindColor` gives no error, but does not change the color either. Use `:color` (the “Images, barcodes, colors, links” section).',
      },
      {
        id: 'na-svg',
        title: 'SVG and barcode fonts',
        instead:
          'An SVG image from the data is a template error saying that SVG is not supported: pass PNG, JPEG or GIF. Barcode fonts are not supported — use `:barcode` in a placeholder picture.',
      },
      {
        id: 'na-sort-desc',
        title: 'Descending sort',
        instead:
          '`[-qty, i]` silently keeps the original order: Carbone cannot do this yet. Sort in SQL: `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'TXT output',
        instead:
          'Cyrillic text turns into “??????”. Our system has no TXT format — use PDF or DOCX.',
      },
    ],
  },
];
