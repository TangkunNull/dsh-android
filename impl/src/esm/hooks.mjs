// Resolve hooks for ESM-shaped plugins (task A-4).
//
// Most client halves are classic scripts calling __ModuleLoader__.load(), but a
// growing minority ship as ES modules with real `import` statements. Those die
// instantly under vm.runInContext ("Cannot use import statement outside a
// module"), so the harness registers a resolve hook that redirects every host
// specifier to the module file that implements it.
//
// This file runs on the loader thread: it may only use serialisable state passed
// through `initialize()`, which is why the table is a plain {spec: fileUrl} map.
let TABLE = Object.create(null);

export function initialize(data) {
  TABLE = Object.assign(Object.create(null), data?.map || {});
}

export async function resolve(specifier, context, next) {
  const hit = TABLE[specifier];
  if (hit) return { url: hit, shortCircuit: true, format: 'module' };
  return next(specifier, context);
}
