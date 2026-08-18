package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pican/internal/auth"
	"pican/internal/basepath"
	"pican/internal/claude"
	"pican/internal/codex"
	"pican/internal/frontend"
	"pican/internal/opencode"
	"pican/internal/runtimes"
	"pican/internal/server"
	"pican/internal/sessions"
	"pican/internal/ui"
	"pican/internal/updater"
	"pican/internal/workers"
	"pican/internal/workspace"
	"pican/web"
)

const defaultPort = "31415"
const tokenEnvVar = "PICAN_TOKEN"

// Run starts pican and owns every resource created during startup. It returns
// after ctx is canceled or the HTTP server fails.
func Run(ctx context.Context, config Config) error {
	if ctx.Err() != nil {
		return nil
	}
	ctx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	config = config.withDefaults()
	if err := config.validate(); err != nil {
		return err
	}
	var hostedWorkspace *workspace.Resolver
	if config.Mode == ModeHosted {
		workspaceResolver, err := workspace.New(config.WorkspaceRoot)
		if err != nil {
			return fmt.Errorf("configure hosted workspace: %w", err)
		}
		hostedWorkspace = workspaceResolver
		config.WorkspaceRoot = workspaceResolver.Root()
		stateRoot, err := workspaceResolver.CreateDir(config.StateRoot, 0o755)
		if err != nil {
			return fmt.Errorf("configure hosted state root: %w", err)
		}
		config.StateRoot = stateRoot
		config.ChildEnv = hostedCodexChildEnv(config.ChildEnv)
		// Scotty owns the browser-facing route and runtime lifecycle. Hosted
		// pican never publishes a parallel Tailscale endpoint or opens its
		// internal listener in a local browser.
		config.HostExplicit = true
		config.OpenBrowser = false
	}
	cleanups := cleanupStack{}
	defer cleanups.close()

	host, port, err := net.SplitHostPort(config.ListenAddress)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", config.ListenAddress, err)
	}
	codexPath := codexExecutable(config.CodexCommand)
	codexArgv := codexCommand(codexPath)
	childEnv := make([]string, len(config.ChildEnv))
	copy(childEnv, config.ChildEnv)
	codexProcess := codex.ProcessOptions{Env: childEnv}
	if config.Mode == ModeHosted {
		codexProcess.Dir = config.WorkspaceRoot
	}
	runtimeCandidates := []runtimeCandidate{{id: runtimes.CodexID, command: codexPath}}
	claudePath, openCodePath := "", ""
	if config.Mode == ModeStandalone {
		claudePath = claude.ResolveCommand(config.ClaudeCommand)
		openCodePath = openCodeExecutable(config.OpenCodeCommand)
		runtimeCandidates = []runtimeCandidate{
			{id: runtimes.PiID, command: "pi"},
			{id: runtimes.CodexID, command: codexPath},
			{id: runtimes.ClaudeID, command: claudePath},
			{id: runtimes.OpenCodeID, command: openCodePath},
		}
	}
	runtimeSelection, err := discoverRuntimeSelection(config.Runtime, runtimeCandidates)
	if err != nil {
		return err
	}

	agentDir := config.StateRoot
	sessionsDir := filepath.Join(agentDir, "sessions")

	var srv *server.Server
	currentServer := func() *server.Server { return srv }
	var catalogCWDResolver func(string) (string, error)
	if hostedWorkspace != nil {
		catalogCWDResolver = hostedWorkspace.ResolveExisting
	}
	codexCatalogSyncer := newCatalogSyncer("Codex", configuredCodexCatalog(sessionsDir, codexArgv, codexProcess, catalogCWDResolver), 10*time.Minute, time.Minute)
	codexProbe := codex.NewProbeWithOptions(codexPath, 30*time.Second, codexProcess)
	if runtimeSelectionIncludes(runtimeSelection, runtimes.CodexID) {
		probeCtx, probeCancel := context.WithTimeout(ctx, 3*time.Second)
		_ = codexProbe.Refresh(probeCtx)
		probeCancel()
	}
	var claudeHome string
	var claudeCatalog *claude.Catalog
	var claudeCatalogSyncer *catalogSyncer
	var claudeProbe *claude.Probe
	var openCodeSupervisor *opencode.Supervisor
	var openCodeService *opencode.Service
	var openCodeCatalog *opencode.Catalog
	var openCodeCatalogSyncer *catalogSyncer
	var openCodeSeed string
	var openCodeAvailability func(context.Context) runtimes.Availability
	openCodeClient := func() (opencode.NativeClient, error) {
		if openCodeSupervisor == nil {
			return nil, opencode.ErrSupervisorNotReady
		}
		return openCodeSupervisor.Client()
	}

	if config.Mode == ModeStandalone {
		claudeHome, err = claude.ResolveHome(config.ClaudeHome)
		if err != nil {
			return fmt.Errorf("resolve Claude home: %w", err)
		}
		claudeCatalog, err = claude.NewCatalog(claudeHome, sessionsDir)
		if err != nil {
			return fmt.Errorf("initialize Claude catalog: %w", err)
		}
		claudeCatalogSyncer = newCatalogSyncer("Claude", claudeCatalog.Sync, 15*time.Second, 10*time.Minute)
		claudeProbe = claude.NewProbe(claudePath, claudeHome, 30*time.Second)
		if runtimeSelectionIncludes(runtimeSelection, runtimes.ClaudeID) {
			probeCtx, probeCancel := context.WithTimeout(ctx, 3*time.Second)
			_ = claudeProbe.Refresh(probeCtx)
			probeCancel()
		}

		openCodeSeed, err = os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve OpenCode seed directory: %w", err)
		}
		openCodeService, err = opencode.NewService(sessionsDir, openCodeSeed, openCodeClient)
		if err != nil {
			return fmt.Errorf("initialize OpenCode service: %w", err)
		}
		openCodeCatalog = openCodeService.Catalog()
		openCodeEvents, eventsErr := opencode.NewCatalogEvents(openCodeCatalog, 100*time.Millisecond, opencode.CatalogEventCallbacks{
			Projection: func(projection opencode.Projection) {
				if live := currentServer(); live != nil {
					live.NotifyWorkerUpdate(projection.ID, true)
				}
			},
			Error: func(eventErr error) {
				fmt.Fprintf(os.Stderr, "OpenCode event reconciliation: %v\n", eventErr)
			},
		})
		if eventsErr != nil {
			return fmt.Errorf("initialize OpenCode event reconciliation: %w", eventsErr)
		}
		cleanups.add(openCodeEvents.Close)
		openCodeSupervisor = opencode.NewSupervisor(opencode.Options{
			Command: openCodePath,
			Dir:     openCodeSeed,
			Reconcile: func(ctx context.Context, client *opencode.Client) error {
				result, syncErr := openCodeCatalog.SyncWithClient(ctx, client)
				if errors.Is(syncErr, opencode.ErrPartialCatalog) {
					fmt.Fprintf(os.Stderr, "OpenCode catalog is partial; healthy sessions remain available and pruning is disabled: %v\n", syncErr)
					return nil
				}
				if syncErr != nil {
					return syncErr
				}
				if !result.Complete {
					return fmt.Errorf("OpenCode catalog reconciliation was incomplete")
				}
				return nil
			},
			Event: openCodeEvents.HandleEvent,
		})
		cleanups.add(func() { _ = openCodeSupervisor.Close() })
		openCodeCatalogSyncer = newCatalogSyncer("OpenCode", openCodeCatalog.Sync, 30*time.Second, time.Minute)
		openCodeAvailability = func(context.Context) runtimes.Availability {
			ready := openCodeSupervisor.Ready()
			reason := ""
			if ready.Err != nil {
				reason = "OpenCode runtime is unavailable: " + ready.Err.Error()
			} else if !ready.Available {
				reason = "OpenCode runtime is not started"
			}
			return runtimes.Availability{Available: ready.Available, Reason: reason}
		}
	}
	buildRegistry := func(openCodeVersion string) (*runtimeRegistry, error) {
		codexRuntime := applicationRuntime{
			registration: runtimes.Codex(runtimes.BuiltinOptions{
				Command:           codexPath,
				Version:           codexProbe.Version(),
				AvailabilityProbe: codexProbe.Availability,
				Catalog:           codexCatalogSyncer,
				WorkerFactory:     configuredCodexWorkerFactory(ctx, sessionsDir, codexArgv, currentServer, codexProcess),
			}),
			models: configuredCodexModels(codexArgv, codexProcess),
		}
		if config.Mode == ModeHosted {
			return newRuntimeRegistry(codexRuntime)
		}
		return newRuntimeRegistry(
			applicationRuntime{
				registration: runtimes.Pi(runtimes.BuiltinOptions{
					Command:           "pi",
					AvailabilityProbe: func(context.Context) runtimes.Availability { return runtimes.Availability{Available: true} },
					WorkerFactory:     piWorkerFactory(currentServer),
				}),
				models: piModels,
			},
			codexRuntime,
			applicationRuntime{
				registration: runtimes.Claude(runtimes.BuiltinOptions{
					Command:           claudePath,
					Version:           claudeProbe.Version(),
					AvailabilityProbe: claudeProbe.Availability,
					Catalog:           claudeCatalogSyncer,
					WorkerFactory:     claudeWorkerFactory(claudePath, claudeHome, claudeCatalog, currentServer),
				}),
				models: claudeModels,
			},
			applicationRuntime{
				registration: runtimes.OpenCode(runtimes.BuiltinOptions{
					Command:           openCodePath,
					Version:           openCodeVersion,
					AvailabilityProbe: openCodeAvailability,
					Catalog:           openCodeCatalogSyncer,
					WorkerFactory:     openCodeWorkerFactory(openCodeSupervisor, openCodeService, currentServer),
				}),
				models: openCodeModels(openCodeSupervisor, openCodeSeed),
			},
		)
	}
	registry, err := buildRegistry("")
	if err != nil {
		return fmt.Errorf("initialize runtime registry: %w", err)
	}
	enabledRuntimes, err := parseRuntime(runtimeSelection, registry)
	if err != nil {
		return err
	}
	if config.Mode == ModeHosted && !enabledRuntimes.only(runtimes.CodexID) {
		return fmt.Errorf("hosted mode supports only the Codex runtime; selected %s", strings.Join(enabledRuntimes.enabledRuntimes(), ","))
	}
	if _, statErr := os.Stat(sessionsDir); os.IsNotExist(statErr) {
		if !enabledRuntimes.requiresExistingSessionsDir() {
			if mkdirErr := os.MkdirAll(sessionsDir, 0755); mkdirErr != nil {
				return fmt.Errorf("create sessions directory: %w", mkdirErr)
			}
		} else {
			return fmt.Errorf("sessions directory not found: %s", sessionsDir)
		}
	}

	bindHost := host
	token := config.AuthToken
	tokenRequired := token == "" && !isLoopbackHost(bindHost) && !config.Insecure
	if tokenRequired {
		return fmt.Errorf(
			"refusing to bind %s without %s set: anyone reachable on this address could view sessions and drive pi.\n"+
				"  set %s=$(openssl rand -hex 16) to require a token, or pass --insecure to override.\n",
			bindHost, tokenEnvVar, tokenEnvVar)
	}

	openCodeVersion := ""
	if enabledRuntimes.enables(string(runtimes.OpenCodeID)) {
		startCtx, startCancel := context.WithTimeout(ctx, 60*time.Second)
		startErr := openCodeSupervisor.Start(startCtx)
		startCancel()
		if startErr != nil {
			if enabledRuntimes.only(runtimes.OpenCodeID) {
				return fmt.Errorf("OpenCode runtime unavailable: %w", startErr)
			}
			fmt.Fprintf(os.Stderr, "OpenCode unavailable; continuing with %s: %v\n", enabledRuntimes.labelsExcept(runtimes.OpenCodeID), startErr)
		} else {
			openCodeVersion = openCodeSupervisor.Ready().Version
		}
	}
	registry, err = buildRegistry(openCodeVersion)
	if err != nil {
		return fmt.Errorf("initialize enabled runtime registry: %w", err)
	}
	enabledRuntimes, err = parseRuntime(runtimeSelection, registry)
	if err != nil {
		return err
	}
	enabledRegistry, err := enabledRuntimes.selectedRegistry()
	if err != nil {
		return fmt.Errorf("resolve enabled runtimes: %w", err)
	}

	for _, runtimeID := range enabledRuntimes.ordered {
		registration, _ := registry.registry.Lookup(runtimeID)
		if registration.Catalog == nil {
			continue
		}
		if runtimeID == runtimes.OpenCodeID {
			openCodeCatalogSyncer.start(false)
			cleanups.add(openCodeCatalogSyncer.close)
			continue
		}
		startupCtx, startupCancel := context.WithTimeout(ctx, 15*time.Second)
		_, syncErr := registration.Catalog.Sync(startupCtx)
		startupCancel()
		if syncErr != nil {
			fmt.Fprintf(os.Stderr, "%s catalog reconciliation deferred: %v\n", registration.Descriptor.Label, syncErr)
		}
		if syncer, ok := registration.Catalog.(*catalogSyncer); ok {
			syncer.start(syncErr != nil)
			cleanups.add(syncer.close)
		}
	}

	var claudeWatcher *claude.Watcher
	if enabledRuntimes.enables(string(runtimes.ClaudeID)) {
		claudeWatcher, err = claudeCatalog.Watch(100*time.Millisecond, func(err error) {
			fmt.Fprintf(os.Stderr, "Claude transcript watcher: %v\n", err)
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "Claude transcript watcher unavailable; periodic sync remains active: %v\n", err)
		} else {
			cleanups.add(func() { _ = claudeWatcher.Close() })
		}
	}

	var authMiddleware *auth.Middleware
	if config.AuthMode == AuthModeProxy {
		authMiddleware, err = auth.NewProxyOnly(config.ProxyAuthHeader, token)
		if err != nil {
			return fmt.Errorf("configure proxy authentication: %w", err)
		}
	} else {
		authMiddleware = auth.New(token)
	}

	versionChecker := updater.New(config.Version)

	manager := workers.NewManager(func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		parsed, err := sessions.ParseFile(sessionPath, filepath.Base(filepath.Dir(sessionPath)), filepath.Base(sessionPath))
		if err != nil {
			return nil, fmt.Errorf("read session runtime: %w", err)
		}
		runtimeID := parsed.Runtime
		if runtimeID == "" {
			runtimeID = string(runtimes.PiID)
		}
		if !enabledRuntimes.enables(runtimeID) {
			return nil, fmt.Errorf("%s runtime is not enabled", runtimeID)
		}
		return enabledRegistry.NewWorker(runtimeID, sessionID, sessionPath)
	})
	cleanups.add(func() { _ = manager.Close() })
	sessionCache := sessions.NewCache()
	var srvErr error
	var runInstallHook func(context.Context) error
	var runRestartHook func() error
	if config.Mode == ModeStandalone {
		runInstallHook = runInstall
		runRestartHook = runRestart
	}
	srv, srvErr = server.New(server.Deps{
		AgentDir:      agentDir,
		SessionsDir:   sessionsDir,
		Hosted:        config.Mode == ModeHosted,
		WorkspaceRoot: config.WorkspaceRoot,
		ChildEnv: func() []string {
			if config.Mode != ModeHosted {
				return nil
			}
			return childEnv
		}(),
		Auth:                authMiddleware,
		ChatSender:          manager,
		Cache:               sessionCache,
		RenderExportSession: ui.RenderExportSessionPage,
		RenderAppShell:      ui.RenderAppShell,
		Models: func(ctx context.Context) (json.RawMessage, error) {
			return runtimeModels(ctx, enabledRuntimes, sessionsDir, sessionCache, server.ModelQuery{})
		},
		ModelsFor: func(ctx context.Context, query server.ModelQuery) (json.RawMessage, error) {
			return runtimeModels(ctx, enabledRuntimes, sessionsDir, sessionCache, query)
		},
		RuntimeRegistry: enabledRegistry,
		DefaultRuntime:  enabledRuntimes.defaultRuntime(),
		ClaudeHome:      claudeHome,
		Claude: func() server.ClaudeService {
			if !enabledRuntimes.enables(string(runtimes.ClaudeID)) {
				return nil
			}
			return claudeService{sessionsDir: sessionsDir}
		}(),
		Codex: func() server.CodexService {
			if !enabledRuntimes.enables(string(runtimes.CodexID)) {
				return nil
			}
			return configuredCodexService{sessionsDir: sessionsDir, command: codexArgv, process: codexProcess}
		}(),
		OpenCode: func() server.OpenCodeService {
			if !enabledRuntimes.enables(string(runtimes.OpenCodeID)) {
				return nil
			}
			return openCodeService
		}(),
		Updater:    versionChecker,
		RunInstall: runInstallHook,
		RunRestart: runRestartHook,
	})
	if srvErr != nil {
		return fmt.Errorf("failed to initialize server: %w", srvErr)
	}
	cleanups.add(srv.Shutdown)

	ui.SetThemeProvider(srv.ThemeSetting)
	ui.SetFontProvider(srv.FontStyles)
	if err := ui.SetBasePath(config.BasePath); err != nil {
		return fmt.Errorf("configure UI base path: %w", err)
	}
	basePath, err := basepath.Parse(config.BasePath)
	if err != nil {
		return fmt.Errorf("configure HTTP base path: %w", err)
	}

	mux := http.NewServeMux()
	srv.Register(mux)
	ui.RegisterPWAHandlers(mux)
	mux.HandleFunc("/styles/app.css", ui.ServeAppStyles)
	dfs := web.DistFS()
	if scripts, err := frontend.LoadScriptsAt(dfs, basePath, frontend.AppEntry); err == nil {
		for _, script := range scripts {
			if script.Entry == frontend.AppEntry {
				ui.SetAppScriptPath(script.Path)
			}
			mux.HandleFunc(script.Path, frontend.ServeJS(script.JS, true))
		}
		// Serve all other hashed assets (lazy chunks, runtime) from the embed FS.
		mux.HandleFunc("/static/assets/", frontend.ServeStaticAssets(dfs))
	} else {
		fmt.Fprintf(os.Stderr, "WARNING: failed to load Vite frontend scripts: %v (frontend JS will be unavailable)\n", err)
	}

	addr := config.ListenAddress
	url := fmt.Sprintf("http://%s%s", config.ListenAddress, basePath.String())
	var tailscaleURL string
	var tailscaleServe bool
	if !config.HostExplicit {
		tsCtx, tsCancel := context.WithTimeout(ctx, tailscaleConfigureTimeout)
		tsURL, tsOk, tsErr := configureTailscaleServe(tsCtx, port)
		tsCancel()
		if tsErr == nil && tsOk {
			tailscaleURL = tsURL + basePath.String()
			tailscaleServe = true
		} else if tsErr != nil {
			if tsCtx.Err() == context.DeadlineExceeded {
				fmt.Fprintf(os.Stderr, "Tailscale Serve timed out after %s; continuing without it\n", tailscaleConfigureTimeout)
			} else {
				fmt.Fprintf(os.Stderr, "Tailscale Serve unavailable: %v\n", tsErr)
			}
		}
	}
	fmt.Printf("pican -> %s\n", url)
	if tailscaleURL != "" {
		fmt.Printf("Tailscale HTTPS -> %s\n", tailscaleURL)
	}
	fmt.Printf("Serving from: %s\n", sessionsDir)
	if config.AuthMode == AuthModeProxy {
		fmt.Println("Auth: proxy-only")
	} else if authMiddleware.Enabled() {
		fmt.Println("Auth: enabled (set PICAN_TOKEN to require token)")
	} else {
		fmt.Printf("Auth: disabled — set %s to require a token for access.\n", tokenEnvVar)
	}

	stateFilePath, err := writeStateFile(agentDir, bindHost, port, tailscaleServe, tailscaleURL)
	if err != nil {
		return err
	}
	ownedStateFile := stateFile
	cleanups.add(func() {
		if ownedStateFile != nil {
			_ = ownedStateFile.Close()
		}
		if stateFile == ownedStateFile {
			stateFile = nil
		}
		_ = os.Remove(stateFilePath)
	})

	if config.OpenBrowser {
		go func() {
			timer := time.NewTimer(300 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
			case <-timer.C:
				openBrowser(url)
			}
		}()
	}

	if enabledRuntimes.enables(string(runtimes.PiID)) {
		warmModelsCache()
	}

	httpServer := &http.Server{
		Addr: addr,
		Handler: func() http.Handler {
			if config.AuthMode == AuthModeProxy {
				return basePath.Handler(authMiddleware.WrapHandler(mux))
			}
			return basePath.Handler(mux)
		}(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout intentionally 0 — SSE streams are long-lived.
	}

	if config.Mode == ModeStandalone {
		go versionChecker.Start(ctx)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	cleanups.add(func() { _ = listener.Close() })
	return serveUntilCanceled(ctx, httpServer, listener)
}
