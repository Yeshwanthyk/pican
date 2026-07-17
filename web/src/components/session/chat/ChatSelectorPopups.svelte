<script>
  import { t } from '../../../shared/i18n.js';
</script>

<div id="pi-chat-model-popup" class="pi-chat-model-popup" style="display: none">
  <input
    type="text"
    id="pi-chat-model-search"
    class="pi-chat-model-search"
    placeholder={t('composer.searchModels')}
    autocomplete="off"
  />
  <div id="pi-chat-model-list" class="pi-chat-model-list"></div>
</div>
<div id="pi-chat-thinking-popup" class="pi-chat-thinking-popup" style="display: none">
  <div id="pi-chat-thinking-list" class="pi-chat-thinking-list"></div>
</div>
<div id="pi-chat-slash-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-slash-list" class="pi-chat-slash-list"></div>
</div>
<div id="pi-chat-mention-popup" class="pi-chat-slash-popup" style="display: none">
  <div id="pi-chat-mention-list" class="pi-chat-slash-list"></div>
</div>
