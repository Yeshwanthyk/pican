package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"pican/internal/workers"
)

const (
	defaultUsername           = "pican"
	defaultStartupTimeout     = 10 * time.Second
	defaultRequestTimeout     = 15 * time.Second
	defaultMinRestartBackoff  = 250 * time.Millisecond
	defaultMaxRestartBackoff  = 5 * time.Second
	defaultMaxRestartAttempts = 5
	defaultStableGeneration   = 5 * time.Second
	maxChildLogBytes          = 64 << 10
)

var (
	ErrSupervisorClosed   = errors.New("OpenCode supervisor is closed")
	ErrSupervisorNotReady = errors.New("OpenCode supervisor is not ready")
)

type Options struct {
	Command string
	// CommandArgs is a test/integration prefix inserted before "serve".
	// Production leaves it empty; argv is always executed directly.
	CommandArgs        []string
	Dir                string
	StartupTimeout     time.Duration
	RequestTimeout     time.Duration
	MinRestartBackoff  time.Duration
	MaxRestartBackoff  time.Duration
	MaxRestartAttempts int
	StableGeneration   time.Duration
	HTTPTransport      http.RoundTripper
	Reconcile          func(context.Context, *Client) error
	Event              func(Event)
	Availability       func(Availability)
}

type eventSubscription struct {
	channel chan Event
}

type availabilitySubscription struct {
	channel chan Availability
}

// Supervisor owns one authenticated loopback OpenCode server and one global
// SSE stream. Session workers subscribe to native IDs and never own processes.
type Supervisor struct {
	mu           sync.RWMutex
	options      Options
	ctx          context.Context
	cancel       context.CancelFunc
	client       *Client
	process      *exec.Cmd
	processDone  chan error
	availability Availability
	started      bool
	closed       bool
	startedAt    time.Time
	eventSubs    map[string]map[*eventSubscription]struct{}
	availSubs    map[*availabilitySubscription]struct{}
	done         chan struct{}
	logs         *workers.BoundedWriter
}

func NewSupervisor(options Options) *Supervisor {
	if options.StartupTimeout <= 0 {
		options.StartupTimeout = defaultStartupTimeout
	}
	if options.RequestTimeout <= 0 {
		options.RequestTimeout = defaultRequestTimeout
	}
	if options.MinRestartBackoff <= 0 {
		options.MinRestartBackoff = defaultMinRestartBackoff
	}
	if options.MaxRestartBackoff < options.MinRestartBackoff {
		options.MaxRestartBackoff = defaultMaxRestartBackoff
	}
	if options.MaxRestartAttempts <= 0 {
		options.MaxRestartAttempts = defaultMaxRestartAttempts
	}
	if options.StableGeneration <= 0 {
		options.StableGeneration = defaultStableGeneration
	}
	return &Supervisor{
		options:   options,
		eventSubs: make(map[string]map[*eventSubscription]struct{}),
		availSubs: make(map[*availabilitySubscription]struct{}),
		done:      make(chan struct{}),
		logs:      &workers.BoundedWriter{Max: maxChildLogBytes},
	}
}

// Start blocks until the first health check and recovery reconciliation have
// succeeded, or until the bounded initial restart budget is exhausted.
func (s *Supervisor) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrSupervisorClosed
	}
	if s.started {
		available := s.availability
		s.mu.Unlock()
		if available.Available {
			return nil
		}
		if available.Err != nil {
			return available.Err
		}
		return ErrSupervisorNotReady
	}
	if strings.TrimSpace(s.options.Command) == "" {
		s.mu.Unlock()
		return errors.New("OpenCode executable is required")
	}
	s.started = true
	s.ctx, s.cancel = context.WithCancel(context.Background())
	initial := make(chan error, 1)
	s.mu.Unlock()

	go s.run(initial)
	select {
	case err := <-initial:
		return err
	case <-ctx.Done():
		_ = s.Close()
		return ctx.Err()
	}
}

func (s *Supervisor) Client() (*Client, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return nil, ErrSupervisorClosed
	}
	if !s.availability.Available || s.client == nil {
		if s.availability.Err != nil {
			return nil, fmt.Errorf("%w: %v", ErrSupervisorNotReady, s.availability.Err)
		}
		return nil, ErrSupervisorNotReady
	}
	return s.client, nil
}

