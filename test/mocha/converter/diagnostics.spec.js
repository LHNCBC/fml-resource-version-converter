/**
 * Tests for diagnostic message and runtime status helpers.
 */
import { strict as assert } from 'node:assert';
import {
  assertStatus,
  assertWarningInvariant,
  hasWarningMessage,
  infoMessage,
  makeMessage,
  maxStatus,
  rollupStatus,
  STATUS,
  statusFromMessages,
  warningMessage,
} from '../../../src/converter/diagnostics.js';


describe('converter/diagnostics', function () {
  it('builds diagnostic messages and preserves extra fields', function () {
    assert.deepEqual(infoMessage('hello'), { type: 'info', text: 'hello' });
    assert.deepEqual(warningMessage('careful', { path: 'Patient.name' }), {
      type: 'warning',
      text: 'careful',
      path: 'Patient.name',
    });
  });

  it('rejects invalid message type or text', function () {
    assert.throws(() => makeMessage('debug', 'x'), /Invalid message type/);
    assert.throws(() => makeMessage('info', ''), /non-empty string/);
  });

  it('does not let extra fields override type or text', function () {
    const msg = makeMessage('info', 'real text', { type: 'warning', text: 'fake', path: 'X' });
    assert.equal(msg.type, 'info');
    assert.equal(msg.text, 'real text');
    assert.equal(msg.path, 'X');
  });

  it('detects warning messages, tolerant of null/undefined', function () {
    assert.equal(hasWarningMessage(undefined), false);
    assert.equal(hasWarningMessage(null), false);
    assert.equal(hasWarningMessage('not-an-array'), false);
    assert.equal(hasWarningMessage([infoMessage('i')]), false);
    assert.equal(hasWarningMessage([infoMessage('i'), warningMessage('w')]), true);
  });

  it('validates statuses', function () {
    assert.doesNotThrow(() => assertStatus(STATUS.OK));
    assert.doesNotThrow(() => assertStatus(STATUS.WARNING));
    assert.throws(() => assertStatus('error'), /Invalid status/);
  });

  it('enforces warning status requires a warning message', function () {
    assert.doesNotThrow(() => assertWarningInvariant(STATUS.OK, undefined));
    assert.doesNotThrow(() => assertWarningInvariant(STATUS.OK, [warningMessage('note')]));
    assert.doesNotThrow(() => assertWarningInvariant(STATUS.WARNING, [warningMessage('problem')]));
    assert.throws(() => assertWarningInvariant(STATUS.WARNING, [infoMessage('only info')]), /no warning message/);
  });

  it('rolls up status to the highest severity', function () {
    assert.equal(maxStatus(STATUS.OK, STATUS.WARNING), STATUS.WARNING);
    assert.equal(maxStatus(STATUS.WARNING, STATUS.OK), STATUS.WARNING);
    assert.equal(rollupStatus([]), STATUS.OK);
    assert.equal(rollupStatus([STATUS.OK, STATUS.WARNING, STATUS.OK]), STATUS.WARNING);
  });

  it('derives status from warning messages only', function () {
    assert.equal(statusFromMessages([]), STATUS.OK);
    assert.equal(statusFromMessages([infoMessage('details')]), STATUS.OK);
    assert.equal(statusFromMessages([warningMessage('soft issue')]), STATUS.WARNING);
  });
});


