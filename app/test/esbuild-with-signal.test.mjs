import assert from 'node:assert/strict';
import {test} from 'node:test';
import {context as nativeContext} from 'esbuild';
import {buildWithSignal} from '../scripts/esbuild-with-signal.mjs';

const options = {stdin: {contents: 'export const answer = 42;', loader: 'js'}, write: false};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const flush = async () => {await Promise.resolve(); await Promise.resolve();};
function trackedController() {
  const controller = new AbortController(), added = [], removed = [];
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {added.push(args); return add(...args);};
  controller.signal.removeEventListener = (...args) => {removed.push(args); return remove(...args);};
  return {controller, signal: controller.signal, added, removed};
}
function assertDetached(tracker) {
  assert.equal(tracker.added.length, 1);
  assert.equal(tracker.removed.length, 1);
  assert.equal(tracker.added[0][0], 'abort');
  assert.equal(tracker.removed[0][0], 'abort');
  assert.equal(tracker.added[0][1], tracker.removed[0][1]);
}
function observed(promise) {
  const state = {settled: false};
  state.promise = promise.then(value => {state.settled = true; return {value};},
    error => {state.settled = true; return {error};});
  return state;
}

test('an omitted signal preserves the native build options and result without creating a context', async () => {
  const result = {outputFiles: [{text: 'unchanged'}]};
  let builds = 0;
  assert.equal(await buildWithSignal(options, undefined, {
    build(received) {assert.equal(received, options); builds++; return Promise.resolve(result);},
    context() {assert.fail('No context for the existing build path');},
    stop() {assert.fail('The shared service must stay available');}
  }), result);
  assert.equal(builds, 1);
});

test('a completed rebuild returns its unchanged result only after disposal and removes its abort listener', async () => {
  const tracker = trackedController(), disposal = deferred(), calls = [], result = {warnings: []};
  const running = observed(buildWithSignal(options, tracker.signal, {
    context(received) {
      assert.equal(received, options);
      return {rebuild: async () => {calls.push('rebuild'); return result;},
        cancel: () => assert.fail('Successful builds are not canceled'),
        dispose: () => {calls.push('dispose'); return disposal.promise;}};
    }, stop: () => assert.fail('No global stop')
  }));
  await flush();
  assert.deepEqual(calls, ['rebuild', 'dispose']);
  assert.equal(running.settled, false);
  disposal.resolve();
  assert.equal((await running.promise).value, result);
  assertDetached(tracker);
});

test('a failed rebuild drains disposal and retains its original failure', async () => {
  const tracker = trackedController(), disposal = deferred(), failure = new Error('owning build failure');
  let disposed = false;
  const running = observed(buildWithSignal(options, tracker.signal, {context: async () => ({
    rebuild: async () => {throw failure;}, cancel: () => assert.fail('No unrelated cancellation'),
    dispose: () => {disposed = true; return disposal.promise;}
  })}));
  await flush();
  assert.equal(disposed, true);
  assert.equal(running.settled, false);
  disposal.reject(new Error('secondary disposal failure'));
  assert.equal((await running.promise).error, failure);
  assertDetached(tracker);
});

test('a pre-aborted signal prevents context creation and preserves its exact reason', async () => {
  const tracker = trackedController(), reason = new Error('setup deadline');
  tracker.controller.abort(reason);
  await assert.rejects(buildWithSignal(options, tracker.signal, {
    context: () => assert.fail('No creation after abort'), build: () => assert.fail('No native build after abort')
  }), error => error === reason);
  assert.equal(tracker.added.length, 0);
  assert.equal(tracker.removed.length, 0);
});

test('an abort during context creation cancels and disposes the late context without starting a rebuild', async () => {
  const tracker = trackedController(), creation = deferred(), cancellation = deferred(), disposal = deferred();
  const calls = [], reason = new Error('creation deadline');
  const running = observed(buildWithSignal(options, tracker.signal, {context: () => creation.promise}));
  tracker.controller.abort(reason);
  creation.resolve({rebuild: () => assert.fail('No rebuild after abort'),
    cancel: () => {calls.push('cancel'); return cancellation.promise;},
    dispose: () => {calls.push('dispose'); return disposal.promise;}});
  await flush();
  assert.deepEqual(calls, ['cancel']);
  assert.equal(running.settled, false);
  cancellation.resolve();
  await flush();
  assert.deepEqual(calls, ['cancel', 'dispose']);
  assert.equal(running.settled, false);
  disposal.resolve();
  assert.equal((await running.promise).error, reason);
  assertDetached(tracker);
});

