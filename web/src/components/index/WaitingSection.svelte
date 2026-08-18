<script lang="ts">
  import { t } from '../../shared/strings.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import type { NormalizedSession } from '../../index/sessions.js';
  import { withBasePath } from '../../shared/base-path.js';

  interface Props {
    waitingSessions?: ReadonlyArray<NormalizedSession>;
    onAnswer?: (session: NormalizedSession, answer: string) => Promise<boolean>;
  }

  let { waitingSessions = [], onAnswer = async () => false }: Props = $props();
  let answerBusy = $state('');

  async function answer(session: NormalizedSession, value: string) {
    if (answerBusy) return;
    answerBusy = value;
    await onAnswer(session, value);
    answerBusy = '';
  }
</script>

{#if waitingSessions.length > 0}
  <section class="rail-section rail-waiting">
    <div class="rail-heading">{t('index.waitingOnYou')}</div>
    <div class="rail-waiting-list">
      {#each waitingSessions as waiting (waiting.id)}
        <article class="rail-waiting-item">
          <a
            class="rail-session-title"
            href={withBasePath(`/session?id=${encodeURIComponent(waiting.id)}`)}
            onclick={(event) =>
              handleNavClick(event, `/session?id=${encodeURIComponent(waiting.id)}`)}
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
        </article>
      {/each}
    </div>
  </section>
{/if}
