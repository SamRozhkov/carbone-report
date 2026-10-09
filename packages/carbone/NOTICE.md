# Происхождение кода

Пакет `@carbone-reports/carbone` — изменённая копия Carbone Community Edition 3.8.2
(https://github.com/carboneio/carbone, через форк https://github.com/SamRozhkov/carbone, коммит `1df45b5`),
перенесённая в монорепо carbone-reports через `git subtree` вместе с историей.

Лицензия — Carbone Community License (CCL), текст в `LICENSE.md`. Пакет используется только как часть
продукта carbone-reports (CCL 2.1(b), 2.1(d)) и отдельно не распространяется (`"private": true`).
Пользователи carbone-reports уведомляются, что эта часть продукта подчиняется CCL (раздел «Лицензии» README).

## Отличия от апстрима

- Удалена конвертация через LibreOffice (`converter.js`, `converter.py`, `format.js`, опции `convertTo`/`renderPrefix`).
  Документ собирается в формате шаблона; перевод в другие форматы делает OnlyOffice Document Server в API.
- Добавлена `renderBuffer(template, ext, data, options)` — сборка из буфера без временных файлов.
- Перенесён синтаксис бесплатного режима Carbone 5 (итератор `.i`, циклы по массивам строк, `:set`,
  новые форматтеры, поведение отключённых функций) — см. историю коммитов `packages/carbone`.

## Правило чистой реализации

Новые возможности написаны по открытой документации carbone.io и по записанному поведению
Carbone EE 5.15.3 без лицензии (эталоны `test/golden/*.json`). Код из образа `carbone/carbone-ee`
не читался, не извлекался и не копировался.

## Обновление из апстрима

`git subtree pull --prefix=packages/carbone carbone-fork master` (без `--squash`, как и при импорте).
