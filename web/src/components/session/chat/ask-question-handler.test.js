import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupAskQuestionHandlers } from './ask-question-handler.js';

let cleanups = [];

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  document.body.innerHTML = '';
});

function setup(opts) {
  const controller = setupAskQuestionHandlers(opts);
  cleanups.push(() => controller.dispose());
  return controller;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('setupAskQuestionHandlers', () => {
  it('sends a single answer immediately when no submit is required', async () => {
    document.body.innerHTML = `
      <div class="ask-question-card" data-needs-submit="false">
        <button class="ask-question-option-action" data-question="Pick one" data-answer="A">A</button>
      </div>
    `;
    const sendChatMessage = vi.fn(() => Promise.resolve(true));
    setup({ documentImpl: document, sendChatMessage });

    document.querySelector('.ask-question-option-action').click();
    await tick();

    expect(sendChatMessage).toHaveBeenCalledWith('"Pick one" = "A"', []);
    expect(document.querySelector('.ask-question-option-action').disabled).toBe(true);
  });

  it('re-enables an immediate answer when send fails', async () => {
    document.body.innerHTML = `
      <div class="ask-question-card" data-needs-submit="false">
        <button class="ask-question-option-action" data-question="Pick one" data-answer="A">A</button>
      </div>
    `;
    setup({ documentImpl: document, sendChatMessage: vi.fn(() => Promise.resolve(false)) });

    const option = document.querySelector('.ask-question-option-action');
    option.click();
    await tick();

    expect(option.disabled).toBe(false);
  });

  it('collects multi-select answers and submits them together', async () => {
    document.body.innerHTML = `
      <div class="ask-question-card" data-needs-submit="true">
        <div class="ask-question-block" data-question-text="Pick many" data-multi-select="true">
          <button class="ask-question-option-action" data-answer="A">A</button>
          <button class="ask-question-option-action" data-answer="B">B</button>
        </div>
        <div class="ask-question-actions" style="display:none">
          <button class="ask-question-submit-btn">Send answers</button>
        </div>
      </div>
    `;
    const sendChatMessage = vi.fn(() => Promise.resolve(true));
    setup({ documentImpl: document, sendChatMessage });

    const options = document.querySelectorAll('.ask-question-option-action');
    options[0].click();
    options[1].click();
    expect(document.querySelector('.ask-question-actions').style.display).toBe('');
    document.querySelector('.ask-question-submit-btn').click();
    await tick();

    expect(sendChatMessage).toHaveBeenCalledWith('"Pick many" = "A, B"', []);
    expect(options[0].disabled).toBe(true);
    expect(options[1].disabled).toBe(true);
  });

  it('keeps one selected option per single-select block before submit', () => {
    document.body.innerHTML = `
      <div class="ask-question-card" data-needs-submit="true">
        <div class="ask-question-block" data-question-text="Pick one" data-multi-select="false">
          <button class="ask-question-option-action" data-answer="A">A</button>
          <button class="ask-question-option-action" data-answer="B">B</button>
        </div>
        <div class="ask-question-actions" style="display:none"></div>
      </div>
    `;
    setup({ documentImpl: document, sendChatMessage: vi.fn() });

    const options = document.querySelectorAll('.ask-question-option-action');
    options[0].click();
    options[1].click();

    expect(options[0].classList.contains('selected')).toBe(false);
    expect(options[1].classList.contains('selected')).toBe(true);
  });
});
