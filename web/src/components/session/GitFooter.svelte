<script lang="ts">
  import { onMount } from 'svelte';
  import { icon, ChevronDown, ExternalLink } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import * as Http from '../../lib/http.js';
  import { describeError } from '../../lib/errors.js';
  import { GitInfoSchema, GitRenameResponseSchema, type GitInfo } from '../../lib/schema.js';
  import { runPromise } from '../../lib/runtime.js';

  // Prompt text the split button injects into the composer for each git action.
  const DRAFT_PR_PROMPT =
    'Commit any uncommitted changes on this branch with a clear message, push ' +
    'the branch to the remote, then open a draft pull request with ' +
    '`gh pr create --draft`. Review the diff first (`git status`, `git diff`, ' +
    '`git log`) and write a clear PR title, a description summarizing what ' +
    'changed and why, and a short test plan.';

  const MERGE_PR_PROMPT =
    'Merge the pull request for this branch once its checks are green: run ' +
    '`gh pr merge` (use a squash merge unless the project prefers otherwise) and ' +
    'delete the branch after merging.';

  // The branch indicator + smart git action control beneath the chat composer.
  // gitApi is injectable for tests.
  interface GitApi {
    readonly getGitInfo: (sessionId: string) => Promise<GitInfo>;
    readonly renameBranch: (sessionId: string, name: string) => Promise<unknown>;
  }

  const defaultGitApi: GitApi = {
    getGitInfo: (id) =>
      runPromise(Http.get(`/api/git/info?id=${encodeURIComponent(id)}`, GitInfoSchema)),
    renameBranch: (id, name) =>
      runPromise(
        Http.post(
          `/api/git/rename-branch?id=${encodeURIComponent(id)}`,
          { name },
          GitRenameResponseSchema,
        ),
      ),
  };

  let { sessionId = '', gitApi }: { sessionId?: string; gitApi?: Partial<GitApi> } = $props();
  const api = $derived<GitApi>({ ...defaultGitApi, ...gitApi });

  onMount(() => {
    const documentImpl = document;
    const windowImpl = window;
    const barNode = documentImpl.getElementById('pi-git-bar');
    if (!barNode) return;
    const bar = barNode;

    const cleanups: Array<() => void> = [];
    const on = (
      host: EventTarget,
      type: string,
      handler: EventListener,
      opts?: boolean | AddEventListenerOptions,
    ): void => {
      host.addEventListener(type, handler, opts);
      cleanups.push(() => host.removeEventListener(type, handler, opts));
    };

    const branchWrap = documentImpl.getElementById('pi-git-branch');
    const nameEl = documentImpl.getElementById('pi-git-branch-name');
    const editBtn = documentImpl.getElementById('pi-git-branch-edit');
    const input = documentImpl.querySelector<HTMLInputElement>('#pi-git-branch-input');
    const prWrap = documentImpl.getElementById('pi-git-pr');
    const primaryBtn = documentImpl.getElementById('pi-git-primary');
    const primaryLabel = documentImpl.getElementById('pi-git-primary-label');
    const caretBtn = documentImpl.getElementById('pi-git-caret');
    const prMenu = documentImpl.getElementById('pi-git-pr-menu');
    const items = {
      view: documentImpl.getElementById('pi-git-pr-view'),
      draft: documentImpl.getElementById('pi-git-pr-draft'),
      manual: documentImpl.getElementById('pi-git-pr-manual'),
      merge: documentImpl.getElementById('pi-git-pr-merge'),
    };

    let currentBranch = '';
    let prCreateUrl = '';
    let existingPrUrl = '';
    let primaryAction = () => {};

    const show = (el: HTMLElement | null, visible: boolean): void => {
      if (el) el.hidden = !visible;
    };

    function insertPrompt(text: string): void {
      const textarea = documentImpl.querySelector<HTMLTextAreaElement>('#pi-chat-message');
      if (!textarea) return;
      textarea.value = text;
      const EventCtor = windowImpl.Event || (typeof Event !== 'undefined' ? Event : null);
      if (EventCtor) textarea.dispatchEvent(new EventCtor('input', { bubbles: true }));
      if (typeof textarea.focus === 'function') textarea.focus();
    }
    function openUrl(url: string): void {
      if (url && typeof windowImpl.open === 'function') windowImpl.open(url, '_blank', 'noopener');
    }

    // Each action is { label, run, external? }. `external` actions open a URL in
    // a new tab, so their label gets a trailing external-link icon. The plan
    // picks one primary plus a list of secondary actions shown under the caret.
    type ActionKey = 'draft' | 'manual' | 'view' | 'merge';
    interface GitAction {
      readonly label: string;
      readonly external?: boolean;
      readonly run: () => void;
    }
    const ACTIONS: Readonly<Record<ActionKey, GitAction>> = {
      draft: { label: t('git.createPr'), run: () => insertPrompt(DRAFT_PR_PROMPT) },
      manual: { label: t('git.createPrManually'), external: true, run: () => openUrl(prCreateUrl) },
      view: { label: t('git.viewPr'), external: true, run: () => openUrl(existingPrUrl) },
      merge: { label: t('git.mergePr'), run: () => insertPrompt(MERGE_PR_PROMPT) },
    };

    // Decide the primary action + secondary list from the current git state.
    // On the default branch there is no PR flow, so no action control at all.
    function planActions({
      isDefault,
      hasPr,
    }: {
      readonly isDefault: boolean;
      readonly hasPr: boolean;
    }): { readonly primary: ActionKey | null; readonly secondary: ActionKey[] } {
      if (isDefault) {
        return { primary: null, secondary: [] };
      }
      if (!hasPr) {
        return { primary: 'draft', secondary: ['manual'] };
      }
      return { primary: 'view', secondary: ['merge'] };
    }

    function applyInfo(info: GitInfo): void {
      if (!info || !info.isRepo || !info.branch) {
        // Not a git repo: nothing to show, hide the whole bar.
        show(branchWrap, false);
        show(prWrap, false);
        bar.hidden = true;
        return;
      }
      show(branchWrap, true);
      currentBranch = info.branch;
      prCreateUrl = info.prCreateUrl || '';
      existingPrUrl = info.prUrl || '';
      if (nameEl) nameEl.textContent = info.branch;
      if (items.manual) items.manual.title = prCreateUrl ? prCreateUrl : t('git.noRemote');

      const isDefault = !!info.isDefault;
      const hasPr = !isDefault && !!existingPrUrl;

      show(editBtn, !isDefault);

      const plan = planActions({ isDefault, hasPr });
      const primary = plan.primary ? ACTIONS[plan.primary] : null;
      if (primary) {
        if (primaryLabel) {
          primaryLabel.textContent = primary.label;
          if (primary.external) primaryLabel.innerHTML += ' ' + icon(ExternalLink, { size: 12 });
        }
        primaryAction = primary.run;
      } else {
        primaryAction = () => {};
      }
      show(primaryBtn, !!primary);

      const secondary = new Set(plan.secondary);
      const actionKeys: ReadonlyArray<ActionKey> = ['view', 'draft', 'manual', 'merge'];
      actionKeys.forEach((key) => show(items[key], secondary.has(key)));
      show(caretBtn, plan.secondary.length > 0);
      if (plan.secondary.length === 0) setMenuOpen(false);

      show(prWrap, !!primary || plan.secondary.length > 0);
      bar.hidden = false;
    }

    function refresh(): Promise<void> {
      return api.getGitInfo(sessionId).then(applyInfo, () => undefined);
    }

    // ── Branch rename ──
    function openEditor(): void {
      if (!input) return;
      input.value = currentBranch;
      input.hidden = false;
      if (nameEl) nameEl.hidden = true;
      if (editBtn) editBtn.hidden = true;
      input.focus();
      input.select();
    }
    function closeEditor(): void {
      if (!input) return;
      input.hidden = true;
      if (nameEl) nameEl.hidden = false;
      if (editBtn) editBtn.hidden = false;
    }
    function commitRename(): void {
      const next = (input ? input.value : '').trim();
      if (!next || next === currentBranch) {
        closeEditor();
        return;
      }
      void api.renameBranch(sessionId, next).then(
        () => {
          closeEditor();
          return refresh();
        },
        (error: unknown) => {
          if (input) {
            input.title = describeError(error);
            input.focus();
            input.select();
          }
        },
      );
    }

    if (editBtn) {
      on(editBtn, 'click', (e: Event) => {
        e.preventDefault();
        openEditor();
      });
    }
    if (input) {
      on(input, 'keydown', (e: Event) => {
        if (!(e instanceof KeyboardEvent)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeEditor();
        }
      });
      on(input, 'blur', () => closeEditor());
    }

    // ── Split button ──
    function setMenuOpen(open: boolean): void {
      if (!prMenu || !caretBtn) return;
      prMenu.hidden = !open;
      caretBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (primaryBtn) {
      on(primaryBtn, 'click', (e: Event) => {
        e.preventDefault();
        setMenuOpen(false);
        primaryAction();
      });
    }
    if (caretBtn) {
      on(caretBtn, 'click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(prMenu ? prMenu.hidden : false);
      });
    }
    on(documentImpl, 'click', (e: Event) => {
      if (
        prMenu &&
        !prMenu.hidden &&
        prWrap &&
        e.target instanceof Node &&
        !prWrap.contains(e.target)
      )
        setMenuOpen(false);
    });

    const itemKeys: ReadonlyArray<ActionKey> = ['view', 'draft', 'manual', 'merge'];
    itemKeys.forEach((key) => {
      const el = items[key];
      if (!el) return;
      on(el, 'click', (e: Event) => {
        e.preventDefault();
        setMenuOpen(false);
        ACTIONS[key].run();
      });
    });

    void refresh();

    return () => {
      for (const fn of cleanups) fn();
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div class="pi-git-bar" id="pi-git-bar">
  <div class="pi-git-branch" id="pi-git-branch" hidden>
    <span class="pi-git-branch-name" id="pi-git-branch-name" title={t('git.currentBranch')}
    ></span><button
      type="button"
      class="pi-git-edit"
      id="pi-git-branch-edit"
      title={t('git.renameBranch')}
      aria-label={t('git.renameBranch')}
    ></button><input
      type="text"
      class="pi-git-branch-input"
      id="pi-git-branch-input"
      autocomplete="off"
      spellcheck="false"
      aria-label={t('git.newBranchName')}
      hidden
    />
  </div>
  <div class="pi-git-right">
    <div class="pi-git-pr" id="pi-git-pr" hidden>
      <button type="button" class="pi-git-pr-button pi-git-primary" id="pi-git-primary"
        ><span id="pi-git-primary-label">{t('git.createPr')}</span></button
      ><button
        type="button"
        class="pi-git-pr-button pi-git-caret"
        id="pi-git-caret"
        aria-haspopup="true"
        aria-expanded="false"
        aria-label={t('git.moreActions')}>{@html icon(ChevronDown, { size: 12 })}</button
      >
      <div class="pi-git-pr-menu" id="pi-git-pr-menu" role="menu" hidden>
        <button type="button" class="pi-git-pr-item" id="pi-git-pr-view" role="menuitem" hidden
          >{t('git.viewPr')} {@html icon(ExternalLink, { size: 12 })}</button
        ><button type="button" class="pi-git-pr-item" id="pi-git-pr-draft" role="menuitem" hidden
          >{t('git.createDraftPr')}</button
        ><button type="button" class="pi-git-pr-item" id="pi-git-pr-manual" role="menuitem"
          >{t('git.createPrManually')} {@html icon(ExternalLink, { size: 12 })}</button
        ><button type="button" class="pi-git-pr-item" id="pi-git-pr-merge" role="menuitem" hidden
          >{t('git.mergePr')}</button
        >
      </div>
    </div>
  </div>
</div>
