// Flags: --expose-internals
'use strict';

const common = require('../common');

if (!common.isLinux)
  common.skip('Linux-specific recursive fs.watch() behavior');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tmpdir = require('../common/tmpdir');
const { kFSWatchStart } = require('internal/fs/watchers');
const { FSWatcher } = require('internal/fs/recursive_watch');

function createWatcher(onClose) {
  return {
    close() {
      onClose?.();
    },
  };
}

tmpdir.refresh();

const directory = tmpdir.resolve('recursive-recreated-directory');
const child = path.join(directory, 'child');
const replacement = path.join(directory, 'replacement');
const originalWatch = fs.watch;
const watcher = new FSWatcher({ recursive: true });
const changes = [];
const childListeners = [];
let directoryListener;
let staleWatcherCloseCalls = 0;

fs.mkdirSync(child, { recursive: true });
fs.writeFileSync(path.join(child, 'a.txt'), 'old');

watcher.on('change', (eventType, filename) => changes.push([eventType, filename]));

fs.watch = common.mustCall((filename, options, listener) => {
  if (filename === directory) {
    directoryListener = listener;
    return createWatcher();
  }

  assert.strictEqual(filename, child);
  childListeners.push(listener);
  if (childListeners.length === 1) {
    return createWatcher(() => staleWatcherCloseCalls++);
  }
  return createWatcher();
}, 3);

try {
  watcher[kFSWatchStart](directory);
  assert.strictEqual(childListeners.length, 1);

  // Keep both directories alive at once so the replacement has a distinct
  // inode even on filesystems that quickly reuse inode numbers.
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, 'a.txt'), 'new');
  const oldInode = fs.statSync(child).ino;
  const newInode = fs.statSync(replacement).ino;
  assert.notStrictEqual(newInode, oldInode);

  fs.rmSync(child, { recursive: true });
  fs.renameSync(replacement, child);

  // Deliver the parent's queued event only after the path has been recreated.
  directoryListener('rename', 'child');

  assert.strictEqual(childListeners.length, 2);
  assert.strictEqual(staleWatcherCloseCalls, 1);
  assert.deepStrictEqual(changes, [['rename', 'child/a.txt']]);

  // The new directory watcher must observe changes below the recreated path.
  childListeners[1]('change', 'a.txt');
  assert.deepStrictEqual(changes, [
    ['rename', 'child/a.txt'],
    ['change', 'child/a.txt'],
  ]);
} finally {
  watcher.close();
  fs.watch = originalWatch;
}
