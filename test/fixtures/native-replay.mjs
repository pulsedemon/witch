import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import process from 'node:process';

const frames = readFileSync(process.argv[2], 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));

const fragment = Number(process.argv[3]);
const gates = new Set(JSON.parse(process.argv[4]));
const bindings = new Map();
const reverse = new Map();
const inputs = [];
let position = 0;
let held = false;
const session = process.argv[5];

const recorded = frames
  .map(({ message }) => message.session_id)
  .find((id) => typeof id === 'string');

// Claude Code can echo the launch's session id before the client first sends it
if (session && recorded) {
  bindings.set(recorded, session);
  reverse.set(session, recorded);
}

const identity = new Set([
  'id',
  'request_id',
  'uuid',
  'session_id',
  'command_uuid',
  'threadId',
  'turnId',
  'itemId',
  'tool_use_id',
]);

const identityLists = new Set([
  'user_message_uuids',
  'still_queued',
  'cancelled',
  'input_messages',
]);

function bind(expected, actual, key) {
  assert.equal(typeof actual, typeof expected, `ID type at ${key}`);

  if (!bindings.has(expected)) {
    assert.ok(
      !reverse.has(actual) || reverse.get(actual) === expected,
      `Distinct IDs collapsed at ${key}`,
    );

    bindings.set(expected, actual);
    reverse.set(actual, expected);
  }

  assert.equal(actual, bindings.get(expected), `ID mismatch at ${key}`);

  return actual;
}

function adapt(value, key = '') {
  if (
    (identity.has(key) || identityLists.has(key)) &&
    (typeof value === 'string' || typeof value === 'number')
  )
    return bind(value, bindings.get(value) ?? value, key);

  if (typeof value === 'string') {
    return value
      .replaceAll('/native/project', process.cwd())
      .replaceAll('/home/native', homedir());
  }

  if (Array.isArray(value)) return value.map((child) => adapt(child, key));

  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, adapt(child, name)]),
    );

  return value;
}

function match(expected, actual, key = '') {
  if (
    (identity.has(key) || identityLists.has(key)) &&
    (typeof expected === 'string' || typeof expected === 'number')
  ) {
    bind(expected, actual, key);

    return;
  }

  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((child, index) => match(child, actual[index], key));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object');
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());

    for (const [name, child] of Object.entries(expected))
      match(child, actual[name], name);
  } else assert.deepEqual(actual, adapt(expected, key));
}

function fail(error) {
  process.stderr.write(`frame ${position}: ${error.stack ?? error}\n`);
  process.exit(1);
}

function advance() {
  try {
    while (!held && position < frames.length) {
      if (gates.delete(position)) {
        held = true;
        process.send?.({ paused: position });

        return;
      }

      const frame = frames[position];

      if (frame.direction === 'client') {
        if (!inputs.length) return;

        match(frame.message, inputs.shift());
      } else {
        const text = JSON.stringify(adapt(frame.message)) + '\n';

        if (fragment)
          for (let offset = 0; offset < text.length; offset += fragment)
            process.stdout.write(text.slice(offset, offset + fragment));
        else process.stdout.write(text);
      }

      position++;
    }

    if (position === frames.length)
      assert.equal(inputs.length, 0, 'Unexpected trailing client frame');
  } catch (error) {
    fail(error);
  }
}

function finish() {
  if (position !== frames.length || inputs.length)
    fail(new Error(`Unconsumed native trace (${position}/${frames.length})`));

  process.exit(0);
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    try {
      inputs.push(JSON.parse(line));
      advance();
    } catch (error) {
      fail(error);
    }
  })
  .on('close', finish);

process.on('message', (message) => {
  if (message.release) {
    held = false;
    advance();
  }
});

process.on('SIGTERM', finish);
advance();
