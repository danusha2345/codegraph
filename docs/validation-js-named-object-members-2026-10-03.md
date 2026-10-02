# Проверка именованных JS/TS object members — 2026-10-03

Изменение закрывает структурный пробел [#2300](https://github.com/colbymchenry/codegraph/issues/2300): методы прямого именованного object literal теперь имеют собственные определения и callers без обязательного `export`. Проверка выполнена в ветке `codex/js-object-member-definitions` от `3d86bcc0371079070d25901830fb2102100434c3`, Linux x64, Node.js `24.15.0`, Vitest `2.1.9` с зависимостями из upstream lockfile. Extraction stamp изменён с `27` на `28`; старый индекс требует обновления.

## Реализованная граница

- Прямые `const`/`let`/`var` object literals с method shorthand, function expression и arrow members получают `holder::member` definitions. Это относится и к именованным объектам внутри функций и IIFE. Локальные объекты только с данными и обычные primitive locals остаются прежними локальными переменными без самостоятельных nodes.
- Прямое присваивание literal на статический путь `window.Api`, `globalThis.Api`, `self.Api` или на уже извлечённый literal root создаёт namespace holder и его members. Global receiver доступен за пределами IIFE; тело member сохраняет исходный lexical context. Более глубокий путь и затенённый global root не заимствуют одноимённый member.
- Callers выбирают доказанного владельца. Anonymous sibling IIFEs, `var` hoisting, parameters, imports, named function expression self-binding и одноимённые object methods учитываются отдельно. Имя method shorthand само по себе не является lexical binding.
- Явный namespace alias, например `window.Known = { ping }`, следует binding в месте initializer. Active anonymous/arrow parameters и ближайшие неизвестные local values закрывают заимствование внешней функции. Root alias, closure без shadow и известный local arrow сохраняют точный target. Alias к self-name активного named function остаётся unresolved, если эта граница не доказывает callable identity.
- Ближайший literal с отсутствующим member закрывает fallback к внешнему literal. Это ограничение применяется к literal targets; typed class receiver и typed parameter сохраняют прежнюю class resolution.
- Duplicate properties, spreads и computed keys сохраняют существующую own-property проверку. Доказанная запись в binding/member консервативно закрывает устаревшую literal цель. Несколько competing global assignments дают unresolved: lexical scope присваивания не доказывает текущее global значение.

## Данные и транспорт

Используются существующие `contains` edges: holder хранит `metadata.jsObject` (`path`, source binding и lexical range), member — `metadata.jsObjectMember`. Новая таблица или миграция schema не требуются. Координаты — 1-based lines и UTF-16 columns, конец диапазона исключён.

`UnresolvedReference.candidates` содержит настоящие qualified names, например `window.Api::read`. Пустой массив означает, что AST не доказал literal target; отсутствие массива сохраняет обычный resolver. Opaque binding proof хранится в containment metadata, а не в публичном поле candidates. Native encoding сохраняет различие `[]` и `undefined`.

Candidates вычисляются после обхода всего файла, поэтому вызов из ранее объявленной функции может ссылаться на последующее literal declaration. Массив проходит все три bulk/worker projections, сохраняется в `edge.metadata.refCandidates` и восстанавливается при target-only sync. Resolver cache очищается вместе с остальными resolution caches. SFC folding сохраняет containment metadata и сдвигает binding/range lines вместе с script nodes; qualified names не переименовываются.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| `CARGO_BUILD_JOBS=2 npm run build:kernel` после последней native правки | exit 0; fresh linux-x64 module, 22.94 s |
| `npm run build` | exit 0; TypeScript, viewer assets и 29 grammar assets собраны |
| `js-named-object-members.test.ts` | 24/24: одинаковые public-graph controls с native и принудительным WASM/tree-sitter extractor |
| `kernel-tsjs-parity.test.ts` | 45/45: canonical nodes/edges/refs совпадают; четыре новые проверки охватывают TS, TSX, JS, JSX |
| `extraction`, `function-ref`, `object-literal-methods`, `namespace-object-resolution`, `vue-store-extraction` | 746/746 |
| `sfc-private-declarations`, `sfc-component-owns-script` | 7/7 |
| `expression-receiver-calls`, `js-builtin-method-calls`, `route-inline-handler-calls`, `ts-this-field-call`, `ts-chained-receiver` | 38/38 в native и 38/38 с `CODEGRAPH_KERNEL=0` |
| `resolution.test.ts`, группа `#1932` | 2/2 в native и 2/2 с `CODEGRAPH_KERNEL=0` |

Focused corpus по этапам: **862 теста, 15 файлов**; повторные native/WASM запуски не суммируются в этот итог. Последний связанный набор после alias guards: **109/109** (native, включая canonical parity) и **64/64** (принудительный WASM, без повторения canonical parity), затем `#1932` **2/2** в каждом режиме. Public-graph tests используют настоящие файлы, SQLite и публичные queries. В них проверены same-line Unicode/emoji positions, missing/deeper-path decoys, parameter/class shadowing, explicit writes, competing global assignments, named-self/parameter distinction, SFC containment/offsets, later declarations, target-only sync/reopen и принудительные parse/store/resolver workers. Mixed declarations сохраняют type references у enclosing function, не создавая local data nodes.

Первый полный прогон выявил устаревшие bare-qualified-name ожидания в пяти группах тестов. Ожидания заменены конкретными `api::map`, `userService::lookup`, `DraftHubStorage::get` и полным `window.Api.start`. Старый `window.MyNs.ping()` control вообще не определял namespace: теперь он проверяет unresolved, а отдельный `window.Known = { ping }` проверяет точный function id. Новый unknown-host/class-decoy control закрывает fallback при отсутствии доказанного holder; lexical `window` holder и typed `window` parameter сохраняют свои targets.

Команды тестов выполнялись через `node --liftoff-only node_modules/vitest/vitest.mjs run … --maxWorkers=1 --minWorkers=1`. Локальные логи:

- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/native-build.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/typescript-build.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/public-parity.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/existing-focused.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/sfc-focused.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/full-related-native.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/full-related-wasm.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/alias-focused-native.log`
- `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/alias-focused-wasm.log`

## Ограничения и следующий release gate

Существующий export gate для factory-returned object сохранён. Анонимный config literal, переданный аргументом, не получает новый named holder. Dynamic/computed receiver paths, opaque/nonliteral roots и namespace assignment до извлечения его root не доказываются этим изменением. Для локального namespace root с одними данными holder также не создаётся.

Нет общей alias analysis, исполнения factory, определения победившей записи или анализа произвольных side effects. Guard прямых записей намеренно консервативен и не утверждает runtime порядок. Изменение определения callable members не добавляет новые router/framework adapters.

Отдельная существующая граница generic resolution: untyped `function shadowed(window) { window.A.run() }` при единственном `RunDecoy::run` может выбрать этот class method. Это воспроизведено на baseline `fa3f3ac518128963938f0c44e6a2ae2929949877` без нового JS gate/member nodes с тем же fixture и target. Изменение закрывает заимствование новых literal members и доказанных истинных host-global путей; исправление всей generic inference для неизвестных project receivers сюда не входит. Baseline evidence: `/home/danik/storage/codegraph-review-20261001/js-validation-20261003/shadow-window-baseline.json`.

Focused Linux validation и полные проверки чистой upstream-ветки приведены отдельно ниже. Интеграция в локальную ветку и публикация проверяются после них. Windows/macOS runtime и A/B на реальных GUI проектах здесь не проводились. Новые индексы пользовательских проектов не создавались.

## Полные проверки чистой upstream-ветки после review

- Полный native suite: **456 файлов passed, 5936 tests passed, 36 skipped**.
- Полный совместимый WASM suite: **454 файла passed, 5927 tests passed,
  35 skipped**. Из него явно исключены `kernel-deep-nesting.test.ts` и
  `kernel-retry-materialize.test.ts`: эти два native-only файла не учитывают
  `CODEGRAPH_KERNEL=0` и падают также на Rust-ветке `fa3f3ac5` без JS-фикса.
- Исключения заданы во временном validation workspace вне source checkout,
  поскольку project-level `exclude` upstream workspace перекрывает CLI flag.
  Тесты и постоянная конфигурация для исключений не изменялись.
- Полные прогоны выполнены последовательно; конфликт default UI port из первого
  параллельного запуска не воспроизводится.
- Обновлённые ожидания проверяют qualified ownership (`api::map`,
  `DraftHubStorage::getSettings`, `userService::lookup`) и полный source path,
  а не число edges. Необъявленный `window.MyNs` теперь остаётся unresolved;
  явное `window.Known = { ping }` достигает конкретной lexical function.

Финальные логи: `full-native-final.log`, `full-wasm-compatible.log`,
`wasm-native-only-baseline.log`, `full-related-native.log`,
`full-related-wasm.log` в ранее указанном validation directory.

Интеграция в локальную ветку, runtime/index refresh и публикация выполняются
после этой проверки; package version не менялась.

## Перенос в локальную интеграцию

Локальная ветка `integration/local-2026-10-01` имеет отдельную историю:
extraction stamp изменён с `37` на `38`. При переносе сохранены существующие
Rust imported-call, Kotlin receiver-chain, PHP namespace-alias и Verilog/HDL
обработчики. В локальной SFC архитектуре metadata сдвигается непосредственно
в Vue/Svelte/Astro extractors; общая containment topology здесь не менялась.

- Fresh native kernel и `npm run build` — успешно, включая 30 grammar assets.
- Перенос: **105/105** тестов сохранённых language regressions и canonical parity.
- JS focused corpus в локальной ветке: **808/808**, 11 файлов.
- Дополнительный runtime smoke нашёл ошибки kind/name reattachment для
  нескольких `read` на одной строке в изменённом target file. Такие edges
  теперь восстанавливаются как исходные refs с qualified candidates.
  Контроль переставляет `window.A`/`window.B` и проверяет конкретный member
  после target-only sync и reopen.
- Fresh dist smoke в native и принудительном WASM: plain literal, issue IIFE,
  namespace caller и same-line target-only sync/reopen — успешно.
- Public SFC probe: Vue, Svelte, Astro frontmatter и Astro script — **4/4**
  в каждом режиме; native/WASM observations совпадают.

Логи переноса: `integration-native-build.log`, `integration-typescript-build.log`,
`integration-preserved-native.log`, `integration-js-focused.log`,
`integration-sync-regression.log` и `integration-sfc-{native,wasm}.json`
в указанном validation directory. Полная интеграционная проверка и индекс
будут зафиксированы после завершения.

Дополнительная проверка импортированного literal выявила границу старого
локального reattachment: импортный `A.read()` не имеет AST candidates,
поэтому одинаковые короткие имена тоже должны быть разрешены заново.
Перенос теперь повторяет исходные refs при ambiguous kind/name и при
qualified JS function calls. Отдельный final-candidate guard запрещает
подменять отсутствующий member его direct literal holder; прежние factory
и typed-class targets этого marker не имеют. Строгий контроль проверяет
перестановку, reopen, удаление `A.read` при сохранённом `B.read` и возвращение
метода. Финальный связанный набор: **283/283**, 5 файлов; оба extractor modes
проверены public-graph suite.

Первый полный локальный прогон до этих двух уточнений: **492 файла, 6286
passed, 2 expected fail, 32 skipped**. Expected failures — уже существующие
Python nested-class controls в `method-call-owner-class.test.ts`. Финальный
полный прогон после уточнений требуется отдельно.

Финальное review ограничило lookup literal metadata целями из JS/TS/SFC
family и refs с candidates или dotted calls. Это сохраняет missing-member
guard и не заполняет JS containment/null cache результатами других языков.
После этой оптимизации проводится финальный полный прогон той же source
версии. В предыдущем параллельном прогоне тест упаковки Windows archive
упёрся в 5 s timeout; отдельный `cli-ui-command` + `bundle-launcher` запуск
прошёл: **17 passed, 2 skipped**. Код упаковки не изменялся.