func (s *Supervisor) Ready() Availability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.availability
}

func (s *Supervisor) PID() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.process == nil || s.process.Process == nil {
		return 0
	}
	return s.process.Process.Pid
}

func (s *Supervisor) StartedAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.startedAt
}

func (s *Supervisor) Logs() string {
	return s.logs.String()
}

// Subscribe returns a bounded, nonblocking native-session event stream.
// Global events are available by subscribing to an empty session ID.
func (s *Supervisor) Subscribe(sessionID string) (<-chan Event, func()) {
	subscription := &eventSubscription{channel: make(chan Event, 256)}
	s.mu.Lock()
	if s.closed {
		close(subscription.channel)
		s.mu.Unlock()
		return subscription.channel, func() {}
	}
	if s.eventSubs[sessionID] == nil {
		s.eventSubs[sessionID] = make(map[*eventSubscription]struct{})
	}
	s.eventSubs[sessionID][subscription] = struct{}{}
	s.mu.Unlock()
	var once sync.Once
	return subscription.channel, func() {
		once.Do(func() {
			s.mu.Lock()
			if subscribers := s.eventSubs[sessionID]; subscribers != nil {
				delete(subscribers, subscription)
				if len(subscribers) == 0 {
					delete(s.eventSubs, sessionID)
				}
			}
			s.mu.Unlock()
		})
	}
}

func (s *Supervisor) SubscribeAvailability() (<-chan Availability, func()) {
	subscription := &availabilitySubscription{channel: make(chan Availability, 4)}
	s.mu.Lock()
	if s.closed {
		close(subscription.channel)
		s.mu.Unlock()
		return subscription.channel, func() {}
	}
	s.availSubs[subscription] = struct{}{}
	current := s.availability
	s.mu.Unlock()
	subscription.channel <- current
	var once sync.Once
	return subscription.channel, func() {
		once.Do(func() {
			s.mu.Lock()
			delete(s.availSubs, subscription)
			s.mu.Unlock()
		})
	}
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	process := s.process
	started := s.started
	s.mu.Unlock()
	if process != nil {
		_ = killOpenCodeCommand(process)
	}
	if started {
		<-s.done
	} else {
		close(s.done)
	}
	s.mu.Lock()
	s.process = nil
	s.processDone = nil
	s.client = nil
	s.availability = Availability{Err: ErrSupervisorClosed, ChangedAt: time.Now()}
	for _, subscribers := range s.eventSubs {
		for subscription := range subscribers {
			close(subscription.channel)
		}
	}
	for subscription := range s.availSubs {
		close(subscription.channel)
	}
	s.eventSubs = nil
	s.availSubs = nil
	s.mu.Unlock()
	return nil
}

