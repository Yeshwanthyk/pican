<script lang="ts">
  import { t } from '../../shared/strings.js';
  import type { NormalizedSession } from '../../index/sessions.js';
  import type { NormalizedPeerHost } from '../../index/peers.js';
  import MachinesSection from './MachinesSection.svelte';
  import WaitingSection from './WaitingSection.svelte';

  interface Props {
    waitingSessions?: ReadonlyArray<NormalizedSession>;
    peerHosts?: ReadonlyArray<NormalizedPeerHost>;
    now?: number;
    onAnswer?: (session: NormalizedSession, answer: string) => Promise<boolean>;
  }

  let {
    waitingSessions = [],
    peerHosts = [],
    now = Date.now(),
    onAnswer = async () => false,
  }: Props = $props();
</script>

<aside class="home-rail" aria-label={t('index.homeRail')}>
  <WaitingSection {waitingSessions} {onAnswer} />

  {#if peerHosts.length > 0}
    <MachinesSection hosts={peerHosts} {now} />
  {/if}
</aside>
