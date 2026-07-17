export function setupAskQuestionHandlers({
  documentImpl = document,
  sendChatMessage = async () => false,
} = {}) {
  const onClick = async (event) => {
    const submitBtn = event.target.closest?.('.ask-question-submit-btn');
    if (submitBtn) {
      event.preventDefault();
      const card = submitBtn.closest('.ask-question-card');
      if (!card) return;
      const parts = [];
      card.querySelectorAll('.ask-question-block').forEach((block) => {
        const questionText = block.dataset.questionText || '';
        const answers = Array.from(block.querySelectorAll('.ask-question-option-action.selected'))
          .map((el) => el.dataset.answer || '')
          .filter(Boolean);
        if (answers.length && questionText)
          parts.push(`"${questionText}" = "${answers.join(', ')}"`);
      });
      if (parts.length === 0) return;
      card.querySelectorAll('.ask-question-option-action').forEach((button) => {
        button.disabled = true;
      });
      submitBtn.disabled = true;
      const sent = await sendChatMessage(parts.join('\n'), []);
      if (!sent) {
        card.querySelectorAll('.ask-question-option-action').forEach((button) => {
          button.disabled = false;
        });
        submitBtn.disabled = false;
      }
      return;
    }

    const option = event.target.closest?.('.ask-question-option-action');
    if (!option) return;
    event.preventDefault();

    const card = option.closest('.ask-question-card');
    const block = option.closest('.ask-question-block');
    const needsSubmit = card?.dataset.needsSubmit === 'true';

    if (!needsSubmit) {
      const question = option.dataset.question || 'Question';
      const answer = option.dataset.answer || option.textContent.trim();
      option.disabled = true;
      const sent = await sendChatMessage(`"${question}" = "${answer}"`, []);
      if (!sent) option.disabled = false;
      return;
    }

    if (block) {
      if (block.dataset.multiSelect === 'true') {
        option.classList.toggle('selected');
      } else {
        block
          .querySelectorAll('.ask-question-option-action')
          .forEach((button) => button.classList.remove('selected'));
        option.classList.add('selected');
      }
    }
    const actions = card?.querySelector('.ask-question-actions');
    if (actions) actions.style.display = '';
  };

  documentImpl.addEventListener('click', onClick);
  return {
    dispose: () => documentImpl.removeEventListener('click', onClick),
    onClick,
  };
}