func (s *Supervisor) run(initial chan<- error) {
	defer close(s.done)
	backoff := s.options.MinRestartBackoff
	failures := 0
	initialSent := false
	for {
		if s.ctx.Err() != nil {
			if !initialSent {
				initial <- s.ctx.Err()
			}
			return
		}
		client, health, processDone, streamDone, err := s.launch()
		if err != nil {
			s.mu.Lock()
			s.client = nil
			s.process = nil
			s.processDone = nil
			s.mu.Unlock()
			failures++
			s.publishAvailability(Availability{Err: err, ChangedAt: time.Now()})
			if failures >= s.options.MaxRestartAttempts {
				if !initialSent {
					initial <- err
				}
				return
			}
			if !waitContext(s.ctx, backoff) {
				if !initialSent {
					initial <- s.ctx.Err()
				}
				return
			}
			backoff = min(backoff*2, s.options.MaxRestartBackoff)
			continue
		}

		s.mu.Lock()
		s.client = client
		s.mu.Unlock()
		s.publishAvailability(Availability{Available: true, Version: health.Version, ChangedAt: time.Now()})
		if !initialSent {
			initial <- nil
			initialSent = true
		}

		stableTimer := time.NewTimer(s.options.StableGeneration)
		stable := false
		var failure error
	waitGeneration:
		for {
			select {
			case processErr := <-processDone:
				if processErr == nil {
					failure = errors.New("OpenCode server exited")
				} else {
					failure = fmt.Errorf("OpenCode server exited: %w", processErr)
				}
				break waitGeneration
			case streamErr := <-streamDone:
				if s.ctx.Err() == nil {
					if streamErr == nil {
						streamErr = io.ErrUnexpectedEOF
					}
					failure = fmt.Errorf("OpenCode event stream failed: %w", streamErr)
					s.mu.RLock()
					process := s.process
					s.mu.RUnlock()
					_ = killOpenCodeCommand(process)
					<-processDone
				}
				break waitGeneration
			case <-stableTimer.C:
				stable = true
				failures = 0
				backoff = s.options.MinRestartBackoff
				// A stable child keeps running; only the consecutive-failure
				// accounting changes at this boundary.
			case <-s.ctx.Done():
				s.mu.RLock()
				process := s.process
				s.mu.RUnlock()
				_ = killOpenCodeCommand(process)
				<-processDone
				s.mu.Lock()
				s.client = nil
				s.process = nil
				s.processDone = nil
				s.mu.Unlock()
				stableTimer.Stop()
				return
			}
		}
		stableTimer.Stop()
		s.mu.Lock()
		s.client = nil
		s.process = nil
		s.processDone = nil
		s.mu.Unlock()
		if s.ctx.Err() != nil {
			return
		}
		if !stable {
			failures++
			if failures >= s.options.MaxRestartAttempts {
				s.publishAvailability(Availability{Err: fmt.Errorf("OpenCode recovery stopped after %d unstable generations: %w", failures, failure), ChangedAt: time.Now()})
				return
			}
		}
		s.publishAvailability(Availability{Err: failure, ChangedAt: time.Now()})
		if !waitContext(s.ctx, backoff) {
			return
		}
		backoff = min(backoff*2, s.options.MaxRestartBackoff)
	}
}

func (s *Supervisor) launch() (*Client, Health, <-chan error, <-chan error, error) {
	port, err := availableLoopbackPort()
	if err != nil {
		return nil, Health{}, nil, nil, err
	}
	passwordBytes := make([]byte, 32)
	if _, err := rand.Read(passwordBytes); err != nil {
		return nil, Health{}, nil, nil, fmt.Errorf("generate OpenCode password: %w", err)
	}
	password := hex.EncodeToString(passwordBytes)
	args := append([]string(nil), s.options.CommandArgs...)
	args = append(args,
		"serve",
		"--hostname", "127.0.0.1",
		"--port", fmt.Sprintf("%d", port),
		"--print-logs",
		"--log-level", "INFO",
	)
	command := exec.Command(s.options.Command, args...)
	configureOpenCodeCommand(command)
	command.Dir = s.options.Dir
	command.Env = childEnvironment(defaultUsername, password)
	command.Stdout = s.logs
	command.Stderr = s.logs
	if err := command.Start(); err != nil {
		return nil, Health{}, nil, nil, fmt.Errorf("start OpenCode server: %w", err)
	}
	// Publish the immutable completion result twice. Readiness and teardown can
	// race to observe the same child exit; neither is allowed to consume the
	// only signal and deadlock the other.
	processDone := make(chan error, 2)
	go func() {
		result := command.Wait()
		processDone <- result
		processDone <- result
	}()
	s.mu.Lock()
	s.process = command
	s.processDone = processDone
	s.startedAt = time.Now()
	s.mu.Unlock()

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	client, err := NewClient(baseURL, defaultUsername, password, s.options.HTTPTransport, s.options.RequestTimeout)
	if err != nil {
		_ = killOpenCodeCommand(command)
		<-processDone
		return nil, Health{}, nil, nil, err
	}
	startupCtx, cancel := context.WithTimeout(s.ctx, s.options.StartupTimeout)
	defer cancel()
	health, processExited, err := awaitHealth(startupCtx, client, processDone)
	if err != nil {
		if !processExited {
			_ = killOpenCodeCommand(command)
			<-processDone
		}
		return nil, Health{}, nil, nil, fmt.Errorf("%w%s", err, s.logSuffix())
	}
	streamReady := make(chan struct{})
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- client.streamEvents(s.ctx, func() { close(streamReady) }, s.dispatch)
	}()
	select {
	case <-streamReady:
	case streamErr := <-streamDone:
		_ = killOpenCodeCommand(command)
		<-processDone
		return nil, Health{}, nil, nil, fmt.Errorf("connect OpenCode event stream: %w", streamErr)
	case processErr := <-processDone:
		return nil, Health{}, nil, nil, fmt.Errorf("OpenCode server exited before event stream readiness: %w", processErr)
	case <-startupCtx.Done():
		_ = killOpenCodeCommand(command)
		<-processDone
		return nil, Health{}, nil, nil, fmt.Errorf("OpenCode event stream readiness: %w", startupCtx.Err())
	}
	if s.options.Reconcile != nil {
		if err := s.options.Reconcile(startupCtx, client); err != nil {
			_ = killOpenCodeCommand(command)
			<-processDone
			return nil, Health{}, nil, nil, fmt.Errorf("reconcile OpenCode after start: %w", err)
		}
	}
	// Reconciliation may be slow. Do not briefly publish a generation whose
	// process or mutation stream died while native state was being read.
	select {
	case streamErr := <-streamDone:
		if streamErr == nil {
			streamErr = io.ErrUnexpectedEOF
		}
		_ = killOpenCodeCommand(command)
		<-processDone
		return nil, Health{}, nil, nil, fmt.Errorf("OpenCode event stream failed during reconciliation: %w", streamErr)
	case processErr := <-processDone:
		if processErr == nil {
			processErr = errors.New("server exited")
		}
		return nil, Health{}, nil, nil, fmt.Errorf("OpenCode server exited during reconciliation: %w", processErr)
	default:
	}
	return client, health, processDone, streamDone, nil
}

