package app

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"pican/internal/agentdir"
	"pican/internal/auth"
	"pican/internal/frontend"
	"pican/internal/runtimes"
	"pican/internal/server"
	"pican/internal/sessions"
	"pican/internal/ui"
	"pican/internal/updater"
	"pican/internal/workers"
	"pican/web"
)

const defaultPort = "31415"
const tokenEnvVar = "PICAN_TOKEN"

// Main runs the pican application. version is supplied by cmd/pican so
// release builds can set it with -ldflags "-X main.version=...".
func Main(version string) {
	port := flag.String("p", defaultPort, "port to listen on")
	hostOverride := flag.String("host", "", "host/IP to bind; defaults to 127.0.0.1")
	open := flag.Bool("o", false, "auto-open browser")
	insecure := flag.Bool("insecure", false, "allow non-loopback bind without "+tokenEnvVar+" (DANGEROUS)")
	showVersion := flag.Bool("version", false, "print version and exit")
	runtimeFlag := flag.String("runtime", "pi", "agent runtimes: pi, codex, both, or a comma-separated list")
	codexCommandFlag := flag.String("codex-command", "", "path to the Codex executable")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}

	codexPath := codexExecutable(*codexCommandFlag)
	codexArgv := codexCommand(codexPath)

	agentDir := agentdir.Path()
	if err := seedSoundsDir(agentDir); err != nil {
		fmt.Fprintf(os.Stderr, "failed to seed sounds directory: %v\n", err)
	}
	sessionsDir := filepath.Join(agentDir, "sessions")

	var srv *server.Server
	currentServer := func() *server.Server { return srv }
	catalog := newCatalogSyncer("Codex", codexCatalog(sessionsDir, codexArgv), 15*time.Second, time.Minute)
	registry, err := newRuntimeRegistry(
		applicationRuntime{
			registration: runtimes.Pi(runtimes.BuiltinOptions{
				Command:           "pi",
				AvailabilityProbe: func(context.Context) runtimes.Availability { return runtimes.Availability{Available: true} },
				WorkerFactory:     piWorkerFactory(currentServer),
			}),
			models: piModels,
		},
		applicationRuntime{
			registration: runtimes.Codex(runtimes.BuiltinOptions{
				Command:           codexPath,
				AvailabilityProbe: catalog.availability,
				Catalog:           catalog,
				WorkerFactory:     codexWorkerFactory(sessionsDir, codexArgv, currentServer),
			}),
			models: codexModels(codexArgv),
		},
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize runtime registry: %v\n", err)
		os.Exit(1)
	}
	enabledRuntimes, err := parseRuntime(*runtimeFlag, registry)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	enabledRegistry, err := enabledRuntimes.selectedRegistry()
	if err != nil {
		fmt.Fprintf(os.Stderr, "resolve enabled runtimes: %v\n", err)
		os.Exit(1)
	}

	if _, statErr := os.Stat(sessionsDir); os.IsNotExist(statErr) {
		if !enabledRuntimes.requiresExistingSessionsDir() {
			if mkdirErr := os.MkdirAll(sessionsDir, 0755); mkdirErr != nil {
				fmt.Fprintf(os.Stderr, "create sessions directory: %v\n", mkdirErr)
				os.Exit(1)
			}
		} else {
			fmt.Fprintf(os.Stderr, "sessions directory not found: %s\n", sessionsDir)
			os.Exit(1)
		}
	}

	var activeCatalogs []*catalogSyncer
	for _, runtimeID := range enabledRuntimes.ordered {
		registration, _ := registry.registry.Lookup(runtimeID)
		if registration.Catalog == nil {
			continue
		}
		if _, syncErr := registration.Catalog.Sync(context.Background()); syncErr != nil {
			if enabledRuntimes.only(runtimeID) {
				fmt.Fprintf(os.Stderr, "%s runtime unavailable: %v\n", registration.Descriptor.Label, syncErr)
				os.Exit(1)
			}
			fmt.Fprintf(os.Stderr, "%s unavailable; continuing with %s: %v\n", registration.Descriptor.Label, enabledRuntimes.labelsExcept(runtimeID), syncErr)
		}
		if syncer, ok := registration.Catalog.(*catalogSyncer); ok {
			syncer.start()
			activeCatalogs = append(activeCatalogs, syncer)
		}
	}

	bindHost := chooseBindHost(*hostOverride)
	token := os.Getenv(tokenEnvVar)
	tokenRequired := token == "" && !isLoopbackHost(bindHost) && !*insecure
	if tokenRequired {
		fmt.Fprintf(os.Stderr,
			"refusing to bind %s without %s set: anyone reachable on this address could view sessions and drive pi.\n"+
				"  set %s=$(openssl rand -hex 16) to require a token, or pass --insecure to override.\n",
			bindHost, tokenEnvVar, tokenEnvVar)
		os.Exit(1)
	}
	authMiddleware := auth.New(token)

	versionChecker := updater.New(version)

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
	var srvErr error
	srv, srvErr = server.New(server.Deps{
		AgentDir:            agentDir,
		SessionsDir:         sessionsDir,
		Auth:                authMiddleware,
		ChatSender:          manager,
		Cache:               sessions.NewCache(),
		RenderExportSession: ui.RenderExportSessionPage,
		RenderAppShell:      ui.RenderAppShell,
		Models: func(ctx context.Context) (json.RawMessage, error) {
			return runtimeModels(ctx, enabledRuntimes, sessionsDir, server.ModelQuery{})
		},
		ModelsFor: func(ctx context.Context, query server.ModelQuery) (json.RawMessage, error) {
			return runtimeModels(ctx, enabledRuntimes, sessionsDir, query)
		},
		RuntimeRegistry: enabledRegistry,
		DefaultRuntime:  enabledRuntimes.defaultRuntime(),
		Codex: func() server.CodexService {
			if !enabledRuntimes.enables(string(runtimes.CodexID)) {
				return nil
			}
			return codexService{sessionsDir: sessionsDir, command: codexArgv}
		}(),
		Updater:    versionChecker,
		RunInstall: runInstall,
		RunRestart: runRestart,
	})
	if srvErr != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize server: %v\n", srvErr)
		os.Exit(1)
	}

	ui.SetThemeProvider(srv.ThemeSetting)
	ui.SetFontProvider(srv.FontStyles)

	mux := http.NewServeMux()
	srv.Register(mux)
	ui.RegisterPWAHandlers(mux)
	mux.HandleFunc("/styles/app.css", ui.ServeAppStyles)
	dfs := web.DistFS()
	if scripts, err := frontend.LoadScripts(dfs, frontend.AppEntry); err == nil {
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

	addr := net.JoinHostPort(bindHost, *port)
	url := fmt.Sprintf("http://%s", net.JoinHostPort(bindHost, *port))
	var tailscaleURL string
	var tailscaleServe bool
	if *hostOverride == "" {
		tsCtx, tsCancel := context.WithTimeout(context.Background(), tailscaleConfigureTimeout)
		tsURL, tsOk, tsErr := configureTailscaleServe(tsCtx, *port)
		tsCancel()
		if tsErr == nil && tsOk {
			tailscaleURL = tsURL
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
	if authMiddleware.Enabled() {
		fmt.Println("Auth: enabled (set PICAN_TOKEN to require token)")
	} else {
		fmt.Printf("Auth: disabled — set %s to require a token for access.\n", tokenEnvVar)
	}

	stateFilePath, err := writeStateFile(agentDir, bindHost, *port, tailscaleServe, tailscaleURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
	defer func() {
		if stateFile != nil {
			_ = stateFile.Close()
		}
		_ = os.Remove(stateFilePath)
	}()

	if *open {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(url)
		}()
	}

	if enabledRuntimes.enables(string(runtimes.PiID)) {
		warmModelsCache()
	}

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout intentionally 0 — SSE streams are long-lived.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go versionChecker.Start(ctx)

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		for _, catalog := range activeCatalogs {
			catalog.close()
		}
		_ = manager.Close()
		srv.Shutdown()
	}()

	serveErr := httpServer.ListenAndServe()
	if serveErr != nil && serveErr != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "server error: %v\n", serveErr)
		os.Exit(1)
	}
}
