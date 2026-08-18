<script lang="ts">
  import { t } from '../../shared/strings';
  import { boolFor } from '../../settings/settings-support';
  import type { Settings } from '../../settings/settings-support';
  import {
    setDoneNotifyEnabled,
    requestNotifyPermission,
    registerPushSubscription,
    unregisterPushSubscription,
  } from '../../session/chat/done-notifier';

  let {
    settings = {},
    onSave = () => {},
  }: {
    settings?: Settings;
    onSave?: (key: string, value: string) => void;
  } = $props();
  const notifyKey = 'pican:v1:notify-on-done';
  let notify = $derived(boolFor(settings, notifyKey, false));

  async function handleNotifyToggle(checked: boolean) {
    if (!checked) {
      setDoneNotifyEnabled(false, { storage: localStorage });
      await unregisterPushSubscription({
        windowImpl: window,
        fetchImpl: window.fetch.bind(window),
      });
      onSave(notifyKey, 'false');
      return;
    }
    const permission = await requestNotifyPermission({ windowImpl: window });
    const granted = permission === 'granted';
    setDoneNotifyEnabled(granted, { storage: localStorage });
    if (granted)
      await registerPushSubscription({ windowImpl: window, fetchImpl: window.fetch.bind(window) });
    onSave(notifyKey, granted ? 'true' : 'false');
  }
</script>

<section class="settings-section">
  <div class="settings-section-title">{t('settings.notifications')}</div>
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.notifyReady')}</span><span class="hint"
        >{t('settings.notifyReadyHint')}</span
      >
    </div>
    <div class="settings-control">
      <label class="settings-toggle"
        ><input
          type="checkbox"
          data-setting={notifyKey}
          checked={notify}
          onchange={(e) => handleNotifyToggle(e.currentTarget.checked)}
        /><span class="slider"></span></label
      >
    </div>
  </div>
</section>
