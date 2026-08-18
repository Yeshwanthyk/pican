<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../shared/strings';
  import { boolFor, fetchModelGroups, valueFor } from '../../settings/settings-support';
  import type { ModelGroup, Settings } from '../../settings/settings-support';
  import { settle } from '../shared/ui-effect';

  let {
    settings = {},
    onSave = () => {},
  }: { settings?: Settings; onSave?: (key: string, value: string) => void } = $props();
  const enabledKey = 'pican:v1:auto-title:enabled';
  const modeKey = 'pican:v1:auto-title:mode';
  const modelKey = 'pican:v1:auto-title:model';
  const displayModel = (value: string): string =>
    value.endsWith(':off') ? value.slice(0, -':off'.length) : value;
  let enabled = $derived(boolFor(settings, enabledKey, false));
  let mode = $derived(valueFor(settings, modeKey, 'once'));
  let model = $derived(displayModel(valueFor(settings, modelKey, '')));
  let modelGroups = $state<ReadonlyArray<ModelGroup>>([]);

  onMount(() => {
    void settle(fetchModelGroups).then((result) => {
      if (result.ok) modelGroups = result.value;
    });
  });
</script>

<section class="settings-section">
  <div class="settings-section-title">{t('settings.sessionTitles')}</div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.autoTitle')}</span><span class="hint"
        >{t('settings.autoTitleHint')}</span
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
      <span class="name">{t('settings.whenToTitle')}</span><span class="hint"
        >{t('settings.whenToTitleHint')}</span
      >
    </div>
    <div class="settings-control">
      <select
        data-setting={modeKey}
        value={mode}
        onchange={(e) => onSave(modeKey, e.currentTarget.value)}
        ><option value="once">{t('settings.titleOnce')}</option><option value="each-turn"
          >{t('settings.titleEachTurn')}</option
        ></select
      >
    </div>
  </div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.titleModel')}</span><span class="hint"
        >{t('settings.titleModelHint')}</span
      >
    </div>
    <div class="settings-control">
      <select
        data-setting={modelKey}
        data-auto-title-model
        value={model}
        onchange={(e) => onSave(modelKey, e.currentTarget.value)}
      >
        <option value="">{t('settings.titleBuiltin')}</option>
        {#each modelGroups as group (group.provider)}
          <optgroup label={group.provider}>
            {#each group.models as option (option.value)}
              <option value={option.value}>{option.name}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </div>
  </div>
</section>