test('an active rebuild, its cancellation and its disposal all settle before the original abort is returned', async () => {
  const tracker = trackedController(), rebuilding = deferred(), cancellation = deferred(), disposal = deferred();
  const calls = [], reason = new Error('compiler deadline');
  const running = observed(buildWithSignal(options, tracker.signal, {context: async () => ({
    rebuild: () => {calls.push('rebuild'); return rebuilding.promise;},
    cancel: () => {calls.push('cancel'); return cancellation.promise;},
    dispose: () => {calls.push('dispose'); return disposal.promise;}
  })}));
  await flush();
  tracker.controller.abort(reason);
  cancellation.resolve();
  await flush();
  assert.deepEqual(calls, ['rebuild', 'cancel']);
  assert.equal(running.settled, false, 'Cancel completion cannot outrun the active build');
  rebuilding.reject(new Error('esbuild canceled'));
  await flush();
  assert.deepEqual(calls, ['rebuild', 'cancel', 'dispose']);
  assert.equal(running.settled, false);
  disposal.resolve();
  assert.equal((await running.promise).error, reason);
  assertDetached(tracker);
});

test('rejected cancellation is observed immediately and cannot replace the signal reason', async () => {
  for (const synchronous of [false, true]) {
    const tracker = trackedController(), rebuilding = deferred(), reason = new Error('abort remains authoritative');
    let disposed = false;
    const running = observed(buildWithSignal(options, tracker.signal, {context: async () => ({
      rebuild: () => rebuilding.promise,
      cancel: () => {if (synchronous) throw Error('cancel threw'); return Promise.reject(Error('cancel rejected'));},
      dispose: async () => {disposed = true;}
    })}));
    await flush();
    tracker.controller.abort(reason);
    await flush();
    assert.equal(running.settled, false);
    rebuilding.reject(new Error('build canceled'));
    assert.equal((await running.promise).error, reason);
    assert.equal(disposed, true);
    assertDetached(tracker);
  }
});

test('an abort during disposal drains late cancellation before settling', async () => {
  const tracker = trackedController(), disposal = deferred(), cancellation = deferred(), reason = new Error('cleanup abort');
  let disposing = false, canceled = 0;
  const running = observed(buildWithSignal(options, tracker.signal, {context: async () => ({
    rebuild: async () => ({outputFiles: []}), cancel: () => {canceled++; return cancellation.promise;},
    dispose: () => {disposing = true; return disposal.promise;}
  })}));
  await flush();
  assert.equal(disposing, true);
  tracker.controller.abort(reason);
  disposal.resolve();
  await flush();
  assert.equal(canceled, 1);
  assert.equal(running.settled, false);
  cancellation.resolve();
  assert.equal((await running.promise).error, reason);
  assertDetached(tracker);
});

test('context creation and disposal failures still remove their listener', async () => {
  for (const stage of ['creation', 'disposal']) {
    const tracker = trackedController(), failure = new Error(stage);
    await assert.rejects(buildWithSignal(options, tracker.signal, {context: async () => {
      if (stage === 'creation') throw failure;
      return {rebuild: async () => ({}), cancel: () => assert.fail('No abort'), dispose: async () => {throw failure;}};
    }}), error => error === failure);
    assertDetached(tracker);
  }
});

test('the native esbuild context cancels an active build and finishes disposal before returning its signal reason', {timeout: 5000}, async () => {
  const controller = new AbortController(), reason = new Error('native build cancellation');
  let started = false, disposed = false;
  await assert.rejects(buildWithSignal({...options, plugins: [{name: 'bounded-native-cancellation', setup(builder) {
    builder.onStart(() => {started = true; controller.abort(reason);});
  }}]}, controller.signal, {context: async received => {
    const handle = await nativeContext(received);
    return {rebuild: () => handle.rebuild(), cancel: () => handle.cancel(),
      dispose: async () => {await handle.dispose(); disposed = true;}};
  }}), error => error === reason);
  assert.equal(started, true);
  assert.equal(disposed, true);
});
