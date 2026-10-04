# Frontend reference (verified against npm tarballs, 2026-10-04)

All snippets below were type-checked (tsc 5.9.3 and 7.0.2, `moduleResolution: bundler`, strict) and the Vite build + a vitest/jsdom run
were executed in a scratch project: `(временный проект проверки, не в репозитории)`
(see `src/ui.tsx`, `src/more.tsx`, `src/*.test.tsx`, `src/test-setup.ts`, `vite.config.ts` there for compiling copies of everything below).
Items marked **UNVERIFIED** could not be confirmed without a running server / browser.

## 0. Versions used (all "latest" on 2026-10-04 unless noted)

| pkg | version | notes |
|---|---|---|
| react, react-dom | 19.3.0 | |
| @types/react, @types/react-dom | 19.3.0 | |
| @gravity-ui/uikit | 7.50.1 | peers: react/react-dom/@types/react `^16.14 \|\| 17 \|\| 18 \|\| 19` |
| @gravity-ui/navigation | 7.0.1 | peers: react, react-dom, `@gravity-ui/icons ^2.2`, `@gravity-ui/uikit ^7.42`, `@bem-react/classname ^1.6` (installed 1.8.0) |
| @gravity-ui/date-components | 4.1.0 | peers: react>=17, @types/react, `@gravity-ui/uikit ^7.21`, `@gravity-ui/date-utils ^2.6` |
| @gravity-ui/date-utils | 2.7.2 | |
| @gravity-ui/icons | 2.22.0 | |
| @onlyoffice/document-editor-react | 2.2.0 | peers: react 16.9..19, react-dom, **`@onlyoffice/doceditor-types >=9.3.1`** (installed 9.4.3; the .d.ts imports `Config` from it) |
| @monaco-editor/react | 4.7.0 (dist-tag `next` = 4.8.0-rc.3) | peers: react 16.8..19, `monaco-editor >=0.25 <1`; dep `@monaco-editor/loader` 1.7.0 |
| monaco-editor | 0.57.0 | see section 7: worker import paths changed in 0.56 |
| react-router | **8.4.0 is `latest`**; latest 7.x = 7.18.4 | v8 peers react/react-dom `>=19.2.7`, node `>=22.22.0`. v7.18.4 peers react>=18, node>=20. APIs used below are identical in both. |
| @tanstack/react-query | 5.104.1 | peer react ^18 \|\| ^19 |
| vite | 8.3.2 | |
| @vitejs/plugin-react | 6.1.1 | peer `vite ^8` only (uses oxc; no babel needed) |
| vitest | 5.0.3 | peer vite `^6.4 \|\| ^7 \|\| ^8`; node `^22.12 \|\| ^24 \|\| >=26`; peer `@types/node ^22 \|\| >=24` |
| jsdom | 30.1.2 (also tested 29.1.1) | 30.x engines node `^22.22.2 \|\| ^24.15 \|\| >=26`; 29.1.1 engines `^20.19 \|\| ^22.13 \|\| >=24` |
| @testing-library/react | 16.3.3 | peers: **@testing-library/dom ^10 (must install explicitly)**, @types/react, @types/react-dom |
| @testing-library/dom | 10.4.2 | |
| @testing-library/user-event | 14.6.7 | peer @testing-library/dom >=7.21.4 |
| @testing-library/jest-dom | 7.0.1 | peers vitest>=0.32, @testing-library/dom >=10 <11; node >=22 |
| typescript | 5.9.3 tested; 7.0.2 (`latest`) also type-checks the snippets | |
| @types/node | 22.20.5 used (matches vitest peer) | |

Machine gotcha: `nvm use 22` here gives **Node 22.17.0**. That triggers EBADENGINE warnings for jsdom 30 / react-router 8 (need >=22.22). Installs and vitest runs still worked on 22.17.0. To be strictly clean either use Node >=22.22 or pin `jsdom@^29.1.1` and `react-router@^7.18.4`.

