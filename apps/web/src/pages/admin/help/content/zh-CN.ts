import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API message for a disabled formatter (apps/api/src/modules/carbone/community.ts, errors catalog). */
const community = (name: string) => `模板使用了 ${name}——Carbone 免费版不可用，请参阅“模板帮助”`;

const CARS = [
  { brand: '比亚迪', qty: 3, ok: true },
  { brand: '特斯拉', qty: 1, ok: false },
  { brand: '比亚迪', qty: 2, ok: true },
  { brand: '吉利', qty: 5, ok: true },
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
  '本页只介绍在我们的 Carbone（免费版，Community Edition）上验证过的功能。免费版缺少的功能汇总在最后一节，并附有替代方案。Carbone 引擎本身的错误消息（图片、条形码、颜色、图表、HTML）在“模板错误：”之后以俄语显示；本帮助说明这些消息的含义。',
  '报表数据是对象 `d`。模板中每个 SQL 查询的结果存放在其键下：“行列表”模式下为数组，“单行”模式下为对象（或空值）。报表参数位于 `d.params`。',
  '“文档”选项卡右侧面板中的标签和“常用结构”可以用鼠标直接拖入文档——标签会插入到松开鼠标按钮的位置。在“常用结构”中，请将 `字段` 和 `数组` 替换为自己的名称。',
  '在示例中，以“|”开头的行是 Word 表格的一行，单元格之间用“|”分隔。其他行是独立的段落。',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: '基础知识',
    intro: [
      '标签 `{d.field}` 插入数据中的值。用点分隔的路径进入嵌套对象，`[数字]` 指向数组元素（从零开始计数），`[field=value]` 按条件指向元素。',
    ],
    examples: [
      {
        id: 'basics-field',
        title: '字段值',
        template: '客户：{d.name}',
        data: j({ name: '张伟' }),
        result: '客户：张伟',
        note: '数据中没有该字段时，插入空字符串，不会报错。',
      },
      {
        id: 'basics-nested',
        title: '嵌套对象',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: '上海' } } }),
        result: '上海',
      },
      {
        id: 'basics-search',
        title: '按条件取数组元素',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "字符串值要加引号：`{d.items[code='X'].name}`。按序号取元素：`{d.items[0].name}`（从零开始计数）。",
      },
      {
        id: 'basics-params',
        title: '报表参数',
        template: "期间自 {d.params.from:formatD('YYYY-MM-DD')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: '期间自 2026-03-01',
        note: "报表参数以其名称存放在 `d.params` 中。系统不会自动填充 `{c.…}` 标签，只有 `{c.now}` 例外——即报表生成的时间：`{c.now:formatD('YYYY-MM-DD')}`。只能通过 `:set` 在 `c` 中存放自己的值（参见“合计与分组”一节）。",
      },
      {
        id: 'basics-ifempty',
        title: '默认值',
        template: "付款日期：{d.paid_on:formatD('YYYY-MM-DD'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: '付款日期：—',
        note: "`ifEmpty` 放在链的最后：`{d.paid_on:ifEmpty('—'):formatD('YYYY-MM-DD')}` 会输出“Invalid Date”。空值指 null、空字符串、空数组和缺失的字段；0 仍为 0。",
      },
      {
        id: 'basics-alias',
        title: '别名',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: '李娜' } }),
        result: '李娜',
        note: '别名用标签 `{#名称 = 路径}` 声明，该标签本身不输出任何内容。声明之后，用 `{$名称…}` 代替路径。',
      },
    ],
  },
  {
    id: 'tables',
    title: '表格',
    intro: [
      '表格行会为数组的每个元素重复一次：该行包含带 `[i]` 的标签，下一行至少包含一个带 `[i+1]` 的标签。`[i+1]` 行不会出现在结果中。没有 `[i+1]` 时，Carbone 返回错误“has no corresponding [i+1]”。`[i+1]` 行中只放 `[i+1]` 标签，其他单元格留空：其中出现 `[i]` 标签会导致错误“is in the [i+1] row”。',
      '段落也以同样方式重复：一个带 `[i]` 的段落，后面跟一个带 `[i+1]` 的段落。',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: '由数组生成表格行',
        template: L(
          '| 品牌 | 数量 |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| 品牌 | 数量 |',
          '| 比亚迪 | 3 |',
          '| 特斯拉 | 1 |',
          '| 比亚迪 | 2 |',
          '| 吉利 | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: '嵌套循环',
        template: L(
          '{d.groups[i].name}：',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1：', '- a', '- b', 'G2：', '- c', 'G3：'),
        note: '空的嵌套数组不产生任何行——“G3”下没有行，也不会报错。',
      },
      {
        id: 'tables-nested-rows',
        title: '表格行中的嵌套循环',
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
        title: '空数组',
        template: L(
          '之前',
          '| 品牌 |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          '之后',
          "{d.cars:ifEM():show('无数据'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('之前', '| 品牌 |', '之后', '无数据'),
        note: "循环行消失，表头保留；键可以完全不存在，结果相同。没有 `elseShow('')` 时，数组不为空时 `ifEM` 会输出值本身。",
      },
      {
        id: 'tables-numbering',
        title: '行号',
        template: L(
          '| 序号 | 品牌 |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| 序号 | 品牌 |',
          '| 1 | 比亚迪 |',
          '| 2 | 特斯拉 |',
          '| 3 | 比亚迪 |',
          '| 4 | 吉利 |',
        ),
        note: '编号按实际输出的行依次为 1、2、3……，在带筛选的循环中也一样，不会跳号。标签 `{d.cars[i].i}` 不输出任何内容。旧写法 `{d.cars[i].brand:print(.i):add(1)}` 也可用，但 `.i` 是源数组中的位置，因此循环带筛选时编号会跳号。括号中的数字（如旧版 Carbone 中的 `count(0)`）会被忽略：编号总是从 1 开始。请在 `count()` 标签中重复循环的筛选和排序（`{d.cars[i, ok=true].brand:count()}`），否则该行会对自己的集合编号。被 `drop(row)` 删除的行仍会占用编号，因此编号会跳号；请改用循环筛选来选择行。编号、合计和小计：参见“合计与编号”一节。',
      },
      {
        id: 'tables-filter',
        title: '筛选行',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| 比亚迪 |', '| 比亚迪 |', '| 吉利 |'),
        note: "比较 `[i, qty > 1]`、字符串 `[i, brand='比亚迪']` 以及用逗号分隔的多个条件也以同样方式工作——它们按“与”组合；没有“或”，请在 SQL 中添加标志字段。可以用这种方式或用 `drop(row)` 标签隐藏表格行；在表格中使用 `hideBegin`/`hideEnd` 会留下空行（参见“条件”一节）。",
      },
      {
        id: 'tables-sort',
        title: '排序',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('特斯拉', '比亚迪', '比亚迪', '吉利'),
        note: '只能升序。`[-qty, i]` 会悄无声息地保持原有顺序——请在 SQL 中降序排序（`order by … desc`）。',
      },
    ],
  },
  {
    id: 'formatting',
    title: '格式化',
    intro: [
      "格式化器写在冒号之后：`{d.field:formatD('YYYY-MM-DD')}`。格式化器可以串联，按从左到右的顺序应用。",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: '带月份的日期',
        template: "{d.date:formatD('YYYY年M月D日')}",
        data: j({ date: '2026-03-08' }),
        result: '2026年3月8日',
        note: "`formatD('YYYY年M月D日 dddd')` 得到“2026年3月8日 星期日”，`formatD('YYYY年M月')` 得到“2026年3月”。格式字符串中的汉字按原样输出。",
      },
      {
        id: 'fmt-date-short',
        title: '数字日期',
        template: "{d.date:formatD('YYYY-MM-DD')}",
        data: j({ date: '2026-03-08' }),
        result: '2026-03-08',
      },
      {
        id: 'fmt-date-time',
        title: '日期和时间',
        template: "{d.at:formatD('YYYY-MM-DD HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '2026-03-08 23:30',
        note: '时间按服务器时区显示（`TZ`，默认为 Europe/Moscow）。请传入带偏移量（`+03:00`）或 UTC（`Z`）的时间。',
      },
      {
        id: 'fmt-date-naive',
        title: '不带偏移量的时间',
        template: "{d.at:formatD('YYYY-MM-DD HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '2026-03-09 02:30',
        note: '不带偏移量的时间被视为 UTC，并平移 3 小时。请传入带偏移量的时间，或不带时间的日期。',
      },
      {
        id: 'fmt-number',
        title: '数字',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1,234,567.89',
        note: '千位分隔符和小数点取决于报表语言：中文用逗号（,）分隔千位，用句点（.）分隔小数。`formatN(0)` 四舍五入到整数：1234567.5 →“1,234,568”。',
      },
      {
        id: 'fmt-money',
        title: '人民币金额',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '1,234,567.89 ¥',
        note: "`formatC()` 输出报表语言的货币——中文为人民币，符号“¥”放在金额之后；模板的报表语言改变时，货币也随之改变。`formatC(0)` 去掉角分：1234.5 →“1,235 ¥”。`formatC('LL')` 写出货币名称：“1,234,567.89 yuans”。货币名称始终为英文（“1.00 yuan”“1,234,567.89 yuans”），不会输出“元”，因此中文报表不要使用 `formatC('M')` 和 `formatC('LL')`。",
      },
      {
        id: 'fmt-convcurr',
        title: '换算为其他货币',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '145.66939192641797',
        note: "Carbone 按内置汇率从报表语言的货币（中文为人民币）换算：汇率不会更新，我们的系统也不传入自己的汇率。`formatC(2, 'USD')` 以同样方式静默换算：1000 →“145.67 $”。其他货币的金额请在 SQL 中计算。",
      },
      {
        id: 'fmt-case',
        title: '字母大小写',
        template: '{d.name:ucWords()}',
        data: j({ name: 'zhang wei' }),
        result: 'Zhang Wei',
        note: '还有 `ucFirst()` →“Zhang wei”、`upperCase()`、`lowerCase()`。汉字没有大小写，保持不变；西里尔字母等其他字母表的字母也能正确处理。',
      },
      {
        id: 'fmt-ellipsis',
        title: '截断字符串',
        template: '{d.title:ellipsis(5)}',
        data: j({ title: '银行对账单明细' }),
        result: '银行对账单...',
        note: "还有 `substr(0, 2)` →“银行”，`padl(6, '0')` 将“42”变为“000042”，以及 `prepend('编号 ')`、`append(' 元')`、`replace('-', '/')`。长度按字符计算，一个汉字算一个字符。",
      },
      {
        id: 'fmt-math',
        title: '算术运算',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`、`sub`、`mul`、`div` 接受数字或同级字段（`.b`）；表达式中不能使用括号。结果不带格式输出——显示时请加上 `formatN`。除以零时静默返回原数。',
      },
      {
        id: 'fmt-array-join',
        title: '用逗号分隔的列表',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['红', '绿', '蓝'] }),
        result: '红, 绿, 蓝',
        note: "默认分隔符是英文逗号加空格；中文列表可用 `arrayJoin('、')`：“红、绿、蓝”。对象数组：`{d.items:arrayMap(', ', ':', 'name')}`——name 字段的值，用逗号分隔。",
      },
      {
        id: 'fmt-multiline',
        title: '多行文本',
        template: '{d.text:convCRLF}',
        data: j({ text: '第一行\n第二行' }),
        result: L('第一行', '第二行'),
        note: '没有 `convCRLF` 时，数据中的换行在 Word 中不可见。',
      },
    ],
  },
  {
    id: 'conditions',
    title: '条件',
    intro: [
      '条件检查一个值（`ifEQ`、`ifNE`、`ifGT`、`ifGTE`、`ifLT`、`ifLTE`、`ifIN`、`ifNIN`、`ifEM`、`ifNEM`），并输出 `show(…)` 或 `elseShow(…)`。条件用 `and(.field)` 和 `or(.field)` 组合。',
      '段落和部分文本用 `showBegin`/`showEnd` 和 `hideBegin`/`hideEnd` 隐藏。表格行用循环筛选（参见“表格”一节）或 `drop(row)` 隐藏；整个段落、表格或图片用 `drop`/`keep` 删除。',
    ],
    examples: [
      {
        id: 'cond-if',
        title: '按条件显示文本',
        template: "{d.status:ifEQ('paid'):show('已付款'):elseShow('未付款')}",
        data: j({ status: 'new' }),
        result: '未付款',
        note: "没有 `elseShow` 时，条件不成立会输出值本身：对于 2，`{d.v:ifEQ(1):show('一')}` 得到“2”。请加上 `elseShow('')`。",
      },
      {
        id: 'cond-and',
        title: '两个条件',
        template: "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('可以发货'):elseShow('暂缓发货')}",
        data: j({ qty: 2, paid: true }),
        result: '可以发货',
        note: '可以用 `or` 代替 `and`：`…:or(.paid):ifEQ(true)…`。',
      },
      {
        id: 'cond-inline',
        title: '按条件显示部分文本',
        template: '合计{d.vat:ifEQ(true):showBegin}（含增值税）{d.vat:showEnd}。',
        data: j({ vat: false }),
        result: '合计。',
      },
      {
        id: 'cond-paragraphs',
        title: '隐藏段落',
        template: L(
          '发票',
          '{d.paid:ifEQ(true):hideBegin}',
          '请在 5 天内付款。',
          '{d.paid:hideEnd}',
          '谢谢！',
        ),
        data: j({ paid: true }),
        result: L('发票', '谢谢！'),
        note: '带 `hideBegin`/`hideEnd` 标签的段落也会消失。',
      },
      {
        id: 'cond-drop-p',
        title: '删除段落（drop）',
        template: L('之前', '{d.f:ifEQ(true):drop(p)}要删除的段落', '之后'),
        data: j({ f: true }),
        result: L('之前', '之后'),
        note: '把标签放在该段落中，并放在格式化器链的最后。条件是 `ifEQ`、`ifGT` 等的结果。没有条件时，由值本身决定：`true`、非零数字、除 `"0"` 和 `"false"` 以外的非空文本以及非空列表会删除段落；`false`、`0`、空文本、`"0"`、`"false"` 以及空值或缺失的值不会删除——数据库中的 0/1 标志可以直接使用。适用于 DOCX、ODT、PPTX、ODP；XLSX 和 ODS 没有段落。',
      },
      {
        id: 'cond-keep-p',
        title: '仅在条件成立时保留段落（keep）',
        template: L('之前', '{d.f:ifEQ(true):keep(p)}要保留的段落', '之后'),
        data: j({ f: false }),
        result: L('之前', '之后'),
        note: '`keep` 与 `drop` 相反：只有条件成立时段落才保留。`drop(table)`、`drop(img)`、`drop(shape)`、`drop(chart)` 的用法相同；在 ODS 中还有 `drop(sheet)`，在 ODP 中还有 `drop(slide)`。',
      },
      {
        id: 'cond-drop-row',
        title: '删除表格行（drop(row)）',
        template: L(
          '| 品牌 | 数量 |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| 品牌 | 数量 |', '| 比亚迪 | 3 |', '| 比亚迪 | 2 |', '| 吉利 | 5 |'),
        note: '“特斯拉”行被整行删除，表格格式不会被破坏。与 `hideBegin` 不同，`drop(row)` 可以在循环中使用。如果表格的所有行都被删除，表格也会消失。`drop(col)` 删除一列；在 XLSX 中，合并单元格和自动筛选不会重新计算，在带格式的表格（“套用表格格式”）所在的工作表上不能使用 `drop(col)`。不带条件的标志也可用：`{d.cars[i].archived:drop(row)}` 删除 `archived` = 1 的行，保留为 0 的行。累计合计、`:count()` 以及基于 `[]` 的 `aggSum` 合计也会计入被删除的行——要让某行既不出现在表格中也不计入合计，请用循环筛选选择行，并在合计中使用相同的筛选（`[ok=true]`）。',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: '在表格行中使用 hideBegin（不要这样做）',
        template: L(
          '| 品牌 | 数量 |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| 品牌 | 数量 |', '| 比亚迪 | 3 |', '| |', '| 比亚迪 | 2 |', '| 吉利 | 5 |'),
        note: '“特斯拉”行的位置上留下一个只有一个单元格的空行，表格格式被破坏。请用循环筛选（`{d.cars[i, ok=true].brand}`）或 `drop(row)` 隐藏行。',
      },
    ],
  },
  {
    id: 'aggregates',
    title: '合计与编号',
    intro: [
      '聚合器对整个集合进行计算：`aggSum`——求和，`aggAvg`——平均值，`aggMin`/`aggMax`——最小值和最大值，`aggCount`——元素个数，`aggCountD`——不同值的个数，`aggStr`/`aggStrD`——用逗号分隔的值（`D`——不重复）。`cum…` 版本（`cumSum`、`cumCount`、`cumCountD`）给出循环各行的累计值，`:count()` 给出行号。',
      '路径中的方括号决定模式。`[]` 是整个数组的一个合计（可放在文档任意位置，包括表格之后），`[sort>1]` 或 `[ok=true]` 只对选中的元素合计。循环中的 `[i]` 是每行一个值；累计合计、`:count()` 以及用 `aggSum(.brand)` 分组都需要 `[i]`。',
      '结果是未经四舍五入的数字：请在聚合器之后用格式化器格式化，例如 `:aggAvg:formatN(2)`。求和时跳过非数字值（文本、空值、`null`）；字符串形式的数字（`"2"`）按数字计算。空数组或缺失的键不会报错：`aggSum`、`aggCount`、`aggCountD`、`cumSum` 得到 0；`aggAvg`、`aggMin`、`aggMax`、`aggStr`、`aggStrD` 得到空值。',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: '循环外的合计',
        template: '合计：{d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: '合计：11',
        note: '合计与标签在文档中的位置无关，也与同一数组是否由循环输出无关。',
      },
      {
        id: 'agg-filter',
        title: '带筛选的合计',
        template: '已付款：{d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: '已付款：10',
        note: "方括号中的条件与循环中的相同：`[qty>1]`、`[brand='比亚迪']`，多个条件用逗号分隔。文档中的循环筛选不影响合计，但标签本身中的筛选会影响。",
      },
      {
        id: 'agg-others',
        title: '平均值、最大值、个数',
        template: L(
          '项数：{d.cars[].qty:aggCount}，平均 {d.cars[].qty:aggAvg:formatN(2)}',
          '最大 {d.cars[].qty:aggMax}，最小 {d.cars[].qty:aggMin}',
          '不同品牌：{d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L('项数：4，平均 2.75', '最大 5，最小 1', '不同品牌：3'),
        note: '`aggCount` 统计所有元素，`aggCountD` 统计不同的值。格式化器也可以放在聚合器之前：`{d.cars[].qty:mul(2):aggSum}` 对加倍后的值求和。',
      },
      {
        id: 'agg-str',
        title: '值连成一行',
        template: L("品牌：{d.cars[].brand:aggStrD(', ')}", "全部：{d.cars[].brand:aggStr(' | ')}"),
        data: j({ cars: CARS }),
        result: L('品牌：特斯拉, 比亚迪, 吉利', '全部：比亚迪 | 特斯拉 | 比亚迪 | 吉利'),
        note: "不带参数时，分隔符是英文逗号加空格；中文顿号写作 `aggStrD('、')`。`aggStrD` 按值最后一次出现的顺序排列。",
      },
      {
        id: 'agg-total-row',
        title: '表格下方的“合计”行',
        template: L(
          '| 品牌 | 数量 |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| 合计 | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| 品牌 | 数量 |',
          '| 比亚迪 | 3 |',
          '| 特斯拉 | 1 |',
          '| 比亚迪 | 2 |',
          '| 吉利 | 5 |',
          '| 合计 | 11 |',
        ),
        note: '把“合计”行做成 `[i+1]` 行下方的普通 Word 表格行。如果在循环行中写 `{d.cars[i].qty:aggSum}`，每一行都会显示同一个总计：`[i]` 覆盖整个集合，而不是上方的行。',
      },
      {
        id: 'agg-cum',
        title: '累计合计',
        template: L(
          '| 品牌 | 数量 | 累计 |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| 品牌 | 数量 | 累计 |',
          '| 比亚迪 | 3 | 3 |',
          '| 特斯拉 | 1 | 4 |',
          '| 比亚迪 | 2 | 6 |',
          '| 吉利 | 5 | 11 |',
        ),
        note: '累计合计按 `cumSum` 标签本身方括号给出的顺序和行集合计算。如果循环带筛选或排序（`[i, ok=true]`、`[qty, i]`），请在累计标签的方括号中重复相同的条件（包括排序）：循环的排序对它不起作用。用 `[]` 代替 `[i]` 是模板错误。',
      },
      {
        id: 'agg-partition',
        title: '行中的分组合计',
        template: L(
          '| 品牌 | 数量 | 本品牌合计 | 品牌内序号 |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| 品牌 | 数量 | 本品牌合计 | 品牌内序号 |',
          '| 比亚迪 | 3 | 5 | 1 |',
          '| 特斯拉 | 1 | 1 | 1 |',
          '| 比亚迪 | 2 | 5 | 2 |',
          '| 吉利 | 5 | 5 | 1 |',
        ),
        note: '参数 `(.brand)` 是从循环元素出发的路径：聚合器对每个值分别计算。只在 `[i]` 循环中有效；值按严格相等比较：数字 1 和字符串 "1" 是不同的组。参数必须是带点的路径；`aggSum(brand)` 是错误的。',
      },
      {
        id: 'agg-nested',
        title: '嵌套数组的小计',
        template: L(
          '{d.groups[i].name}：{d.groups[i].items[].qty:aggSum}',
          '- {d.groups[i].items[i].x} {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
          '合计：{d.groups[].items[].qty:aggSum}',
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
        result: L('G1：5', '- a 2', '- b 3', 'G2：4', '- c 4', 'G3：0', '合计：9'),
        note: '外层数组用 `[i]`、嵌套数组用 `[]`，得到每个组内的小计；空组得到 0。连续两个 `[]` 得到所有组的总计。不能用按字段（如 `[brand]`）的外层循环分组求小计——请用 `:set` 分组并对每组计算 `aggSum`（“合计与分组”一节中的“分组小计（:set）”示例），或在 SQL 中分组。如果嵌套路径经过对象（`{d.items[].sub.qty:aggSum}`），在 `[]` 下会出错：请用 `print(.sub.qty)` 把字段提上来，或使用 `[i]`。',
      },
    ],
  },
  {
    id: 'totals',
    title: '合计与分组',
    intro: [
      '合计、小计和编号也可以在模板中完成——参见“合计与编号”一节。带小计的分组也可以在模板中构建（`:set` + `aggSum`）。模板无法处理的情况才需要 SQL：带“或”条件的筛选和降序排序；数据量很大（数万行）时，带方括号筛选的合计在 SQL 中计算更快。',
      'PostgreSQL 的数字（`numeric`、`bigint`）在数据中是数字，`date` 是 YYYY-MM-DD 格式的字符串，`json` 是对象和数组。',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: '用单独的查询计算合计',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: '项数：{d.totals.positions}，总金额 {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: '项数：3，总金额 13,775.00 ¥',
        note: '数组元素的个数也可以在模板中获取：`{d.items:len()}`。',
      },
      {
        id: 'totals-rownum',
        title: '来自 SQL 的行号',
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
          '| 序号 | 商品 | 数量 |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: '复印纸', qty: 10 },
            { n: 2, name: '硒鼓', qty: 2 },
            { n: 3, name: '圆珠笔', qty: 50 },
          ],
        }),
        result: L(
          '| 序号 | 商品 | 数量 |',
          '| 1 | 复印纸 | 10 |',
          '| 2 | 硒鼓 | 2 |',
          '| 3 | 圆珠笔 | 50 |',
        ),
        note: '在 `where` 中选择行，而不是用模板筛选——这样编号不会跳号。',
      },
      {
        id: 'totals-groups',
        title: '带小计的分组（json_agg）',
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
          '{d.groups[i].company}——{d.groups[i].subtotal:formatC()}',
          '- {d.groups[i].items[i].name}：{d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].name}',
          '{d.groups[i+1].company}',
        ),
        data: j({
          groups: [
            {
              company: '华星科技有限公司',
              subtotal: 13775,
              items: [
                { name: '复印纸', qty: 10 },
                { name: '硒鼓', qty: 2 },
                { name: '圆珠笔', qty: 50 },
              ],
            },
            {
              company: '远航贸易有限公司',
              subtotal: 34300,
              items: [
                { name: '办公桌', qty: 1 },
                { name: '椅子', qty: 2 },
                { name: '台灯', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          '华星科技有限公司——13,775.00 ¥',
          '- 复印纸：10',
          '- 硒鼓：2',
          '- 圆珠笔：50',
          '远航贸易有限公司——34,300.00 ¥',
          '- 办公桌：1',
          '- 椅子：2',
          '- 台灯：3',
        ),
        note: '分组小计由 `sum(…)` 计算，组内内容由 `json_agg` 收集。总计用“单行”模式的单独查询计算。',
      },
      {
        id: 'totals-set-group',
        title: '在模板中分组（:set）',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('比亚迪', '- 比亚迪 3', '- 比亚迪 2', '特斯拉', '- 特斯拉 1', '吉利', '- 吉利 5'),
        note: '组按首次出现的顺序排列；`:set` 标签不输出任何内容。请存放整个对象（`d.cars[]:set(…rows[])`），而不是单个字段。分组小计是对组内各行的 `aggSum`——参见下一个示例。',
      },
      {
        id: 'totals-set-subtotal',
        title: '分组小计（:set）',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}——数量 {c.g[i].rows[].qty:aggSum}',
          '{c.g[i+1].id}',
          '总数量：{d.cars[].qty:aggSum}',
        ),
        data: j({ cars: CARS }),
        result: L('比亚迪——数量 5', '特斯拉——数量 1', '吉利——数量 5', '总数量：11'),
        note: '`:set` 按品牌收集行，`{c.g[i].rows[].qty:aggSum}` 是每个组内的小计。`aggCount`、`aggAvg` 和其他聚合器的用法相同，组内各行可以用嵌套循环输出，如上一个示例所示。',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: '通过 :set 求和（错误做法）',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}合计：{c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: '合计：14',
        note: '正确的合计是 11：第一个元素被计算了两次。请用聚合器 `aggSum`（“合计与编号”一节）或在 SQL 中求和。',
      },
    ],
  },
  {
    id: 'media',
    title: '图片、条形码、颜色、链接',
    intro: [
      '数据中的图片或条形码会替换占位图片。在模板中插入任意一张尺寸合适的图片，并把标签写入其替代文字：在 Word 中，通过图片的替代文字（中文版 Word 中称为“替换文字”；右键单击图片，选择查看或编辑替代文字的命令）；在 LibreOffice 中，在图片的“属性”对话框中填写替代文字或描述字段；在模板编辑器中，在图片的高级设置中填写替代文字的描述字段。标签必须占满整个替代文字：混合文本（“照片 {d.name}”）会按原样输出，图片保留。同一个标签放在普通段落中只会输出值。',
      '数据中的图片是 data URI（`data:image/png;base64,…`；PNG、JPEG 或 GIF）或 `https://…` 地址。地址只从 `IMAGE_URL_ALLOWLIST` 设置中列出的主机加载；该设置默认为空，此时地址会导致模板错误。不支持 SVG。空值会删除占位图片。限制：每张图片 10 MB，每份报表 50 MB。适用于 DOCX、XLSX、PPTX、ODT、ODS、ODP；循环中的多张图片适用于 DOCX（图片环绕方式为“嵌入型”）和 ODT（锚定为“作为字符”）。',
      '纯文本值（既不是 `data:` 也不是 `http(s)://`）会写入替代文字，图片保留；空值会删除图片。无效的图片（损坏的 data URI、不在列表中的主机、错误的标签）是模板错误，错误文本中包含该标签，报表不会生成。如果无法从地址加载图片（超时、非 2xx 响应），该图片会被删除，报表照常生成。',
    ],
    examples: [
      {
        id: 'media-image',
        title: '来自数据的图片',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result: '占位图片被替换为该图片：宽度与占位图片相同，高度按图片比例计算。',
        note: '标签写在图片的替代文字中，而不是段落中。如果地址的主机列在 `IMAGE_URL_ALLOWLIST` 中，可以传入 `https://…` 地址代替 data URI。',
      },
      {
        id: 'media-image-fit',
        title: '图片适应框架（imageFit）',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result: '整张图片按原比例缩放，完整放入占位图片的框架内。',
        note: '`fillWidth`（默认）——框架的宽度，高度按比例；`contain`——完整放入整张图片；`fill`——拉伸铺满整个框架。',
      },
      {
        id: 'media-qrcode',
        title: '二维码',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'INV-2026-0042' }),
        result: '占位图片被替换为值为 INV-2026-0042 的二维码。',
        note: '其他类型：`ean13`、`code128`、`datamatrix`、`pdf417` 以及 Carbone 文档中的其他类型。选项用逗号分隔：`{d.v:barcode(ean13, includetext:true, scale:2)}`；`width` 和 `height` 以毫米为单位，`scale` 为 1 到 10（默认 3），颜色 `barcolor`、`textcolor`、`backgroundcolor` 为 `#RRGGBB`，`eclevel:H` 用于二维码。无法编码的值（`ean13` 中的字母）是模板错误。在普通文本中使用 `barcode` 是模板错误，错误消息说明条形码应放在图片的替代文字中；不支持条形码字体。',
      },
      {
        id: 'media-color-cell',
        title: '来自数据的单元格颜色（:color）',
        template: L(
          '| 任务 | 状态 |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: '月度报表', status: '已完成', color: '#C6EFCE' },
            { name: '对账', status: '已逾期', color: 'FFC7CE' },
          ],
        }),
        result: L('| 任务 | 状态 |', '| 月度报表 | 已完成 |', '| 对账 | 已逾期 |'),
        note: '该标签不输出任何内容，只为它所在的对象着色：`color(p)`——段落（默认），`cell`——单元格，`row`——表格行，`shape`——形状（PPTX、ODP、ODT），`part`——文本片段（仅 ODT）。第二个参数指定着色的部分：`text`（默认）、`background`、`highlight`（DOCX 中不可用）、`border`——形状轮廓（PPTX）。在 DOCX 中只能用 `text` 和 `background`，且不支持 `shape`；在 PPTX 中，`p` 不支持 `background`。颜色为 6 位十六进制数，可带或不带 `#`；其他值得到灰色 `#888888`。在 XLSX 和 ODS 中是模板错误。',
      },
      {
        id: 'media-default-url',
        title: '备用链接（:defaultURL）',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: '不是网址' }),
        result: 'https://example.com',
        note: "该标签通常用作超链接地址：在 Word 中选择“插入”→“链接”，在“地址”字段中填写 `{d.site:defaultURL('https://example.com')}`。来自数据的链接地址会经过检查：没有协议时加上 `https://`；允许 `http`、`https`、`mailto`、`tel`。无效地址——`javascript:`、`localhost`、IP 地址或没有顶级域名的名称（`http://server:8080`）——会被替换为 `:defaultURL` 的值（可以是字段：`:defaultURL(.fallback)`），没有时替换为 `#`。相对地址和锚点（`#section`、`../file.pdf`）也会变成 `#`。在带固定部分的地址中（`https://site.com/?id={d.id}`），标签值会被编码，并检查整个地址；位于地址最开头的标签（`{d.base}/items/{d.id}`）按原样插入。",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Word 和 Excel 图表',
    intro: [
      'Word 和 Excel 图表用报表数据填充。照常绘制图表，并像表格一样把标签作为循环行写入图表数据：一行带 `[i]`，其下一行带 `[i+1]`。在 Word 中，标签写在图表的数据表中：右键单击图表 →“编辑数据”。在 Excel 中，标签写在图表所引用的工作表单元格中。',
      '报表生成后，图表系列覆盖所有数据行，图表中保存的值会重新计算：无论在 PDF 中还是在 Word 或 Excel 中打开，图表都是正确的。在 Word 中，“编辑数据”显示报表数据。循环下方的行连同对它们的引用一起下移。空数组得到没有数据点的图表。所有常用类型都可用：柱形图和条形图、折线图、面积图、饼图和环形图、散点图和气泡图、组合图，二维和三维。',
      '数字：如果数值系列单元格中的值看起来像数字，它就会变成数字。空格和不间断空格会被去掉，逗号或句点作为小数分隔符：`1234.5`、`1 234,5`、`-3`、`1e3`。其他值（`10%`、`abc`、空值）保持为文本，图表上没有对应的数据点。类别标签不变。在 Excel 中，`:formatN` 照常可用。',
      '不支持：Office 2016 新增的图表类型（树状图、旭日图、直方图、箱形图等；直方图指统计分布用的图表，普通的柱形图是支持的），按列循环以及由数据决定的系列个数（系列由模板确定），多级类别标签，Excel 表格（“套用表格格式”）和名称区域（它们不会扩展），链接到外部文件的图表，PPTX、ODT、ODS、ODP 中的图表。ECharts 图表（`:chart`）在“ECharts 图表”一节中介绍。',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Word 中的图表',
        template: L(
          '| | 金额 |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: '1月', sum: 10 },
            { month: '2月', sum: 25 },
            { month: '3月', sum: 7 },
          ],
        }),
        result: L('| | 金额 |', '| 1月 | 10 |', '| 2月 | 25 |', '| 3月 | 7 |'),
        note: '该表格是 Word 图表的“编辑数据”工作表在报表生成后的样子。图表显示“金额”系列，共三根柱子：1月、2月、3月。标签上方的单元格可以留空；系列名称在第一行。',
      },
      {
        id: 'chart-excel',
        title: 'Excel 中的图表：两个系列，文本转为数字',
        template: L(
          '| 月份 | 计划 | 实际 |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: '1月', plan: 100, fact: '98.5' },
            { month: '2月', plan: 120, fact: '1 250' },
            { month: '3月', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| 月份 | 计划 | 实际 |',
          '| 1月 | 100 | 98.5 |',
          '| 2月 | 120 | 1 250 |',
          '| 3月 | 150 | |',
        ),
        note: '该表格是图表所引用的 Excel 工作表单元格。“计划”和“实际”系列覆盖三行。数据中的文本 `98.5` 和 `1 250` 变成数字 98.5 和 1250，“实际”在 3 月没有数据点。逗号被视为小数分隔符：`1,250` 变成 1.25，`1,234.5` 保持为文本——请传入不带千位逗号的数字。',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'ECharts 图表',
    intro: [
      'ECharts 图表绘制在占位图片的位置上——适用于 DOCX、XLSX、PPTX、ODT、ODS、ODP。在文档中插入任意一张尺寸合适的图片，并把标签 `{d.charts.sales:chart}` 写入其替代文字，方法与图片相同：在 Word 和 Excel 中，通过图片的替代文字（中文版 Word 中称为“替换文字”；右键单击图片，选择查看或编辑替代文字的命令）；在 LibreOffice 中，在图片的“属性”对话框中填写替代文字字段（在 Calc 和 Impress 中为标题字段）。定义中没有 `width`/`height` 时，图表采用图片的尺寸；有这两个值时，图片保持占位图片的宽度，高度按图表的比例计算。`:imageFit(contain)` 和 `:imageFit(fill)` 的用法与图片相同。',
      '最简单的方法是使用构建器：模板编辑器的“图表”选项卡。选择一个“行列表”查询、标签列和系列列（或“来自数据的系列”——把行拆分为系列的列）、类型、标题、图例、调色板和数字格式；预览基于测试数据构建。图表定义以键 `d.charts.<键>` 放入报表数据；标签可以用“复制”按钮复制，并显示在“文档”选项卡中。',
      '可以从 SQL 传入现成的 ECharts 5 定义：标签值为 `{ "type": "echarts@v5", "option": { … } }`，或带 `series` 的定义本身；JSON 字符串也可以。`width` 和 `height`（100–4000）设置逻辑画布尺寸：ECharts 的字号以这些像素计量，因此尺寸越大，文字越小；没有这两个值时，使用图片的尺寸。`theme` 为 `"dark"` 或主题对象。背景默认为白色。',
      '限制：定义不超过 1 MB，最多 20 个系列和 10,000 个数据点，绘制时间不超过 5 秒；定义中的函数不起作用（只能用 JSON）；字体始终为 Noto Sans，定义中的其他字体会被替换为它。定义中的图片（`graphic`、`symbol: "image://…"`、图案、`image` 键）只能是 `data:image/png|jpeg|gif;base64,…`；地址、文件路径或 SVG 是模板错误。在构建器图表中，日期标签按数据中的日期以 DD.MM.YYYY 格式显示，不做时区转换——要按天分组，请在 SQL 中把时间转换为日期（`created::date`）。空值会删除占位图片。无效的定义是带该标签的模板错误；在普通文本中使用 `:chart` 标签是模板错误，错误消息说明图表应放在图片的替代文字中。',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: '来自构建器的图表',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['1月', '2月', '3月'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: '金额', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result: '占位图片被替换为 1月、2月、3月的“金额”柱形图；尺寸与占位图片相同。',
        note: '构建器（“图表”选项卡）准备的数据就是这样的：每次生成报表和预览时，都会根据查询的行构建 `d.charts.<键>`。',
      },
      {
        id: 'echarts-sql',
        title: '来自 SQL 的现成定义',
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
                    { name: '北区', value: 120 },
                    { name: '南区', value: 80 },
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
        result: '占位图片被替换为饼图：北区——120，南区——80。',
        note: '没有 `type` 和 `option` 但带有 `series` 的定义被视为 ECharts 定义。在“单行”查询中，`chart` 列变为 `d.report.chart`。',
      },
      {
        id: 'echarts-size',
        title: '画布尺寸和深色主题',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['周一', '周二', '周三'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          '占位图片被替换为深色背景上的折线图；宽度与占位图片相同，高度按 800×400 的比例计算。',
        note: '没有 `width`/`height` 时，画布与占位图片一致。`echarts@v5a` 类型也用 ECharts 5 绘制。',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.field:html}` 插入数据中带格式的 HTML：段落、标题、列表、表格、链接、图片。适用于 DOCX 和 ODT——正文、表格单元格、页眉和页脚——以及由它们生成的 PDF。在 HTML 模板中，值按原样插入。在 XLSX、PPTX、ODS、ODP 中是模板错误，错误消息说明该格式不支持 html。',
      '该标签写在段落文本中：放在替代文字、链接地址或报表名称中是模板错误，错误消息说明 html 应放在段落文本中。`:html` 是标签中的最后一个格式化器：其后不能再有其他格式化器。不带选项时，HTML 以独立段落的形式插入到标签的位置；标签前后的段落文本保留在各自的段落中。每个段落、标题、列表和表格之后都会添加一个空段落。字体、字号、颜色和对齐方式取自标签：在模板中设置标签的格式，HTML 就会获得相同的格式。如果 HTML 设置了同一属性，以标签为准。',
      '文本标签：`b`/`strong`、`i`/`em`、`u`、`s`/`del`、`sup`、`sub`、`mark`（黄色突出显示）、`code`/`kbd`/`samp`（Courier New）。块：`p`、`br`、`pre`、`hr`、`blockquote`，标题 `h1`–`h6`（样式“标题 1”–“标题 6”），支持嵌套的列表 `ul`/`ol`/`li`，带 `colspan` 和 `rowspan` 的表格 `table`/`tr`/`th`/`td`，链接 `a href`，图片 `img`，复选框 `<input type="checkbox" checked>`。CSS 中只支持 `style` 属性的 `color`、`background-color`、`break-before: page` 和 `break-after: page` 属性。其他标签、类和样式会被丢弃，文本保留；`script` 和 `style` 连同其内容一起删除。',
      '选项用逗号分隔：`inline`——在当前段落内；`nospace`——不加空段落；`headingtheme:<前缀>`——标题样式 `<前缀>1`…`<前缀>6`；`tabletheme:<样式>`——表格样式（仅 DOCX）；`quotetheme:<样式>`——引用样式。例如 `{d.h:html(nospace, tabletheme:TableGrid)}`。未知选项是模板错误。',
      '`img` 图片：`src` 为 data URI（PNG、JPEG、GIF）或 `IMAGE_URL_ALLOWLIST` 中主机上的地址，与“图片、条形码、颜色、链接”一节相同。尺寸由 `width` 和 `height`（像素）指定；没有时宽度为 5 厘米，并保持比例。无效图片或加载失败时跳过该图片，并在 API 日志中记录警告，报表照常生成；大于 10 MB 的图片是模板错误。',
      '空值不插入任何内容。值大于 1 MB、标签嵌套深度超过 32 层或未闭合的标签超过 4096 个是模板错误。表格最多 63 列：多余单元格的内容放入最后一个单元格。在模板超链接中使用 `inline` 时，HTML 中的链接变为普通文本。在 ODT 中，复选框是字符 ☒ 和 ☐（在 DOCX 中是 Word 复选框），`tabletheme` 不起作用，列表项中的标题显示为大号加粗的列表项文本。',
    ],
    examples: [
      {
        id: 'html-text',
        title: '段落和文本格式',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>发票<b>已付款</b>。</p><p>期限：<i>5 天</i>，<span style="color:#C00000">无需预付款</span>。</p>',
        }),
        result: L(
          '两个段落，每个之后各有一个空段落：',
          '发票已付款。',
          '期限：5 天，无需预付款。',
          '“已付款”为粗体，“5 天”为斜体，“无需预付款”为红色。',
        ),
        note: '标签单独占一个段落：所有 HTML 都获得它的格式（字体、字号、对齐方式）。`nospace` 选项去掉空段落。',
      },
      {
        id: 'html-list',
        title: '列表',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>送货</li><li>安装<ul><li>1 楼</li><li>2 楼</li></ul></li></ul><ol><li>签署验收单</li><li>付款</li></ol>',
        }),
        result: L('• 送货', '• 安装', '    ◦ 1 楼', '    ◦ 2 楼', '1. 签署验收单', '2. 付款'),
        note: '各级项目符号：•、◦、▪；编号：1.、a.、i.。每个列表都重新编号，包括每个循环行中的列表。列表项 `<li><input type="checkbox" checked> 完成</li>` 显示为不带项目符号的复选框。',
      },
      {
        id: 'html-table',
        title: '表格',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>商品</th><th>数量</th></tr><tr><td>电缆</td><td>10</td></tr><tr><td colspan="2">合计：10</td></tr></table>',
        }),
        result: L('| 商品 | 数量 |', '| 电缆 | 10 |', '| 合计：10 |'),
        note: '表格占满整个文本宽度，各列等宽，`th` 为粗体，“合计”跨两列。在 DOCX 中——使用 `tabletheme` 样式，否则使用文档的默认表格样式（不带边框的“普通表格”除外），否则使用“网格型”（Table Grid，实线边框）；在 ODT 中——细边框。`caption` 变为表格上方的段落。',
      },
      {
        id: 'html-link',
        title: '链接和备用地址',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>合同见<a href="site.com/doc">网站</a>，说明见<a href="javascript:alert(1)">此处</a>。</p>',
        }),
        result: L(
          '合同见网站，说明见此处。',
          '“网站”链接到 https://site.com/doc，“此处”链接到 https://example.com。',
        ),
        note: '地址的检查方式与模板链接相同：没有协议时加上 `https://`；允许 `http`、`https`、`mailto`、`tel`。无效地址（`javascript:`、`localhost`、锚点 `#section`）会被替换为 `:defaultURL` 的值，没有时替换为 `#`。',
      },
      {
        id: 'html-inline',
        title: '在段落内（inline）',
        rich: true,
        template: '状态：{d.status:html(inline)}，见上文。',
        data: j({ status: '<b>已付款</b> <i>部分</i>' }),
        result: L('状态：已付款 部分，见上文。', '一个段落；“已付款”为粗体，“部分”为斜体。'),
        note: '在 `inline` 模式下，只有 `a`、`b`、`strong`、`em`、`i`、`s`、`del`、`u` 起作用。其他标签被丢弃，文本保留；`br` 和段落边界变为空格。',
      },
      {
        id: 'html-nospace',
        title: '不带空段落的标题（nospace）',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>条款</h2><p>5 天内付款。</p>' }),
        result: L('条款——“标题 2”样式', '5 天内付款。', '两者之间和之后都没有空段落。'),
        note: '模板中没有的标题样式会被创建为简单样式：粗体，`h1`–`h6` 分别为 20/16/14/13/12/11 pt。用 `headingtheme:<前缀>` 选项使用自己的样式：`{d.terms:html(headingtheme:Report)}` 采用样式 `Report1`…`Report6`。',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF：PDF/A、水印、页码、附加文件、密码',
    intro: [
      'PDF 设置在模板编辑器的“PDF”选项卡中设定，适用于报表的 PDF：预览、生成和下载时均生效。“另存为”DOCX/XLSX… 得到的文件不带这些设置。',
      'PDF/A-2b 是用于归档和电子文档流转的格式。启用 PDF/A 时，附加文件也必须是 PDF/A（根据文件的元数据判断）。',
      '水印和元数据（标题、作者、主题、关键词）可以包含 `{d.field}` 和 `{d.list[0].field}` 标签——不能使用格式化器和循环。水印中标签的值为空时，水印会被去掉：这样“草稿”只出现在尚未批准的文档上。PDF 字体中没有的字符（例如表情符号）会被替换为“?”。',
      '页码贯穿整个文档，包括附加文件：`{page}` 是页码，`{pages}` 是总页数；第一页可以不编页码。附加的 PDF（最多 10 个文件，每个不超过 20 MB，总计不超过 500 页）添加到报表的开头或末尾；不接受受密码保护的文件。',
      '保护：打开密码（每个模板一个，4–64 个字符，不能以“-”开头）以及对打印、复制文本和修改的限制。没有密码的限制不会锁定文档——由 PDF 阅读器执行。保护适用于已生成的报表；预览不带保护。PDF/A 与保护不能同时使用。密码加密存储，不在对话框中显示，模板迁移到其他环境时也不会随之转移——请在那里重新设置。',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'PDF 标题中的文档编号',
        template: '发票号 {d.number}',
        data: j({ number: '42', status: '草稿' }),
        result: '发票号 42',
        note: '同一个标签写在“PDF”选项卡的“标题”字段中，得到文档标题“发票号 42”；水印字段中的 `{d.status}` 得到水印“草稿”。PDF 字段不支持格式化器（`{d.sum:formatC}`）。',
      },
    ],
  },
  {
    id: 'signature',
    title: '电子签名',
    intro: [
      'PDF 签名为 PAdES，使用用户 `.p12`（`.pfx`）文件中的证书。根据俄罗斯联邦第 63-FZ 号法律，这属于非合格的增强型电子签名：它在组织内部以及与交易对方之间的法律效力来自双方之间的协议。',
      '签名方式：在“PDF”选项卡中，“签名方式”字段可选择“.p12 证书（签名嵌入 PDF）”或“GOST，CryptoPro（.sig 文件）”。使用 GOST 时，密钥保留在用户的计算机上：用户需要 CryptoPro CSP 5.0、带浏览器扩展的 CryptoPro CAdES Browser plug-in，以及“个人”存储中的 GOST R 34.10-2012 证书；结果是带签章的 PDF 和分离的 `.sig` 签名。管理员需要放置 `cadesplugin_api.js` 脚本（我们不提供该脚本），详见 `docs/operations/gost-signature.md`；没有该脚本时，签名对话框会提示未找到插件。服务器验证签名，但不验证证书链和吊销状态——请在俄罗斯政府服务门户 Gosuslugi 上检查（gosuslugi.ru/pgu/eds）。',
      '如何启用：模板编辑器的“PDF”选项卡 →“电子签名”→“允许签署 PDF”，然后选择签章位置（左下、底部居中、右下）。签名与“保护”区块中的密码和限制不能同时使用；与 PDF/A 可以同时使用。该设置适用于新的报表；之前的运行不变。',
      '如何签名：用户在“我的签名”页面上传自己的证书，生成报表后点击“签名 PDF”（或在历史记录中点击“签名…”）。每次签名都要输入密钥密码，密码从不保存；15 分钟内输错五次密码后，在该时段的剩余时间内禁止签名。只有生成该运行的用户才能为其签名；一次运行不能签名两次。已签名的文件：“下载已签名的 PDF”，或历史记录中的“已签名的 PDF”。',
      '签章是最后一页底部（左、中或右）一个 250 × 80 pt 的框，覆盖在内容之上：序列号、所有者、证书有效期、签名时间。签章下方的页面区域不会被清空——请在最后一页底部留出 110 pt 空白。',
      '时间戳：如果管理员配置了时间戳服务（`SIGN_TSA_URL`），它会确认签名时间；服务不可用时，报表不会被签名——错误“时间戳服务不可用”。',
      '验证：Adobe Acrobat Reader 在“签名”面板中显示签名。如果收件人信任证书颁发机构的证书，签名显示为“有效”；对于自签名证书和内部证书，请把根证书添加到受信任的证书中。',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: '免费版不可用',
    intro: [
      '这些标签在 Carbone 免费版中被禁用。如果模板中有这样的标签，报表和预览都不会生成，并显示示例中的错误。',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: '地区名称（formatR）',
        template: '{d.v:formatR()}',
        data: j({ v: 'CN' }),
        result: community('formatR'),
        unavailable: true,
        note: '请在 SQL 中从对照表获取名称。',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead: '已禁用；含有它的模板不会生成。数据中的图片按原样插入——请在传给报表之前将其旋转。',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          '旧的 `bindColor` 不会报错，但也不会改变颜色。请使用 `:color`（“图片、条形码、颜色、链接”一节）。',
      },
      {
        id: 'na-svg',
        title: 'SVG 和条形码字体',
        instead:
          '数据中的 SVG 图片是模板错误，错误消息说明不支持 SVG：请传入 PNG、JPEG 或 GIF。不支持条形码字体——请在占位图片中使用 `:barcode`。',
      },
      {
        id: 'na-sort-desc',
        title: '降序排序',
        instead:
          '`[-qty, i]` 会悄无声息地保持原有顺序：Carbone 目前还做不到。请在 SQL 中排序：`order by qty desc`。',
      },
      {
        id: 'na-txt',
        title: 'TXT 输出',
        instead: '西里尔文字会变成“??????”。我们的系统没有 TXT 格式——请使用 PDF 或 DOCX。',
      },
    ],
  },
];