func (s *Supervisor) dispatch(event Event) {
	if s.options.Event != nil {
		s.options.Event(event)
	}
	sessionID := event.SessionID()
	s.mu.RLock()
	if sessionID != "" {
		for subscription := range s.eventSubs[sessionID] {
			select {
			case subscription.channel <- event:
			default:
			}
		}
	}
	for subscription := range s.eventSubs[""] {
		select {
		case subscription.channel <- event:
		default:
			// Native state is authoritative; consumers converge through refresh
			// rather than blocking or cross-delivering the shared SSE reader.
		}
	}
	s.mu.RUnlock()
}

func (s *Supervisor) publishAvailability(availability Availability) {
	s.mu.Lock()
	s.availability = availability
	for subscription := range s.availSubs {
		select {
		case subscription.channel <- availability:
		default:
			select {
			case <-subscription.channel:
			default:
			}
			select {
			case subscription.channel <- availability:
			default:
			}
		}
	}
	s.mu.Unlock()
	if s.options.Availability != nil {
		s.options.Availability(availability)
	}
}

func (s *Supervisor) logSuffix() string {
	logs := strings.TrimSpace(s.logs.String())
	if logs == "" {
		return ""
	}
	return ": " + logs
}

func awaitHealth(ctx context.Context, client *Client, processDone <-chan error) (Health, bool, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		health, err := client.Health(ctx)
		if err == nil && health.Healthy && strings.TrimSpace(health.Version) != "" {
			return health, false, nil
		}
		select {
		case processErr := <-processDone:
			if processErr == nil {
				return Health{}, true, errors.New("OpenCode server exited before readiness")
			}
			return Health{}, true, fmt.Errorf("OpenCode server exited before readiness: %w", processErr)
		case <-ticker.C:
		case <-ctx.Done():
			return Health{}, false, fmt.Errorf("OpenCode readiness: %w", ctx.Err())
		}
	}
}

func availableLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("reserve OpenCode loopback port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, fmt.Errorf("release OpenCode loopback port: %w", err)
	}
	return port, nil
}

func childEnvironment(username, password string) []string {
	environment := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "OPENCODE_SERVER_USERNAME=") ||
			strings.HasPrefix(entry, "OPENCODE_SERVER_PASSWORD=") {
			continue
		}
		environment = append(environment, entry)
	}
	return append(
		environment,
		"OPENCODE_SERVER_USERNAME="+username,
		"OPENCODE_SERVER_PASSWORD="+password,
	)
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
