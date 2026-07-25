<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import SessionsPage from './routes/SessionsPage.svelte';
  import SessionPage from './routes/SessionPage.svelte';
  import SettingsPage from './routes/SettingsPage.svelte';
  import SchedulesPage from './routes/SchedulesPage.svelte';
  import WorkflowsPage from './routes/WorkflowsPage.svelte';
  import TasksPage from './routes/TasksPage.svelte';
  import SubagentsPage from './routes/SubagentsPage.svelte';
  import NotFoundPage from './routes/NotFoundPage.svelte';
  import VersionController from './components/shared/VersionController.svelte';

  interface AppProps {
    readonly path?: string;
    readonly search?: string;
  }

  let {
    path: initialPath = typeof window !== 'undefined' ? window.location.pathname : '/',
    search: initialSearch = typeof window !== 'undefined' ? window.location.search : '',
  }: AppProps = $props();

  // Reactive current route. Seeded from the props (so prop-driven tests stay
  // deterministic) and thereafter updated only by real navigation events, never
  // re-read on mount.
  let path = $state(untrack(() => initialPath));
  let search = $state(untrack(() => initialSearch));

  // The session route is keyed on this so a session→session navigation (same
  // pathname, different ?id=) tears down and remounts <SessionPage>, which reads
  // ?id= only at mount. Within-session navigation never changes the URL, so this
  // stays stable while reading a session.
  const sessionId = $derived(new URLSearchParams(search).get('id') || '');
  const homeProject = $derived(new URLSearchParams(search).get('project') || '');
  const homeView = $derived.by(() => {
    const value = new URLSearchParams(search).get('view');
    return value === 'all' || value === 'archived' ? value : 'home';
  });
  const homeNavigationKey = $derived(homeProject ? `project:${homeProject}` : `view:${homeView}`);
  const workflowRunId = $derived(new URLSearchParams(search).get('runId') || '');
  const workflowSession = $derived(new URLSearchParams(search).get('session') || '');
  const tasksProject = $derived(new URLSearchParams(search).get('project') || '');
  const tasksSession = $derived(new URLSearchParams(search).get('session') || '');
  const subagentsSession = $derived(new URLSearchParams(search).get('session') || '');

  // Make in-app history navigation swap views without a full reload. popstate
  // covers back/forward; pushState/replaceState don't emit a native event, so
  // we wrap them to dispatch one. syncPath re-reads pathname + search: the
  // pathname drives which page renders, and search drives the session-route
  // {#key} so /session?id=A → ?id=B remounts <SessionPage>. A pushState that
  // changes neither (e.g. FullScreenSheet's mobile back-button trap, which
  // pushes the same URL) is a no-op.
  onMount(() => {
    const syncPath = () => {
      path = window.location.pathname;
      search = window.location.search;
    };
    const { history } = window;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const emitLocationChange = () => {
      window.dispatchEvent(new window.CustomEvent('pican:locationchange'));
    };
    const patchedPush: History['pushState'] = (data, unused, url) => {
      originalPush.call(history, data, unused, url);
      emitLocationChange();
    };
    const patchedReplace: History['replaceState'] = (data, unused, url) => {
      originalReplace.call(history, data, unused, url);
      emitLocationChange();
    };
    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
    window.addEventListener('popstate', syncPath);
    window.addEventListener('pican:locationchange', syncPath);
    return () => {
      window.removeEventListener('popstate', syncPath);
      window.removeEventListener('pican:locationchange', syncPath);
      if (history.pushState === patchedPush) history.pushState = originalPush;
      if (history.replaceState === patchedReplace) history.replaceState = originalReplace;
    };
  });
</script>

{#if path === '/'}
  {#key homeNavigationKey}
    <SessionsPage view={homeView} project={homeProject} />
  {/key}
{:else if path === '/session'}
  {#key sessionId}
    <SessionPage />
  {/key}
{:else if path === '/settings'}
  <SettingsPage />
{:else if path === '/schedules'}
  <SchedulesPage />
{:else if path === '/workflows'}
  <WorkflowsPage runId={workflowRunId} session={workflowSession} />
{:else if path === '/tasks'}
  <TasksPage project={tasksProject} session={tasksSession} />
{:else if path === '/subagents'}
  <SubagentsPage session={subagentsSession} />
{:else}
  <NotFoundPage />
{/if}

<VersionController />
