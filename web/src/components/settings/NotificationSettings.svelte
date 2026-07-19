<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../shared/strings';
  import { boolFor, valueFor } from '../../settings/settings-support';
  import type { Settings } from '../../settings/settings-support';
  import { settle } from '../shared/ui-effect';
  import {
    fetchAvailableSounds,
    getSelectedSound,
    playDoneSound,
    setDoneNotifyEnabled,
    requestNotifyPermission,
    registerPushSubscription,
    unregisterPushSubscription,
  } from '../../session/chat/done-notifier';

  let {
    settings = {},
    onSave = () => {},
    onSaved = () => {},
  }: {
    settings?: Settings;
    onSave?: (key: string, value: string) => void;
    onSaved?: () => void;
  } = $props();
  const notifyKey = 'pican:v1:notify-on-done';
  const soundKey = 'pican:v1:done-sound';
  let notify = $derived(boolFor(settings, notifyKey, false));
  let sound = $derived(
    valueFor(settings, soundKey, getSelectedSound({ storage: globalThis.localStorage })),
  );
  let sounds = $state<ReadonlyArray<string>>(['cat.mp3', 'done.mp3']);

  onMount(() => {
    void settle(() => fetchAvailableSounds({ fetchImpl: window.fetch.bind(window) })).then(
      (result) => {
        if (result.ok) sounds = result.value.sounds || sounds;
      },
    );
  });

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

  function handleSound(value: string) {
    onSave(soundKey, value);
    playDoneSound({ windowImpl: window, storage: localStorage });
    onSaved();
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
  <div class="settings-row">
    <div class="settings-row-label">
      <span class="name">{t('settings.doneSound')}</span><span class="hint"
        >{t('settings.doneSoundHint')}</span
      >
    </div>
    <div class="settings-control">
      <select
        data-setting={soundKey}
        data-setting-sound
        value={sound}
        onchange={(e) => handleSound(e.currentTarget.value)}
        >{#each sounds as name (name)}<option value={name}>{name}</option>{/each}</select
      >
    </div>
  </div>
</section>
