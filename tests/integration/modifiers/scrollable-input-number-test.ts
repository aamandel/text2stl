import { module, test } from 'qunit';
import { setupRenderingTest } from 'ember-qunit';
import { render, find } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';

module('Integration | Modifier | scrollable-input-number', function (hooks) {
  setupRenderingTest(hooks);

  test('the wheel is ignored (page scrolls) when the field is not focused', async function (assert) {
    await render(
      hbs`<calcite-input-number value='5' {{scrollable-input-number}} data-test-input />`,
    );
    const input = find('[data-test-input]') as HTMLElement & { value: string };

    const wheel = new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true });
    input.dispatchEvent(wheel);

    assert.strictEqual(input.value, '5', 'value is unchanged when not focused');
    assert.false(wheel.defaultPrevented, 'scroll is not hijacked when not focused');
  });

  test('the wheel adjusts the value (and prevents page scroll) when focused', async function (assert) {
    await render(
      hbs`<calcite-input-number value='5' {{scrollable-input-number}} data-test-input />`,
    );
    const input = find('[data-test-input]') as HTMLElement & { value: string };

    // Real focus depends on the browser window owning focus, which is unreliable
    // in the test runner, so stub the :focus-within check the modifier relies on.
    const originalMatches = input.matches.bind(input);
    input.matches = (selector: string) =>
      selector === ':focus-within' ? true : originalMatches(selector);

    try {
      const wheel = new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true });
      input.dispatchEvent(wheel);

      assert.strictEqual(input.value, '6.00', 'value increases when scrolled up while focused');
      assert.true(wheel.defaultPrevented, 'scroll is hijacked (prevented) while focused');
    } finally {
      input.matches = originalMatches;
    }
  });
});
