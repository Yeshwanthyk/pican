<script lang="ts">
  import { t } from '../../shared/strings';
  import { boolFor, valueFor } from '../../settings/settings-support';
  import type { Settings } from '../../settings/settings-support';

  let {
    settings = {},
    onSave = () => {},
  }: { settings?: Settings; onSave?: (key: string, value: string) => void } = $props();
  const enabledKey = 'pican:v1:artifacts:enabled';
  const includeKey = 'pican:v1:artifacts:include';
  let enabled = $derived(boolFor(settings, enabledKey, true));
  let include = $derived(valueFor(settings, includeKey, ''));
</script>

<section class="settings-section">
  <div class="settings-section-title">{t('settings.artifacts')}</div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.showArtifacts')}</span><span class="hint"
        >{t('settings.showArtifactsHint')}</span
      >
    </div>
    <div class="settings-control">
      <label class="settings-toggle"
        ><input
          type="checkbox"
          data-setting={enabledKey}
          checked={enabled}
          onchange={(e) => onSave(enabledKey, e.currentTarget.checked ? 'true' : 'false')}
        /><span class="slider"></span></label
      >
    </div>
  </div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.includeFilter')}</span><span class="hint"
        >{t('settings.includeFilterHint')}</span
      >
    </div>
    <div class="settings-control">
      <input
        type="text"
        data-setting={includeKey}
        value={include}
        placeholder="*.md, *.html"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        onchange={(e) => onSave(includeKey, e.currentTarget.value)}
      />
    </div>
  </div>
</section>
