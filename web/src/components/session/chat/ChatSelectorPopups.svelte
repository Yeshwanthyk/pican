<script lang="ts">
  import { t } from '../../../shared/strings.js';
  let { showModels = true, showThinking = true, showCommands = true, showFiles = true } = $props();
</script>

{#if showModels}<div id="pi-chat-model-popup" class="pi-chat-model-popup" style="display: none">
    <input
      type="text"
      id="pi-chat-model-search"
      class="pi-chat-model-search"
      placeholder={t('composer.searchModels')}
      autocomplete="off"
    />
    <div id="pi-chat-model-list" class="pi-chat-model-list"></div>
  </div>{/if}
{#if showThinking}<div
    id="pi-chat-thinking-popup"
    class="pi-chat-thinking-popup"
    style="display: none"
  >
    <div id="pi-chat-thinking-list" class="pi-chat-thinking-list"></div>
  </div>{/if}
{#if showCommands}<div id="pi-chat-slash-popup" class="pi-chat-slash-popup" style="display: none">
    <div id="pi-chat-slash-list" class="pi-chat-slash-list"></div>
  </div>{/if}
{#if showFiles}<div id="pi-chat-mention-popup" class="pi-chat-slash-popup" style="display: none">
    <div id="pi-chat-mention-list" class="pi-chat-slash-list"></div>
  </div>{/if}