**Install gotcha (npm 10.9):** `npm i @gravity-ui/navigation ...` first and `npm i -D @vitejs/plugin-react@6` afterwards fails with ERESOLVE (navigation depends on jscodeshift -> @babel/core 7; plugin-react 6's optional peer `@rolldown/plugin-babel` wants babel 8 rc). Installing everything in ONE `npm i` command works (verified), or use `--legacy-peer-deps`. Navigation also drags in jscodeshift/lodash as runtime deps (heavy install, not bundled unless imported).

## 1. React 19 compatibility (peerDependencies, confirmed)

uikit, navigation, date-components, onlyoffice, @monaco-editor/react, @tanstack/react-query, @testing-library/react, react-router (>=18 in v7, >=19.2.7 in v8) all accept React 19.

## 2. @gravity-ui/uikit 7.50.1

Docs shipped in the package: `node_modules/@gravity-ui/uikit/build/docs/components/*.md` (source of truth, one per component).

### Entry / CSS / theme
```tsx
// main.tsx  (both CSS imports + ThemeProvider are required, otherwise unstyled)
import '@gravity-ui/uikit/styles/fonts.css';   // @imports Inter from fonts.googleapis.com (remote!)
import '@gravity-ui/uikit/styles/styles.css';
import {ThemeProvider, ToasterProvider, ToasterComponent, Toaster} from '@gravity-ui/uikit';
import type {Theme} from '@gravity-ui/uikit';
```
- `ThemeProviderProps`: `theme?: Theme` (`'system' | 'light' | 'dark' | 'light-hc' | 'dark-hc'` + any string), `systemLightTheme?`, `systemDarkTheme?`, `direction?`, `scoped?`, `rootClassName?`, `lang?`, `layout?`, `defaultProps?`. Default non-scoped provider puts `g-root g-root_theme_dark` classes on `<body>`.
- Hooks: `useTheme()` -> the configured `Theme` (may be `'system'`), `useThemeValue()` -> resolved real theme (`'light'|'dark'|...`), `useThemeType()` -> `'light'|'dark'`.
- Theme toggle pattern (no built-in persistence; do it yourself):
```tsx
const [theme, setTheme] = React.useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'system');
React.useEffect(() => { localStorage.setItem('theme', theme); }, [theme]);
<ThemeProvider theme={theme}>...</ThemeProvider>
```
  (wrap localStorage in try/catch if you care about private mode). `theme="system"` is safe without matchMedia (guarded).

### Toaster (v7: instance + provider + component; `useToaster` THROWS outside `ToasterProvider`)
```tsx
const toaster = new Toaster();               // or: import {toaster} from '@gravity-ui/uikit/toaster-singleton'
createRoot(el).render(
  <ThemeProvider theme="system">
    <ToasterProvider toaster={toaster}>
      <App />
      <ToasterComponent />                   {/* props: className?, mobile?, hasPortal? (default true) */}
    </ToasterProvider>
  </ThemeProvider>);

const {add, remove, removeAll, update, has} = useToaster();   // from '@gravity-ui/uikit'
add({name: 'save-ok', title: 'Saved', content: 'Details', theme: 'success', autoHiding: 5000, isClosable: true});
// ToastProps: name: string (required, unique key; same name collapses), title?, content?: ReactNode,
//   theme?: 'normal'|'info'|'success'|'warning'|'danger'|'utility', autoHiding?: number|false (default 5000),
//   isClosable?, actions?: {label, onClick, view?, removeAfterClick?}[] | (() => ReactElement), onClose?, className?, renderIcon?
```
`useToaster()` returns `{add, remove, removeAll, update(name, partial), has(name)}`. The singleton `toaster` has the same methods (usable in non-React code such as a query-client `onError`), but you must pass the same instance to `ToasterProvider`.

### Component props (all compile; `import {...} from '@gravity-ui/uikit'`)
- **Button**: `view` = `'normal'|'action'|'outlined'|'outlined-info'|'outlined-success'|'outlined-warning'|'outlined-danger'|'outlined-utility'|'outlined-action'|'raised'|'flat'|'flat-secondary'|'flat-info'|'flat-success'|'flat-warning'|'flat-danger'|'flat-utility'|'flat-action'|'normal-contrast'|'outlined-contrast'|'flat-contrast'`; `size` `'xs'|'s'|'m'|'l'|'xl'`; `loading`, `disabled`, `selected`, `width: 'auto'|'max'`, `pin`, `href` (renders `<a>`), plus native button attrs (`type`, `onClick`). Icon inside: `<Button><Icon data={Plus} size={16}/>Add</Button>` (or `<Button.Icon>`).
- **TextInput**: `value?: string`, `onUpdate?(value: string)`, `onChange?`, `type?: 'email'|'number'|'password'|'search'|'tel'|'text'|'url'`, `placeholder`, `label` (inline label string), `validationState?: 'invalid'` (only value), `errorMessage?: ReactNode`, `errorPlacement?: 'outside'|'inside'`, `hasClear`, `size 's'|'m'|'l'|'xl'`, `view 'normal'|'clear'`, `disabled`, `readOnly`, `autoFocus`, `name`, `id`, `note`, `startContent/endContent`, `controlProps`. (`error` prop is deprecated.) Also `PasswordInput`.
- **TextArea**: same base props as TextInput + `rows`, `minRows`, `maxRows`, `note`.
- **NumberInput**: `value?: number | null`, `onUpdate?(value: number | null)`, `min`, `max`, `step`, `allowDecimal`, `hiddenControls`, `size`, `label`, `validationState`, `errorMessage`, `placeholder`.
- **Select**: `value?: string[]`, `onUpdate?(value: string[])`, `options?: {value: string; content?: ReactNode; text?: string; disabled?; data?}[]` (or groups `{label, options}`), `multiple?`, `width?: 'auto'|'max'|number`, `size`, `label`, `placeholder`, `filterable`, `hasClear`, `disabled`, `validationState`, `errorMessage`, `renderOption`, `popupWidth: 'fit'|number`. Children API: `<Select.Option value="a">A</Select.Option>`. Single select still uses an array: `value={[x]}` and `onUpdate={([v]) => ...}`.
- **Checkbox**: `checked?`, `onUpdate?(checked: boolean)`, `content?: ReactNode` (or children), `size 'm'|'l'|'xl'`, `disabled`, `indeterminate`. **Switch**: same (`checked`, `onUpdate(checked)`, `content`, `size 's'|'m'|'l'`, `loading`).
- **SegmentedRadioGroup<T extends string>**: `value?: T|null`, `onUpdate?(value: T)`, `options?: {value, content?, disabled?}[]` OR children `<SegmentedRadioGroup.Option value="x">X</SegmentedRadioGroup.Option>`, `size 's'|'m'|'l'|'xl'`, `width 'auto'|'max'`, `name`, `disabled`.
- **Tabs (v7 composition API)**:
```tsx
<TabProvider value={tab} onUpdate={setTab}>          {/* value: string, onUpdate(value: string) */}
  <TabList size="m">                                  {/* size 'm'|'l'|'xl'; contentOverflow 'wrap'|'scroll'|'collapse' */}
    <Tab value="a" icon={<Icon data={Gear}/>} counter={3}>A</Tab>   {/* Tab also: disabled, label, href */}
    <Tab value="b">B</Tab>
  </TabList>
  <TabPanel value="a">...</TabPanel>
</TabProvider>
```
- **Dialog**: props `open: boolean`, `onClose(event, reason)` (required), `size?: 's'|'m'|'l'` (deprecated; prefer `maxWidth` + `fullWidth`), `hasCloseButton`, `disableOutsideClick`, `keepMounted`, `aria-labelledby`, `container`.
```tsx
<Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="dlg-title">
  <Dialog.Header caption="Title" id="dlg-title" />        {/* caption: ReactNode, insertBefore/After, as */}
  <Dialog.Body>...</Dialog.Body>                           {/* hasBorders */}
  <Dialog.Footer
    onClickButtonApply={save} onClickButtonCancel={() => setOpen(false)}
    textButtonApply="Save" textButtonCancel="Cancel"       {/* buttons render ONLY if these texts are set */}
    loading={saving}                                       {/* spinner on apply, disables cancel */}
    propsButtonApply={{disabled: !valid}} errorText="..." />  {/* apply button is type="submit" */}
</Dialog>
```
- **Label**: `theme?: 'normal'|'info'|'danger'|'warning'|'success'|'utility'|'unknown'|'clear'`, `size?: 'xxs'|'xs'|'s'|'m'`, `type?: 'default'|'copy'|'close'|'info'`, `icon`, `value`, `onClick`, `onCloseClick`, `copyText`, `interactive`, `title`.
- **Alert**: `theme?: 'clear'|'normal'|'info'|'success'|'warning'|'danger'|'utility'`, `view?: 'filled'|'outlined'`, `title?`, `message?`, `size 's'|'m'|'l'`, `layout`, `corners`, `icon`, `onClose`, `actions` (`[{text, handler}]` or `<Alert.Actions>`).
- **Card**: `type?: 'selection'|'action'|'container'`, `view?: 'outlined'|'clear'|'filled'|'raised'`, `theme?`, `size 'm'|'l'`, `onClick(e)`, `selected`, `disabled`; also Box props (`spacing`, `className`).
- **Text**: `variant` in `display-1..4, header-1, header-2, subheader-1..3, body-1..3, body-short, caption-1, caption-2, code-1..3, code-inline-1..3` (or `'inherit'`); `color` (e.g. `'primary'|'secondary'|'danger'|'positive'|...`), `as`, `ellipsis`, `ellipsisLines`, `whiteSpace`, `wordBreak`.
- **Loader**: `size 's'|'m'|'l'`, `className`. (`Spin` also exists.)
- **Icon**: `<Icon data={Gear} size={16} />` (`data` required: an icon component from @gravity-ui/icons; also `width`, `height`, `fill`, `stroke`, `color`, `className`). No `name` prop.
- **Flex** (layout): `gap: Space`, `direction`, `alignItems`, `justifyContent`, `wrap`, `grow`, `basis`, `inline`, `centerContent`, `gapRow`, plus Box spacing props (`p`, `m`, `px`...). `Space` = `0|0.5|1..10` (number or string); responsive objects allowed. Also `Row`, `Col`, `Container`, `Box`.
- **DropdownMenu**: `items?: (DropdownMenuItem | DropdownMenuItem[])[]` (nested array = visually separated group); item = `{text?: ReactNode, action?: (event, data?) => void, href?, items? (submenu), theme?: 'normal'|'danger', iconStart?, iconEnd?, disabled?, hidden?, selected?}` (must have `action`, `href` or `items`); `icon?` (switcher icon), `size`, `disabled`, `renderSwitcher?(props)`, `defaultSwitcherProps` (ButtonProps), `onOpenToggle`, `open`, `data`, `popupProps`.
- **Link**: `href: string` (required), `view?: 'normal'|'primary'|'secondary'`, `underline`, `visitable`, native anchor attrs (for SPA routing use react-router `Link`, or `onClick` + `preventDefault`).
- **Pagination**: `page: number` (1-based), `pageSize: number`, `total?: number`, `onUpdate(page: number, pageSize: number)`, `size`, `pageSizeOptions?: number[]`, `showInput`, `compact`.
- **ClipboardButton**: `text: string | (() => string)` + Button props (`size`, `view`), `hasTooltip`, `tooltipInitialText`, `tooltipSuccessText`, `onCopy(text, ok)`. **CopyToClipboard**: `text`, `timeout`, `onCopy`, `children: ReactElement | ((status: 'pending'|'success'|'error') => ReactElement)` (child needs onClick).

### Table + HOCs
```tsx
import {Table, withTableActions, withTableSorting} from '@gravity-ui/uikit';
import type {TableColumnConfig, TableSortState} from '@gravity-ui/uikit';

type Row = {id: string; name: string; size: number};
// compiles & infers generics (verified):
const MyTable = withTableSorting(withTableActions(Table<Row>));
// equivalent explicit form (also verified): withTableSorting(withTableActions<Row>(Table<Row>))

const columns: TableColumnConfig<Row>[] = [
  {id: 'name', name: 'Name', template: (r) => r.name, meta: {sort: true}},                 // sort: true -> compares cell values (field named by id) asc
  {id: 'size', name: 'Size', align: 'end', width: 100, meta: {sort: (a: Row, b: Row) => a.size - b.size}}, // comparator gets whole row items
];
// TableColumnConfig<I>: {id; name?: string|(() => ReactNode); template?: string|((item,index)=>ReactNode); placeholder?; align?: 'start'|'end'|'center'|'left'|'right'; width?: number|string; className?; sticky?; primary?; meta?: Record<string, any>}
<MyTable
  data={rows} columns={columns} emptyMessage="No data"
  getRowDescriptor={(r) => ({id: r.id})}              // preferred; `getRowId={(r) => r.id}` or getRowId="id" still compile but are @deprecated
  onRowClick={(item, index, e) => ...}
  getRowActions={(item, index) => [{text: 'Delete', theme: 'danger', handler: (item, index, event) => remove(item.id)}]}
  // TableAction: {text; handler(item, index, event); theme?: 'normal'|'danger'; disabled?; href?; icon?; qa?}  (or groups {title, items})
  // optional: rowActionsSize, renderRowActions, rowActionsIcon
  defaultSortState={[{column: 'name', order: 'asc'}]}  // uncontrolled
  // controlled: sortState={sort} onSortStateChange={setSort}  (TableSortState = {column: string; order: 'asc'|'desc'}[]);
  // when BOTH sortState and onSortStateChange are passed, disableDataSorting defaults to true -> YOU must sort `data` (server-side sort).
/>
```
Meta defaults: `defaultSortOrder: 'asc'|'desc'`. Table props also: `verticalAlign`, `wordWrap`, `edgePadding`, `width 'auto'|'max'`, `className`. Other HOCs: `withTableSelection`, `withTableCopy`, `withTableSettings`.

## 3. @gravity-ui/navigation 7.0.1

```tsx
import {AsideHeader, FooterItem} from '@gravity-ui/navigation';
import type {AsideHeaderItem} from '@gravity-ui/navigation';
import {FileText, Gear} from '@gravity-ui/icons';
// No separate CSS import (component CSS is imported inside the JS; package marks *.css as sideEffects).
// Requires uikit styles.css + ThemeProvider above it.

const items: AsideHeaderItem[] = [
  {id: 'reports', title: 'Reports', icon: FileText, current: pathname.startsWith('/reports'), onItemClick: () => navigate('/reports')},
  {id: 'ext', title: 'Docs', icon: Gear, href: '/docs'},     // href renders <a> (full page nav unless you intercept)
];
<AsideHeader
  logo={{text: 'Carbone', icon: FileText, iconSize: 24, href: '/', onClick: (e) => {e.preventDefault(); navigate('/');}}}
  compact={compact} onChangeCompact={setCompact}           // controlled: you MUST own `compact`
  menuItems={items} headerDecoration
  menuOverflow="scroll"                                     // default 'collapse' (extra items go under "More")
  renderFooter={({compact}) => (
    <FooterItem id="logout" title="Logout" icon={ArrowRightFromSquare} compact={compact} onItemClick={logout} />
  )}
  renderContent={() => <Outlet />}                          // main page area, right of the aside
/>
```
- `AsideHeaderItem` (= `MenuItem` +): `id: string` (req), `title: ReactNode` (req), `icon?: IconProps['data']` (an icon COMPONENT, not an element), `current?`, `href?`, `onItemClick?(item, collapsed, event)`, `tooltipText`, `type?: 'regular'|'action'|'divider'`, `rightAdornment`, `enableTooltip`, `qa`, `hidden`, `pinned`, `groupId`, `itemWrapper`.
- `LogoProps`: `text: string | (() => ReactNode)` (req), `icon?`, `iconSrc?`, `iconSize?`, `textSize?`, `href?`, `target?`, `onClick?`, `wrapper?`, `className`.
- `FooterItemProps` = `AsideHeaderItem` + `regularSize?`, takes `compact` (pass from `renderFooter`'s argument). `renderFooter` arg: `{size, compact, asideRef}`. `renderContent` arg: `{size}`; CSS var `--gn-aside-header-size`.
- Other AsideHeader props: `subheaderItems`, `panelItems`, `topAlert`, `hideCollapseButton`, `collapseTitle/expandTitle`, `customBackground`, `menuDensity: 'default'|'compact'`, `enableQuickAccess`, `qa`. Advanced layout: `PageLayout`, `PageLayoutAside`, `AsideFallback`.
- A separate `Footer` component exists (page footer with `copyright`), unrelated to aside `FooterItem`.
- jsdom gotchas: needs ESM build resolved (see section 10) and, because jsdom has zero layout, the default `menuOverflow="collapse"` hides all items under "More" -> use `menuOverflow="scroll"` in tests (verified: items then render) or mock the component.

## 4. @gravity-ui/date-components 4.1.0 + @gravity-ui/date-utils 2.7.2

```tsx
import {DatePicker} from '@gravity-ui/date-components';
import {dateTimeParse, dateTime} from '@gravity-ui/date-utils';
import type {DateTime} from '@gravity-ui/date-utils';
// CSS: none beyond uikit styles.css (component CSS is imported by the JS).

const [d, setD] = React.useState<DateTime | null>(dateTimeParse('2024-05-01', {format: 'YYYY-MM-DD'}) ?? null);
<DatePicker value={d} onUpdate={setD} format="YYYY-MM-DD" label="Date" size="m" hasClear
            minValue={...} maxValue={...} validationState="invalid" errorMessage="..." />
const iso: string = d?.format('YYYY-MM-DD') ?? '';
```
- `DatePicker<T = DateTime>` props: `value?: DateTime | null`, `defaultValue`, `onUpdate?(value: DateTime | null)`, `format?: string` (dayjs tokens; default locale format, set `'YYYY-MM-DD'` explicitly), `minValue`, `maxValue`, `isDateUnavailable`, `timeZone`, `placeholder`, `label`, `size`, `view`, `pin`, `hasClear`, `disabled`, `readOnly`, `validationState`, `errorMessage`, `errorPlacement`, `id`, `name`, `onBlur`, `onFocus`, `popupPlacement`, `disablePortal`.
- date-utils: `dateTimeParse(input: unknown, options?: {format?, timeZone?, lang?, roundUp?, allowRelative?}): DateTime | undefined` (note: may return `undefined`). `dateTime({input?, format?, timeZone?, lang?}): DateTime` (always returns an object; check `.isValid()`). `DateTime` has `.format(fmt?)`, `.isValid()`, `.add/.subtract/.startOf/.endOf/.isBefore/...`, `.toDate()`.
- Localisation (only if non-English): `await settings.loadLocale('ru')` from date-utils + `<ThemeProvider lang="ru">`.

## 5. @gravity-ui/icons 2.22.0

`import {Gear, FileText} from '@gravity-ui/icons';` (also deep import `@gravity-ui/icons/Gear`). Each is `(props: SVGProps<SVGSVGElement>) => JSX.Element`; use as `<Icon data={Gear} />` or `<Gear />`.
Confirmed exports: `FileText`, `File`, `FileArrowDown`, `Database`, `Person`, `PersonPlus`, `PersonGear`, `Persons`, `ClockArrowRotateLeft` (history), `Clock`, `ArrowRotateLeft`, `ArrowsRotateRight`, `Gear`, `ArrowRightFromSquare` (logout), `ArrowRightFromLine`, `Sun`, `Moon`, `Plus`, `TrashBin`, `Copy`, `ArrowDownToLine` (download), `ArrowUpFromLine` (upload), `Play`, `CirclePlay`, `FloppyDisk`, `Pencil`, `PencilToSquare`, `Xmark`, `Check`, `CircleCheck`, `CircleXmark`, `CircleInfo`, `CircleExclamation`, `TriangleExclamation`, `Magnifier`, `Eye`, `Ellipsis`, `EllipsisVertical`, `Bars`, `ChevronDown`, `Code`, `Terminal`, `House`, `Folder`, `Link`, `Key`, `Lock`, `Calendar`, `Palette`, `Globe`, `Layers`, `Server`, `Tag`, `Funnel`, `Flask`, `Rocket`, `ArrowUpRightFromSquare`, `Cube`, `Cubes3`, `Book`, `Bell`, `Star`, `Sliders`.
NOT present (checked): `Table`, `Clone`, `Logout`, `History`, `Cubes`, `Template`. Verify any other name with `ls node_modules/@gravity-ui/icons/*.d.ts`.

## 6. @onlyoffice/document-editor-react 2.2.0

```tsx
import {DocumentEditor} from '@onlyoffice/document-editor-react';   // named export only
import type {DocumentEditorProps} from '@onlyoffice/document-editor-react';
// requires `@onlyoffice/doceditor-types` installed (types `Config`)

<DocumentEditor
  id="docEditor"                                  // required; also the DOM id of the placeholder <div>
  documentServerUrl="/onlyoffice/"                // required string
  config={{                                       // type Config from @onlyoffice/doceditor-types
    document: {fileType: 'docx', key: 'unique-per-version', title: 'x.docx', url: 'http://backend/files/x.docx'},
    documentType: 'word',                         // 'word'|'cell'|'slide'|'pdf'|'diagram'
    editorConfig: {callbackUrl: 'http://backend/onlyoffice/callback', mode: 'edit', lang: 'en'},
    token: jwt,                                   // optional, if Document Server JWT is enabled
  }}
  height="100%" width="100%"                      // strings
  events_onDocumentReady={(e) => {}}              // all events_* take (event: object) => void
  events_onAppReady / events_onError / events_onWarning / events_onInfo / events_onDocumentStateChange / events_onRequestSaveAs ...
  onLoadComponentError={(code: number, desc: string) => {}}   // -1 unknown, -2 api.js failed to load, -3 DocsAPI undefined
/>
```
Other props: `shardkey?`, `document_fileType?`, `document_title?`, `documentType?`, `editorConfig_lang?`, `type?` ('desktop'|'mobile'|'embedded').
Behaviour read from the shipped source (`dist/esm/index.js`):
- api.js URL = `documentServerUrl` (a `/` is appended if missing) + `web-apps/apps/api/documents/api.js` (`?shardkey=...` if `shardkey` set), injected as `<script id="onlyoffice-api-script" async>` into `document.body`; cached via `window.DocsAPI` across remounts.
- A **relative** value such as `'/onlyoffice/'` is accepted as a plain string (it becomes a root-relative script `src`), so the script load works through a same-origin proxy. **UNVERIFIED** against a real Document Server: whether api.js resolves its iframe/websocket base from the script URL correctly behind a path prefix; needs the reverse proxy to forward the prefix + websockets (Vite proxy `ws: true`), and Document Server must itself reach `document.url` and `callbackUrl` (they must be addresses reachable from the Document Server, not the browser).
- The editor is destroyed and recreated whenever `JSON.stringify(config)` (or id/documentServerUrl/width/height/type/document_* props) changes -> keep `config` stable (`useMemo`; never put a changing `key`/token in it unless you want a reload). Do not pass `config.events` together with `events_*` props (config is `Object.assign`ed over the props-derived object).
- Container needs real height (e.g. wrapper `height: calc(100vh - X)`); `height="100%"` otherwise collapses.

## 7. @monaco-editor/react 4.7.0 + monaco-editor 0.57.0

```tsx
import Editor, {loader, useMonaco, DiffEditor} from '@monaco-editor/react';
import type {OnMount, OnChange, Monaco} from '@monaco-editor/react';

<Editor
  height="400px" width="100%"                    // number | string, default "100%"
  language="json"                                // or defaultLanguage; `path` for multi-model
  value={text}                                   // controlled; or defaultValue
  onChange={(value, ev) => setText(value ?? '')} // value: string | undefined
  theme={isDark ? 'vs-dark' : 'vs'}              // type is `'vs-dark'|'light'|string`; 'vs' (builtin) is accepted; default 'light'
  options={{minimap: {enabled: false}, readOnly: false, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false}}
  onMount={(editor, monaco) => {}} beforeMount={(monaco) => {}} onValidate={(markers) => {}}
  loading={<Loader/>} />
```
**Default = loads monaco from CDN** (`cdn.jsdelivr.net/npm/monaco-editor@<ver>/min/vs` via `@monaco-editor/loader`). To use the bundled npm package with Vite (verified: `vite build` OK, emits editor/json/css/html/ts worker chunks; types compile):
```ts
// src/monaco-setup.ts  (import once, before rendering <Editor>, e.g. at top of main.tsx)
import * as monaco from 'monaco-editor';
import {loader} from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
// optional: css 'monaco-editor/language/css/css.worker?worker', html '.../html/html.worker?worker', ts '.../typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};
loader.config({monaco});
```
- **IMPORTANT (0.56+)**: monaco-editor's `exports` map changed (`"./*": "./esm/vs/*.js"`). The old path `monaco-editor/esm/vs/editor/editor.worker?worker` now FAILS to resolve (verified: "Rolldown failed to resolve import"). Use `monaco-editor/editor/editor.worker?worker` and `monaco-editor/language/json/json.worker?worker` (dir is `language`, singular). With monaco-editor `<=0.55.1` the old `esm/vs/...` paths work instead.
- `?worker` typing comes from `vite/client` types (`"types": ["vite/client"]` or `/// <reference types="vite/client" />`).
- Bundle: `import * as monaco from 'monaco-editor'` pulls every language/feature -> main chunk ~5 MB (1.3 MB gzip) plus lazy language chunks. A slimmer entry (`monaco-editor/editor` + `monaco-editor/features/register.all` + `monaco-editor/languages/features/json/register`) also builds and type-checks but only saved ~0.9 MB; runtime highlighting for it not checked. Consider lazy-loading the page that uses the editor (`React.lazy`).
- Types: `@monaco-editor/react`'s `Monaco` type imports `monaco-editor/esm/vs/editor/editor.api`, which no longer resolves under 0.56+ exports (degrades to `any`; harmless with `skipLibCheck: true`, which the Vite template sets). Pin `monaco-editor@0.55.1` if exact `Monaco` typing matters.

## 8. react-router (8.4.0 latest; 7.18.4 latest 7.x — same API for all below)

```tsx
import {createBrowserRouter, Navigate, Outlet, useNavigate, useParams, useSearchParams, Link, NavLink, useLocation} from 'react-router';
import {RouterProvider} from 'react-router/dom';        // recommended for DOM apps (docs: installation.md); `RouterProvider` is also exported from 'react-router' (without the flushSync DOM wrapper)
const router = createBrowserRouter([
  {path: '/', element: <Shell />, children: [
    {index: true, element: <Navigate to="/reports" replace />},
    {path: 'reports/:id', element: <ReportPage />},
  ]},
]);
createRoot(el).render(<RouterProvider router={router} />);   // create router once at module level, not in state
// hooks: const navigate = useNavigate(); navigate('/x', {replace: true});  const {id} = useParams<{id: string}>();
//        const [sp, setSp] = useSearchParams(); sp.get('q'); setSp({q: 'x'});
// <Link to="/x">; <NavLink to="/x" className={({isActive}) => ...}>; <Outlet/> renders the matched child route
```
Confirmed exports from `react-router`: createBrowserRouter, createMemoryRouter, createRoutesFromElements, BrowserRouter, Routes, Route, Navigate, Outlet, Link, NavLink, useNavigate, useParams, useSearchParams, useLocation, redirect, isRouteErrorResponse, useRouteError, RouterProvider. `react-router-dom` is not needed (removed in v8). Tests: `createMemoryRouter([...], {initialEntries: ['/']})` + `RouterProvider` (verified).

## 9. @tanstack/react-query 5.104.1

```tsx
import {QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
const queryClient = new QueryClient({defaultOptions: {queries: {retry: 1, staleTime: 30_000, refetchOnWindowFocus: false}}});
<QueryClientProvider client={queryClient}>...</QueryClientProvider>

const q = useQuery({queryKey: ['templates', id], queryFn: () => api.get(id), enabled: !!id});   // q.data, q.isPending, q.isError, q.error, q.refetch
const qc = useQueryClient();
const m = useMutation({mutationFn: (body: Body) => api.save(body), onSuccess: () => qc.invalidateQueries({queryKey: ['templates']}), onError: (e) => ...});
m.mutate(body); await m.mutateAsync(body); m.isPending
```
v5 notes: single object signature only; `isLoading` = `isFetching && isPending`; `cacheTime` renamed `gcTime`; `onSuccess/onError` callbacks no longer exist on `useQuery` (still on `useMutation`); in tests create a fresh `QueryClient({defaultOptions: {queries: {retry: false}}})` per test.

## 10. Tooling

`package.json` devDependencies (all verified together): `vite@8.3.2`, `@vitejs/plugin-react@6.1.1`, `vitest@5.0.3`, `jsdom@30.1.2` (or `^29.1.1` on Node <22.22), `@testing-library/react@16.3.3`, `@testing-library/dom@10.4.2`, `@testing-library/user-event@14.6.7`, `@testing-library/jest-dom@7.0.1`, `typescript` (5.9.x or 7.0.2), `@types/node@^22`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`.

`vite.config.ts` (verified to run the tests below; the type reference makes the `test` key type-check):
```ts
/// <reference types="vitest/config" />
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {mainFields: ['module', 'jsnext:main', 'jsnext']},   // REQUIRED for vitest: @gravity-ui/navigation has no `exports`, `main` points to the CJS build which require()s .css and crashes
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/onlyoffice': {target: 'http://localhost:8080', changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/onlyoffice/, '')},  // proxy block UNVERIFIED at runtime
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,                                   // then tsconfig "types": ["vitest/globals", "@testing-library/jest-dom"]
    setupFiles: ['./src/test-setup.ts'],
    server: {deps: {inline: [/@gravity-ui\//]}},     // REQUIRED: otherwise "Unknown file extension .css" for uikit's `import './X.css'`
  },
});
```
tsconfig used: `target ES2022, module ESNext, moduleResolution bundler, jsx react-jsx, strict, noEmit, skipLibCheck, isolatedModules, verbatimModuleSyntax, types: ["vite/client", "vitest/globals", "@testing-library/jest-dom"]`.

`src/test-setup.ts` (verified; each polyfill was confirmed NECESSARY by removing it):
```ts
import '@testing-library/jest-dom/vitest';          // path exists in v7
import {afterEach, vi} from 'vitest';
import {cleanup} from '@testing-library/react';
afterEach(() => cleanup());                         // needed if `globals: false`; harmless otherwise

// jsdom has neither. uikit: Dialog/Sheet/useAnimateHeight call window.matchMedia unguarded ("window.matchMedia is not a function");
// Table.componentDidMount does `new ResizeObserver` unguarded ("ResizeObserver is not defined"); Tabs/TextArea/Breadcrumbs also use it.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()}),
  });
}
if (!('ResizeObserver' in window)) {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (window as unknown as {ResizeObserver: typeof RO}).ResizeObserver = RO;
  (globalThis as unknown as {ResizeObserver: typeof RO}).ResizeObserver = RO;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};   // precaution, not proven necessary
```
Test pattern that passed (Button + toast, Table, Tabs, TextArea, Select, Pagination, DropdownMenu, Dialog, AsideHeader, DatePicker, RouterProvider):
```tsx
render(<ThemeProvider theme="light"><ToasterProvider toaster={new Toaster()}><Btn /><ToasterComponent /></ToasterProvider></ThemeProvider>);
await userEvent.click(screen.getByRole('button', {name: 'Go'}));
expect(await screen.findByText('Hello toast')).toBeInTheDocument();
```
Components using `useToaster` must be rendered inside `ToasterProvider` (throws "useToaster hook is used out of context" otherwise). Monaco and OnlyOffice cannot run in jsdom: mock `@monaco-editor/react` and `@onlyoffice/document-editor-react` with `vi.mock`.
