import { module, test } from 'qunit';
import { setupRenderingTest } from 'ember-qunit';
import { render, click, find, triggerEvent } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';
import config from 'text2stl/config/environment';
const {
  APP: { textMakerDefault },
} = config;
import TextMakerSettings from 'text2stl/models/text-maker-settings';
import { ModelType } from 'text2stl/services/text-maker';
import fillCalciteInput from 'text2stl/tests/helpers/fill-calcite-input';
import { setupIntl } from 'ember-intl/test-support';

module('Integration | Component | settings-form/text', function (hooks) {
  setupRenderingTest(hooks);
  setupIntl(hooks);

  test('it renders', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);

    assert.dom('[data-test-settings-text]').hasValue(model.text, 'It renders correct text value');
    await fillCalciteInput('[data-test-settings-text]', 'Updated');
    assert.strictEqual(model.text, 'Updated', 'model.text was updated');

    assert
      .dom('[data-test-settings-size]')
      .hasValue(`${model.size}`, 'It renders correct size value');
    await fillCalciteInput('[data-test-settings-size]', '123');
    assert.strictEqual(model.size, 123, 'model.size was updated');

    assert
      .dom('[data-test-settings-height]')
      .hasValue(`${model.height}`, 'It renders correct height value');
    await fillCalciteInput('[data-test-settings-height]', '456');
    assert.strictEqual(model.height, 456, 'model.height was updated');

    assert
      .dom('[data-test-settings-spacing]')
      .hasValue(`${model.spacing}`, 'It renders correct spacing value');
    await fillCalciteInput('[data-test-settings-spacing]', '789');
    assert.strictEqual(model.spacing, 789, 'model.spacing was updated');

    assert
      .dom(
        `[data-test-settings-text-valignment] calcite-radio-button[data-test-value="${model.vAlignment}"]`,
      )
      .hasAttribute('checked', '', 'current textAlignment radio is checked');
    await click(
      '[data-test-settings-text-valignment] calcite-radio-button[data-test-value="bottom"]',
    );
    assert.strictEqual(model.vAlignment, 'bottom', 'model.vAlignment was updated');
  });

  for (const { type, inputType, title } of [
    { type: ModelType.TextOnly, inputType: 'calcite-text-area', title: 'TextOnly' },
    { type: ModelType.NegativeText, inputType: 'calcite-text-area', title: 'NegativeText' },
    { type: ModelType.TextWithSupport, inputType: 'calcite-text-area', title: 'TextWithSupport' },
    {
      type: ModelType.VerticalTextWithSupport,
      inputType: 'calcite-input-text',
      title: 'VerticalTextWithSupport',
    },
  ]) {
    test(`Text input type depends on model Type [${title}]`, async function (assert) {
      const model = new TextMakerSettings({
        ...textMakerDefault,
        type,
      });
      this.set('model', model);

      await render(hbs`<SettingsForm::Text @model={{this.model}} />`);
      assert.dom(`${inputType}[data-test-settings-text]`).exists(`It renders a ${inputType}`);
    });
  }

  test('Text alignment & vertical spacing are shown when text is multiline', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
      text: 'some\nmultiline\ntext',
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);

    assert.dom('[data-test-settings-text-alignment]').exists();
    assert
      .dom(
        `[data-test-settings-text-alignment] calcite-radio-button[data-test-value="${model.alignment}"]`,
      )
      .isChecked('current textAlignment radio is checked');

    assert
      .dom('[data-test-settings-vspacing]')
      .hasValue(`${model.vSpacing}`, 'It renders correct vspacing value');
    await fillCalciteInput('[data-test-settings-vspacing]', '237');
    assert.strictEqual(model.vSpacing, 237, 'model.vspacing was updated');
  });

  test('Custom line spacing exposes an independent gap input per line gap', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
      text: 'line1\nline2\nline3',
      vSpacing: 5,
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);

    assert
      .dom('[data-test-custom-line-spacing]')
      .exists('It displays the custom line spacing switch')
      .isNotChecked('custom line spacing is off by default');
    assert
      .dom('[data-test-settings-line-gap]')
      .doesNotExist('per-gap inputs are hidden while custom line spacing is off');

    // Enable custom line spacing: every gap is seeded from the global vSpacing
    await click('[data-test-custom-line-spacing]');
    assert.true(model.customLineSpacing, 'model.customLineSpacing was enabled');
    assert.deepEqual(model.lineSpacings, [5, 5], 'gaps are seeded from the global vSpacing');

    // 3 lines => 2 gaps
    assert.dom('[data-test-settings-line-gap]').exists({ count: 2 }, 'one input per line gap');
    assert.dom('[data-test-settings-line-gap="0"]').hasValue('5', 'gap 0 shows seeded value');
    assert.dom('[data-test-settings-line-gap="1"]').hasValue('5', 'gap 1 shows seeded value');

    // Editing one gap leaves the others untouched
    await fillCalciteInput('[data-test-settings-line-gap="1"]', '12');
    assert.deepEqual(model.lineSpacings, [5, 12], 'only the edited gap was updated');
  });

  // Programmatically change a calcite-segmented-control (avoids click flakiness):
  // set its value then fire the change event the component listens for.
  async function changeSegmentedControl(selector: string, value: string) {
    const control = find(selector) as HTMLElement & { value: string };
    control.value = value;
    await triggerEvent(control, 'calciteSegmentedControlChange');
  }

  test('Curved text: per-line path blocks with add / edit / type / remove', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
      text: 'one\ntwo',
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);

    assert
      .dom('[data-test-custom-text-path]')
      .exists('It displays the curved-text switch')
      .isNotChecked('curved text is off by default');
    assert.dom('[data-test-line-path]').doesNotExist('no path blocks while curved text is off');

    // Enable curved text -> one block per line
    await click('[data-test-custom-text-path]');
    assert.true(model.customTextPath, 'model.customTextPath was enabled');
    assert.dom('[data-test-line-path]').exists({ count: 2 }, 'one path block per line');

    // Add a segment to the first line -> defaults to an arc
    await click('[data-test-add-segment="0"]');
    assert.strictEqual(model.linePaths[0]!.segments.length, 1, 'a segment was added');
    assert.strictEqual(model.linePaths[0]!.segments[0]!.type, 'arc', 'new segment defaults to arc');
    assert.dom('[data-test-segment-width="0"]').exists('arc width input is shown');

    // Edit the arc's width and radius
    await fillCalciteInput('[data-test-segment-width="0"]', '50');
    await fillCalciteInput('[data-test-segment-radius="0"]', '20');
    const arc = model.linePaths[0]!.segments[0]!;
    const arcWidth = arc.type === 'arc' ? arc.width : NaN;
    const arcRadius = arc.type === 'arc' ? arc.radius : NaN;
    assert.strictEqual(arc.type, 'arc', 'segment is an arc');
    assert.strictEqual(arcWidth, 50, 'arc width updated');
    assert.strictEqual(arcRadius, 20, 'arc radius updated');

    // radius (20) < width (50) -> clamp hint is shown
    assert
      .dom('[data-test-segment="0"] calcite-input-message')
      .exists('clamp hint shown when radius is too small for the width');

    // Switch the segment to a wave -> wave inputs appear
    await changeSegmentedControl('[data-test-segment-type="0"]', 'wave');
    assert.strictEqual(model.linePaths[0]!.segments[0]!.type, 'wave', 'segment switched to wave');
    assert.dom('[data-test-segment-amplitude="0"]').exists('wave amplitude input is shown');
    assert.dom('[data-test-segment-width="0"]').doesNotExist('arc inputs are gone');

    // Change this line to upright orientation
    await changeSegmentedControl('[data-test-line-orientation="0"]', 'upright');
    assert.strictEqual(model.linePaths[0]!.orientation, 'upright', 'orientation updated');

    // Remove the segment
    await click('[data-test-remove-segment="0"]');
    assert.strictEqual(model.linePaths[0]!.segments.length, 0, 'segment removed');
  });

  test('Curved text: editing a segment keeps its line block open (DOM is reused)', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
      text: 'one\ntwo',
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);
    await click('[data-test-custom-text-path]');
    await click('[data-test-add-segment="0"]');

    type MarkedBlock = HTMLElement & { open: boolean; marker?: string };
    const block = find('[data-test-line-path="0"]') as MarkedBlock;
    // Open the block and mark the element so we can detect if it gets recreated.
    block.open = true;
    block.marker = 'keep';

    await fillCalciteInput('[data-test-segment-width="0"]', '42');

    const blockAfter = find('[data-test-line-path="0"]') as MarkedBlock;
    assert.strictEqual(blockAfter.marker, 'keep', 'the same block element is reused across the edit');
    assert.true(blockAfter.open, 'the block stays open after changing a value');
  });

  test('Curved text: visualization toggle appears with curved text and defaults on', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.TextOnly,
      text: 'one\ntwo',
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);

    assert
      .dom('[data-test-show-path-preview]')
      .doesNotExist('no visualization toggle until curved text is enabled');

    await click('[data-test-custom-text-path]');
    assert
      .dom('[data-test-show-path-preview]')
      .exists('visualization toggle appears with curved text')
      .isChecked('visualization is on by default');
    assert.true(model.showPathPreview, 'model.showPathPreview defaults to true');

    await click('[data-test-show-path-preview]');
    assert.false(model.showPathPreview, 'toggling turns the visualization off');
  });

  test('Curved text switch is hidden for vertical-text type', async function (assert) {
    const model = new TextMakerSettings({
      ...textMakerDefault,
      type: ModelType.VerticalTextWithSupport,
    });
    this.set('model', model);

    await render(hbs`<SettingsForm::Text @model={{this.model}} />`);
    assert.dom('[data-test-custom-text-path]').doesNotExist('no curved-text switch for vertical text');
  });
});
