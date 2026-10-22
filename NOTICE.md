# Уведомления

## Лицензия проекта

Carbone Reports распространяется по лицензии PolyForm Strict License 1.0.0 (текст в [`LICENSE.md`](LICENSE.md)).
Коротко: разрешено использовать без изменений для любых некоммерческих целей; изменять, распространять
и использовать в коммерческих целях без отдельного договора с правообладателем нельзя.

## Каталог `packages/carbone`

`packages/carbone` — производная работа Carbone Community Edition 3.8.2, распространяемая по Carbone Community License (CCL):
[`packages/carbone/LICENSE.md`](packages/carbone/LICENSE.md). На этот каталог лицензия проекта (PolyForm Strict) не распространяется,
он подчиняется только CCL. Происхождение и отличия от апстрима — в [`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md).

## Сторонние зависимости

Сторонние библиотеки, входящие в образы и сборку, используются на условиях своих лицензий. Лицензия проекта
на них не распространяется.

Графики ECharts (с 2.6.0) используют Apache ECharts (Apache-2.0), resvg-js (MPL-2.0) и шрифт Noto Sans
(SIL Open Font License 1.1, текст — [`packages/carbone/assets/fonts/OFL.txt`](packages/carbone/assets/fonts/OFL.txt));
подробности — в [`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md). Вкладка «Графики» в браузере использует
Apache ECharts (Apache-2.0).

Китайский текст в штампе подписи, нумерации и водяном знаке PDF (с 2.14.0) рисуется шрифтом Noto Sans SC
(SIL Open Font License 1.1, текст —
[`packages/carbone/assets/fonts/NotoSansSC-OFL.txt`](packages/carbone/assets/fonts/NotoSansSC-OFL.txt)).

Обработка PDF (с 2.7.0) использует `pdf-lib` 1.17.1 — MIT, https://github.com/Hopding/pdf-lib;
`@pdf-lib/fontkit` 1.1.1 — MIT, https://github.com/Hopding/fontkit.

Шифрование PDF (с 2.7.1) выполняет программа `qpdf` — Apache-2.0, https://github.com/qpdf/qpdf; ставится
в образ API пакетом Debian и вызывается отдельным процессом.

Электронная подпись PDF (с 2.9.0) использует `pkijs` 3.4.1 и `asn1js` 3.1.0 — BSD-3-Clause, Peculiar Ventures
(https://github.com/PeculiarVentures/PKI.js, https://github.com/PeculiarVentures/asn1.js); `node-forge` 1.4.0
(чтение контейнеров `.p12`) — BSD-3-Clause или GPL-2.0 по выбору, Digital Bazaar, https://github.com/digitalbazaar/forge;
используется на условиях BSD-3-Clause.

## ONLYOFFICE Document Server

Document Server (контейнер `onlyoffice`) — отдельный продукт, который не входит в этот репозиторий и образы проекта
и работает по собственной лицензии. Условия его использования определяет его правообладатель.
