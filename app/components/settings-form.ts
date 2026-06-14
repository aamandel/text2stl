import Component from '@glimmer/component';
import TextMakerSettings from 'text2stl/models/text-maker-settings';
import { ModelType } from 'text2stl/services/text-maker';

interface SettingsFormTextSettingsArgs {
  model: TextMakerSettings;
}

export default class SettingsFormSettings extends Component<SettingsFormTextSettingsArgs> {
  get showHandleSettings() {
    // Handles/holes are built into the rectangle outline only. Vertical text
    // always uses the rectangle; the other support types only when 'rectangle'.
    if (this.args.model.type === ModelType.TextOnly) {
      return false;
    }
    if (this.args.model.type === ModelType.VerticalTextWithSupport) {
      return true;
    }
    return (this.args.model.supportShape ?? 'rectangle') === 'rectangle';
  }
  get showSupportSettings() {
    return this.args.model.type !== ModelType.TextOnly;
  }
}
