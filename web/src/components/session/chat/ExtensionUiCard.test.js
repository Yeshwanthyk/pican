import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import ExtensionUiCard from './ExtensionUiCard.svelte';

afterEach(cleanup);

function setup(request) {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
  const view = render(ExtensionUiCard, { props: { request, sessionId: 's1', fetchImpl } });
  return { ...view, fetchImpl };
}

function sentBody(fetchImpl) {
  return JSON.parse(fetchImpl.mock.calls[0][1].body);
}

describe('ExtensionUiCard', () => {
  it('submits confirm and cancel as booleans', async () => {
    const { getByText, fetchImpl } = setup({
      id: 'c1',
      method: 'confirm',
      title: 'Deploy?',
      message: 'Ship it',
    });
    expect(getByText('Ship it')).toBeTruthy();
    await fireEvent.click(getByText('Cancel'));
    expect(sentBody(fetchImpl)).toEqual({ session: 's1', id: 'c1', confirmed: false });
  });

  it('submits the selected option', async () => {
    const { getByText, fetchImpl } = setup({
      id: 's1',
      method: 'select',
      title: 'Choose',
      options: ['One', 'Two'],
    });
    await fireEvent.click(getByText('Two'));
    expect(sentBody(fetchImpl).value).toBe('Two');
  });

  it('submits single-line input', async () => {
    const { getByPlaceholderText, getByText, fetchImpl } = setup({
      id: 'i1',
      method: 'input',
      title: 'Name',
      placeholder: 'Ada',
    });
    await fireEvent.input(getByPlaceholderText('Ada'), { target: { value: 'Grace' } });
    await fireEvent.click(getByText('Send'));
    expect(sentBody(fetchImpl).value).toBe('Grace');
  });

  it('prefills and submits editor text', async () => {
    const { container, getByText, fetchImpl } = setup({
      id: 'e1',
      method: 'editor',
      title: 'Edit',
      prefill: 'draft',
    });
    expect(container.querySelector('textarea').value).toBe('draft');
    await fireEvent.click(getByText('Send'));
    expect(sentBody(fetchImpl).value).toBe('draft');
  });
});
