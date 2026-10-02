# Проверка точных Rust use bindings — 02.10.2026

Основа: `f981fc71d374a53ec742089b3d7670c37fc67c6d`, ветка
`integration/local-2026-10-01`. Ниже зафиксирована проверка локальной
integration-версии; результаты отдельной upstream-ветки отмечаются отдельно.

## Ошибка и исправление

При `use crate::util::take; take()` граф связывал вызов с `src/a.rs::take`,
хотя import edge указывал на `src/util.rs`. На исходном коде первые
регрессионные проверки дали 7 падений из 8.

Теперь явный bare-вызов разрешается по полному пути `use` до общих эвристик.
Поддержаны aliases, вложенные группы, `crate`/`self`/`super`, функции корня
crate и same-file aliases. `crate` остаётся относительно вызывающего package.
Разбор хранит области блоков и inline modules, пропускает comments/string
literals и не смешивает импорты соседних блоков. Близкий import может затенять
внешнее объявление; параметры и простой `let` защищают собственные значения.
Положение объявления в исходнике исключает чужие inline-module функции,
которые Rust extractor записывает без module-prefix. Enum variant проверяется
через точный enum и диапазон его объявления.

Неоднозначный или недоступный target остаётся unresolved. Такой вызов не
переходит к одноимённой функции другого модуля. Memo сбрасывается при sync;
регрессия проверяет изменение import target после правки файла.

Extraction version повышена с 36 до 37: существующим индексам нужен rebuild,
чтобы получить исправленные edges.

## Проверки

- 14 полных наборов Rust и общих resolver/framework/alias проверок:
  **477 passed native**, **477 passed при CODEGRAPH_KERNEL=0**.
- Rust-проверки `extraction.test.ts`: **26 passed native**, **26 passed WASM**;
  остальные 678 случаев этого файла исключены фильтром имени.
- Итого выбранные проверки: **503 passed в каждом режиме**. Полная общая
  suite этим изменением не запускалась.
- Независимое ревью: 16 проверок графа, новых блокеров не осталось.
- Smoke собранного `dist/`: alias ведёт в `src/util.rs`, после source edit и
  sync — в `src/a.rs`, в обоих режимах. `kernelRoutes('rust')` подтверждает
  native/WASM выбор; сам факт загрузки binary через `getKernel()` не доказывает
  использование native extraction.
- TypeScript compilation, копирование assets, сборка viewer и проверка его
  bundle успешны; `git diff --check` чистый.
- Существующий индекс собственного checkout пересобран: extraction version
  **37**, `state=complete`, `pendingRefs=0`, `reindexRecommended=false`;
  1099 файлов, 27856 nodes, 87385 edges. Это не переиндексация остальных проектов.

Логи: `/home/danik/storage/codegraph-review-20261001/rust-use-*.log`.
Независимые probes и negative controls:
`/home/danik/storage/codegraph-review-20261001/rust-use-independent-review/`.

## Границы

Этот фикс разрешает явные именованные импорты по доказанным file/module paths.
Полный обход re-export chains, Cargo dependency renames, glob imports,
cfg/macro evaluation и value inference из destructuring/if-let/while-let
не добавлялись. Относительный путь внутри inline module без доказанного
file anchor отклоняется. Старое ошибочное разрешение некоторых chained
methods в общем name matcher остаётся отдельной задачей: новый проход
не принимает такой reference за imported bare-вызов.

Реальные Rust-проекты пользователя не изменялись и не переиндексировались.
Существующие посторонние untracked файлы checkout сохранены.
