<script lang="ts">
  import { t } from '../../shared/strings';
  import { valueFor } from '../../settings/settings-support';
  import type { Settings } from '../../settings/settings-support';

  let {
    settings = {},
    onSave = () => {},
  }: { settings?: Settings; onSave?: (key: string, value: string) => void } = $props();
  const spinnerKey = 'pican:spinner-style';
  const layoutKey = 'pican:view-layout';
  let spinner = $derived(valueFor(settings, spinnerKey, 'runcat'));
  let layout = $derived(valueFor(settings, layoutKey, 'timeline'));
</script>

<section class="settings-section">
  <div class="settings-section-title">{t('settings.sessionsList')}</div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.spinnerStyle')}</span><span class="hint"
        >{t('settings.spinnerStyleHint')}</span
      >
    </div>
    <div class="settings-control">
      <select
        data-setting={spinnerKey}
        value={spinner}
        onchange={(e) => onSave(spinnerKey, e.currentTarget.value)}
      >
        <option value="runcat">{t('settings.spinnerRuncat')}</option><option value="braille"
          >{t('settings.spinnerBraille')}</option
        ><option value="pacman">{t('settings.spinnerPacman')}</option><option value="comet"
          >{t('settings.spinnerComet')}</option
        >
      </select>
    </div>
  </div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.defaultLayout')}</span><span class="hint"
        >{t('settings.defaultLayoutHint')}</span
      >
    </div>
    <div class="settings-control">
      <select
        data-setting={layoutKey}
        value={layout}
        onchange={(e) => onSave(layoutKey, e.currentTarget.value)}
      >
        <option value="timeline">{t('index.layoutTimeline')}</option><option value="projects"
          >{t('index.layoutProjects')}</option
        >
      </select>
    </div>
  </div>
</section>
