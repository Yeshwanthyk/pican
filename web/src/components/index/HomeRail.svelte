<script lang="ts">
  import { t } from '../../shared/strings.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import type { NormalizedSession } from '../../index/sessions.js';
  import type { NormalizedPeerHost } from '../../index/peers.js';
  import type { Schedule } from '../../lib/schema';
  import MachinesSection from './MachinesSection.svelte';
  import { withBasePath } from '../../shared/base-path.js';

  interface Props {
    waitingSessions?: ReadonlyArray<NormalizedSession>;
    schedules?: ReadonlyArray<Schedule>;
    peerHosts?: ReadonlyArray<NormalizedPeerHost>;
    now?: number;
    onAnswer?: (session: NormalizedSession, answer: string) => Promise<boolean>;
    onSchedules?: () => void;
  }

  let {
    waitingSessions = [],
    schedules = [],
    peerHosts = [],
    now = Date.now(),
    onAnswer = async () => false,
    onSchedules = () => {},
  }: Props = $props();

  const waiting = $derived(waitingSessions[0]);
  const activeSchedules = $derived(schedules.filter((schedule) => schedule.enabled));
  const nextSchedule = $derived(
    [...activeSchedules]
      .filter((schedule) => schedule.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt || '') - Date.parse(b.nextRunAt || ''))[0],
  );
  let answerBusy = $state('');

  async function answer(session: NormalizedSession, value: string) {
    if (answerBusy) return;
    answerBusy = value;
    await onAnswer(session, value);
    answerBusy = '';
  }
</script>

<aside
  class="home-rail"
  aria-label={waiting ? t('index.waitingOnYou') : t('index.schedulesSummary')}
>
  {#if waiting}
    <section class="rail-section rail-waiting">
      <div class="rail-heading">{t('index.waitingOnYou')}</div>
      <a
        class="rail-session-title"
        href={withBasePath(`/session?id=${encodeURIComponent(waiting.id)}`)}
        onclick={(event) => handleNavClick(event, `/session?id=${encodeURIComponent(waiting.id)}`)}
        >{waiting.name}</a
      >
      <p class="rail-question">{waiting.waitingQuestion}</p>
      {#if waiting.waitingOptions.length > 0}
        <div class="rail-answer-options">
          {#each waiting.waitingOptions as option (option)}
            <button
              type="button"
              disabled={Boolean(answerBusy)}
              aria-label={t('index.answerQuestion', {
                answer: option,
                question: waiting.waitingQuestion,
              })}
              onclick={() => answer(waiting, option)}>{option}</button
            >
          {/each}
        </div>
      {:else}
        <a
          class="rail-open-session"
          href={withBasePath(`/session?id=${encodeURIComponent(waiting.id)}`)}
          onclick={(event) =>
            handleNavClick(event, `/session?id=${encodeURIComponent(waiting.id)}`)}
          >{t('index.openWaitingSession')}</a
        >
      {/if}
    </section>
  {:else}
    <section class="rail-section rail-schedules">
      <button class="rail-heading rail-heading-button" type="button" onclick={onSchedules}
        >{t('index.schedulesSummary')}</button
      >
      <div class="rail-schedule-count">
        {activeSchedules.length > 0
          ? t('index.schedulesActiveCount', { count: activeSchedules.length })
          : t('index.schedulesNone')}
      </div>
      {#if nextSchedule}
        <div class="rail-schedule-next">
          {t('index.schedulesNext', {
            name: nextSchedule.name,
            when: new Date(nextSchedule.nextRunAt || '').toLocaleString(),
          })}
        </div>
      {/if}
    </section>
  {/if}

  {#if peerHosts.length > 0}
    <MachinesSection hosts={peerHosts} {now} />
  {/if}
</aside>
