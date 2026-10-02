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
  **478 passed native**, **478 passed при CODEGRAPH_KERNEL=0**.
- Rust-проверки `extraction.test.ts`: **26 passed native**, **26 passed WASM**;
  остальные 678 случаев этого файла исключены фильтром имени.
- Итого выбранные проверки: **504 passed в каждом режиме**. Полная общая
  suite этим изменением не запускалась.
- Независимое ревью: 16 проверок графа, новых блокеров не осталось.
- Smoke собранного `dist/`: alias ведёт в `src/util.rs`, после source edit и
  sync — в `src/a.rs`, в обоих режимах. `kernelRoutes('rust')` подтверждает
  native/WASM выбор; сам факт загрузки binary через `getKernel()` не доказывает
  использование native extraction.
- TypeScript compilation, копирование assets, сборка viewer и проверка его
  bundle успешны; `git diff --check` чистый.
- Существующий индекс собственного checkout после первого фикса пересобран: extraction version
  **37**, `state=complete`, `pendingRefs=0`, `reindexRecommended=false`;
  1099 файлов, 27856 nodes, 87385 edges. Это не переиндексация остальных проектов.

Логи: `/home/danik/storage/codegraph-review-20261001/rust-use-*.log`.
Независимые probes и negative controls:
`/home/danik/storage/codegraph-review-20261001/rust-use-independent-review/`.

## Проверка upstream-ветки

Ветка `codex/rust-exact-use-bindings` основана на upstream `main`
`3d86bcc0371079070d25901830fb2102100434c3`; здесь extraction version
повышена с 27 до 28. В PR входит только Rust-фикс и prerequisite module-path
проверка из #2259; остальная история integration не переносилась.

- Зависимости установлены через `npm ci` по upstream lockfile, Vitest 2.1.9.
- Native kernel пересобран из исходников этой ветки; TypeScript/viewer build
  и проверка assets успешны.
- Полный native-набор: **458 файлов passed, 5940 tests passed, 36 skipped**.
- Focused Rust/resolver/framework набор при `CODEGRAPH_KERNEL=0`:
  **14 файлов passed, 467 tests passed**.
- Публичная Unicode-регрессия подтверждает точную цель после кириллицы/emoji;
  CodeGraph nodes и references используют **UTF-16 columns**, не UTF-8 bytes.
- Прогоны выполнены на Linux; реальный Windows/macOS runtime не запускался.

Первый полный прогон с чужим Vitest 4 дал ошибки test harness; он не относится
к итоговой валидации. После установки правильного lockfile полный набор зелёный.
В upstream нет автоматического PR CI; результаты выше являются локальными.

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
